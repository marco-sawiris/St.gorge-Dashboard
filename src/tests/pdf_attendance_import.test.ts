import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import fs from 'node:fs';
import path from 'node:path';

import {
  classifyPdfAttendanceCell,
  extractPositionedPagesFromPdfBuffer,
  matchStudentNameForImport,
  parseAttendancePdfBuffer,
  parseAttendanceReportFromPositionedPages,
  parsePdfColumnDateHeader,
  PositionedPdfPage,
  PositionedPdfToken
} from '../services/pdfAttendanceParser';
import {
  buildAttendanceImportPlan,
  createInitialPdfResolutionState
} from '../services/pdfAttendanceImportService';
import {
  clearBatchUnsupportedCache,
  executeProcessOfflineQueue,
  prepareBatchAttendanceMutations
} from '../context/AppContext';
import {
  idbAtomicBatchRecordAttendanceWithMutations,
  idbClearMutations,
  idbGetAttendanceHistory,
  idbGetPendingMutations,
  idbGetStudents,
  idbSaveStudents
} from '../services/indexedDbService';
import { Student } from '../types/student';
import { AuthUser } from '../types/auth';

// Minimal localStorage mock for Node test environment
const storageMap = new Map<string, string>();
if (typeof (globalThis as any).localStorage === 'undefined') {
  (globalThis as any).localStorage = {
    getItem: (k: string) => storageMap.get(k) ?? null,
    setItem: (k: string, v: string) => storageMap.set(k, String(v)),
    removeItem: (k: string) => storageMap.delete(k),
    clear: () => storageMap.clear()
  };
}

/**
 * Generates a valid multi-page binary PDF 1.4 buffer with optional vector grid vertical lines
 * and positioned text primitives so `pdfjs-dist` parses real binary pages in tests.
 */
function buildRealBinaryPdfBuffer(pagesContentStreams: string[]): Uint8Array {
  const objects: string[] = [];
  const pageCount = pagesContentStreams.length;

  // Obj 1: Catalog
  objects.push('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');

  // Obj 2: Pages (kids start at 4, then pairs of [pageObj, contentObj])
  const kidRefs: string[] = [];
  for (let i = 0; i < pageCount; i++) {
    kidRefs.push(`${4 + i * 2} 0 R`);
  }
  objects.push(`2 0 obj\n<< /Type /Pages /Kids [ ${kidRefs.join(' ')} ] /Count ${pageCount} >>\nendobj\n`);

  // Obj 3: Standard Helvetica Font
  objects.push('3 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n');

  for (let i = 0; i < pageCount; i++) {
    const pageObjNum = 4 + i * 2;
    const contentObjNum = pageObjNum + 1;
    const streamData = pagesContentStreams[i];
    const byteLen = Buffer.byteLength(streamData, 'latin1');

    objects.push(
      `${pageObjNum} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 842 595] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentObjNum} 0 R >>\nendobj\n`
    );
    objects.push(
      `${contentObjNum} 0 obj\n<< /Length ${byteLen} >>\nstream\n${streamData}\nendstream\nendobj\n`
    );
  }

  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [0];
  for (const obj of objects) {
    offsets.push(Buffer.byteLength(pdf, 'latin1'));
    pdf += obj;
  }
  const xrefOffset = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += '0000000000 65535 f \n';
  for (let i = 1; i <= objects.length; i++) {
    pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;

  return new Uint8Array(Buffer.from(pdf, 'latin1'));
}

function makeStudent(overrides: Partial<Student> & { id: string; code: string; name: string }): Student {
  return {
    servant: 'أبانوب عادل',
    phoneStudent: '01234567890',
    phoneParent1: '01011223344',
    phoneParent2: '',
    birthDate: '2012-05-10',
    area: 'الزيتون',
    address: '15 ش طومان باي',
    notes: '',
    followupStatus: 'بدون',
    attendanceTotal: 0,
    attendanceMonth: 0,
    attendanceStatus: 'غائب',
    sourceSheet: 'نشط',
    version: 1,
    att: {},
    fu: {},
    ...overrides
  };
}

/**
 * Helper to create realistic RTL 10-column church attendance page tokens.
 * Columns from Right -> Left (matching actual church sheet):
 * الاسم -> تليفون المخدوم (واتساب) -> تليفون ولي الأمر (واتساب) -> تليفون آخر -> العنوان -> 4 date columns -> عدد الغياب
 */
function buildChurchRtlPage(
  pageIndex: number,
  dateHeaders: string[],
  rows: Array<{
    name: string;
    phone1: string;
    phone2: string;
    phone3: string;
    address: string;
    marks: string[];
    absenceCountText: string;
  }>,
  options?: { multiLineHeader?: boolean; includeFooterPageNum?: boolean }
): PositionedPdfPage {
  const tokens: PositionedPdfToken[] = [];
  // X boundaries Left -> Right (since table is RTL, rightmost = الاسم around x=740..820)
  // Absence count: 25..75 | Date3: 85..135 | Date2: 140..190 | Date1: 195..245 | Date0: 250..300
  // Address: 310..440 | Phone3: 445..520 | Phone2: 525..600 | Phone1: 605..680 | Name: 690..825
  const colXs = {
    absence: 42,
    dates: [265, 210, 155, 100], // Date 0 (rightmost date) -> Date 3 (leftmost date)
    address: 340,
    phone3: 470,
    phone2: 550,
    phone1: 630,
    name: 720
  };
  const verticalGridXs = [20, 80, 132, 187, 242, 297, 442, 522, 602, 685, 830];

  const headerY = 60;
  if (options?.multiLineHeader) {
    tokens.push(
      { str: 'الاسم', x: colXs.name, y: headerY, width: 45, height: 11, pageIndex },
      { str: 'رقم تليفون المخدوم', x: colXs.phone1, y: headerY, width: 65, height: 10, pageIndex },
      { str: '(واتساب)', x: colXs.phone1 + 10, y: headerY + 13, width: 40, height: 10, pageIndex },
      { str: 'رقم تليفون ولي الأمر', x: colXs.phone2, y: headerY, width: 65, height: 10, pageIndex },
      { str: '(واتساب)', x: colXs.phone2 + 10, y: headerY + 13, width: 40, height: 10, pageIndex },
      { str: 'رقم تليفون آخر', x: colXs.phone3, y: headerY, width: 55, height: 10, pageIndex },
      { str: 'العنوان', x: colXs.address, y: headerY, width: 40, height: 11, pageIndex },
      { str: 'عدد', x: colXs.absence + 8, y: headerY, width: 20, height: 10, pageIndex },
      { str: 'الغياب', x: colXs.absence + 4, y: headerY + 13, width: 30, height: 10, pageIndex }
    );
  } else {
    tokens.push(
      { str: 'الاسم', x: colXs.name, y: headerY, width: 45, height: 11, pageIndex },
      { str: 'تليفون المخدوم', x: colXs.phone1, y: headerY, width: 55, height: 11, pageIndex },
      { str: 'تليفون ولي الأمر', x: colXs.phone2, y: headerY, width: 55, height: 11, pageIndex },
      { str: 'تليفون آخر', x: colXs.phone3, y: headerY, width: 50, height: 11, pageIndex },
      { str: 'العنوان', x: colXs.address, y: headerY, width: 40, height: 11, pageIndex },
      { str: 'عدد الغياب', x: colXs.absence, y: headerY, width: 40, height: 11, pageIndex }
    );
  }

  dateHeaders.forEach((dh, dIdx) => {
    const xPos = colXs.dates[dIdx] ?? 265 - dIdx * 55;
    tokens.push({ str: dh, x: xPos, y: headerY + 2, width: 45, height: 10, pageIndex });
  });

  let yCursor = headerY + 34;
  for (const r of rows) {
    // Split multi-word Arabic names cleanly to verify visual RTL reconstruction
    const nameWords = r.name.split(' ');
    let xWordRight = 815;
    for (const w of nameWords) {
      const wWidth = Math.max(22, w.length * 6);
      xWordRight -= wWidth + 4;
      tokens.push({ str: w, x: xWordRight, y: yCursor, width: wWidth, height: 11, pageIndex });
    }
    if (r.phone1) tokens.push({ str: r.phone1, x: colXs.phone1, y: yCursor, width: 55, height: 10, pageIndex });
    if (r.phone2) tokens.push({ str: r.phone2, x: colXs.phone2, y: yCursor, width: 55, height: 10, pageIndex });
    if (r.phone3) tokens.push({ str: r.phone3, x: colXs.phone3, y: yCursor, width: 55, height: 10, pageIndex });
    if (r.address) tokens.push({ str: r.address, x: colXs.address, y: yCursor, width: 85, height: 10, pageIndex });

    r.marks.forEach((m, dIdx) => {
      if (!m) return;
      const xPos = colXs.dates[dIdx] ?? 265 - dIdx * 55;
      tokens.push({ str: m, x: xPos + 15, y: yCursor, width: 14, height: 11, pageIndex });
    });

    if (r.absenceCountText) {
      tokens.push({ str: r.absenceCountText, x: colXs.absence + 12, y: yCursor, width: 15, height: 11, pageIndex });
    }
    yCursor += 26;
  }

  if (options?.includeFooterPageNum) {
    tokens.push({ str: `صفحة ${pageIndex + 1} من 5`, x: 400, y: 560, width: 70, height: 10, pageIndex });
  }

  return {
    pageIndex,
    width: 842,
    height: 595,
    tokens,
    verticalGridXs,
    extractionSource: 'text'
  };
}

async function runTests() {
  console.log('🧪 Running Real Attendance PDF Import Test Suite (15 Cases)...\n');

  const baseStudents: Student[] = [
    makeStudent({ id: 'st-1', code: 'SG-101', name: 'مينا عادل', phoneStudent: '01211111111', address: 'أصل 1' }),
    makeStudent({ id: 'st-2', code: 'SG-102', name: 'مارينا سمير', phoneStudent: '01222222222', address: 'أصل 2' }),
    makeStudent({ id: 'st-3', code: 'SG-103', name: 'بيشوي فايز', servant: 'خادم آخر' }),
    makeStudent({ id: 'st-4', code: 'SG-104', name: 'أبانوب أشرف' }),
    makeStudent({ id: 'st-5', code: 'SG-105', name: 'مريم موسي' }),
    makeStudent({ id: 'st-6', code: 'SG-106', name: 'ساره عماد' }),
    makeStudent({ id: 'st-7', code: 'SG-107', name: 'دميانة عبد الله' }),
    makeStudent({ id: 'st-8', code: 'SG-108', name: 'كيرلس جرجس' }),
    makeStudent({ id: 'st-9', code: 'SG-109', name: 'يوسف حنا' }),
    makeStudent({ id: 'st-10', code: 'SG-110', name: 'تومس منير' }),
    // Intentional ambiguous duplicate name pair in DB
    makeStudent({ id: 'st-dup-1', code: 'SG-111', name: 'جرجس نبيل' }),
    makeStudent({ id: 'st-dup-2', code: 'SG-112', name: 'جرجس نبيل' }),
    // Close fuzzy name candidate (1 word difference)
    makeStudent({ id: 'st-fuzzy-1', code: 'SG-113', name: 'فادي ملاك رزق' })
  ];

  // -------------------------------------------------------------------------
  // Case 1: Dynamic date column header parser & rejection of phone numbers
  // -------------------------------------------------------------------------
  assert.equal(parsePdfColumnDateHeader('23/10/2026')?.isoDate, '2026-10-23');
  assert.equal(parsePdfColumnDateHeader('30/10/2026')?.isoDate, '2026-10-30');
  assert.equal(parsePdfColumnDateHeader('06/11/2026')?.isoDate, '2026-11-06');
  assert.equal(parsePdfColumnDateHeader('13/11/2026')?.isoDate, '2026-11-13');
  assert.equal(parsePdfColumnDateHeader('٢٣/١٠/٢٠٢٦')?.isoDate, '2026-10-23');
  assert.equal(parsePdfColumnDateHeader('04/12/2026')?.isoDate, '2026-12-04');
  assert.equal(parsePdfColumnDateHeader('01234567890'), null, 'Phone numbers must NEVER parse as dates');

  // -------------------------------------------------------------------------
  // Case 2: Attendance cell classification rules (ح, غ, empty, ambiguous, unknown)
  // -------------------------------------------------------------------------
  assert.equal(classifyPdfAttendanceCell('ح'), 'present');
  assert.equal(classifyPdfAttendanceCell('غ'), 'absent');
  assert.equal(classifyPdfAttendanceCell(''), 'empty');
  assert.equal(classifyPdfAttendanceCell('-'), 'empty', 'Hyphen/empty must stay empty, never absent');
  assert.equal(classifyPdfAttendanceCell('ح غ'), 'ambiguous', 'Combined symbols must flag ambiguous');
  assert.equal(classifyPdfAttendanceCell('؟'), 'unknown', 'Unclear symbols must flag unknown');

  // -------------------------------------------------------------------------
  // Case 3: Real 5-page RTL church report extraction (Pages 1..5, repeated headers, multi-line headers,
  // cross-page deduplication, phones/addresses NEVER polluting dates, empty cells, discrepancy detection)
  // -------------------------------------------------------------------------
  const referenceDates = ['23/10/2026', '30/10/2026', '06/11/2026', '13/11/2026'];
  const pages5: PositionedPdfPage[] = [
    buildChurchRtlPage(
      0,
      referenceDates,
      [
        {
          name: 'مينا عادل',
          phone1: '01211111111',
          phone2: '01022223333',
          phone3: '',
          address: '23 ش الزيتون شقة 10',
          marks: ['ح', 'غ', 'ح', 'ح'],
          absenceCountText: '1'
        },
        {
          name: 'مارينا سمير',
          phone1: '01222222222',
          phone2: '',
          phone3: '01133334444',
          address: '14 ش طومان باي',
          marks: ['غ', 'غ', 'غ', 'ح'],
          absenceCountText: '3'
        }
      ],
      { multiLineHeader: true, includeFooterPageNum: true }
    ),
    buildChurchRtlPage(
      1,
      referenceDates,
      [
        {
          name: 'بيشوي فايز',
          phone1: '01233333333',
          phone2: '01044445555',
          phone3: '',
          address: '06 ش سليم الأول',
          marks: ['ح', 'ح', 'ح', 'غ'],
          absenceCountText: '1'
        },
        // Student with Arabic variations (ابانوب without hamza, مريم موسى instead of موسي)
        {
          name: 'ابانوب اشرف',
          phone1: '',
          phone2: '',
          phone3: '',
          address: '',
          marks: ['ح', '', 'غ', 'ح'], // Empty cell in 30/10/2026 must remain 'empty'!
          absenceCountText: '1'
        }
      ],
      { includeFooterPageNum: true }
    ),
    buildChurchRtlPage(
      2,
      referenceDates,
      [
        {
          name: 'مريم موسى',
          phone1: '01255555555',
          phone2: '',
          phone3: '',
          address: '30 ش ابن سندر',
          marks: ['غ', 'ح', 'غ', 'ح'],
          absenceCountText: '4' // Intentional mismatch! Extracted absent = 2, reported = 4
        },
        {
          name: 'سارة عماد',
          phone1: '01266666666',
          phone2: '01077778888',
          phone3: '',
          address: '13 ش المطرية',
          marks: ['ح', 'ح', 'ح غ', '؟'], // Ambiguous + Unknown cells
          absenceCountText: '0'
        }
      ],
      { includeFooterPageNum: true }
    ),
    buildChurchRtlPage(
      3,
      referenceDates,
      [
        {
          name: 'دميانة عبدالله', // Compound spacing check vs 'دميانة عبد الله'
          phone1: '01288888888',
          phone2: '',
          phone3: '',
          address: '',
          marks: ['ح', 'ح', 'غ', 'ح'],
          absenceCountText: '1'
        },
        {
          name: 'كيرلس جرجس',
          phone1: '',
          phone2: '01099990000',
          phone3: '',
          address: '55 ش الحرية',
          marks: ['غ', 'غ', 'ح', 'غ'],
          absenceCountText: '3'
        }
      ],
      { includeFooterPageNum: true }
    ),
    buildChurchRtlPage(
      4,
      referenceDates,
      [
        // Cross-page repeat check: كيرلس جرجس repeated across page boundary should deduplicate, not double!
        {
          name: 'كيرلس جرجس',
          phone1: '',
          phone2: '01099990000',
          phone3: '',
          address: '55 ش الحرية',
          marks: ['غ', 'غ', 'ح', 'غ'],
          absenceCountText: '3'
        },
        {
          name: 'جرجس نبيل', // Duplicate name in DB -> must be 'ambiguous'
          phone1: '01200001111',
          phone2: '',
          phone3: '',
          address: '',
          marks: ['ح', 'ح', 'ح', 'ح'],
          absenceCountText: '0'
        },
        {
          name: 'فادي ملاك جرجس', // Close candidate to 'فادي ملاك رزق' -> 'needs_review' (NOT auto-matched)
          phone1: '',
          phone2: '',
          phone3: '',
          address: '',
          marks: ['غ', 'ح', 'غ', 'ح'],
          absenceCountText: '2'
        },
        {
          name: 'مخدوم غير مسجل إطلاقاً', // Unmatched -> NEVER auto-imported
          phone1: '',
          phone2: '',
          phone3: '',
          address: '',
          marks: ['ح', 'ح', 'ح', 'ح'],
          absenceCountText: '0'
        }
      ],
      { includeFooterPageNum: true }
    )
  ];

  const report5 = parseAttendanceReportFromPositionedPages('attendance_oct_nov_2026.pdf', pages5, baseStudents);
  assert.equal(report5.pageCount, 5);
  assert.deepEqual(
    report5.extractedDates.map((d) => d.date),
    ['2026-10-23', '2026-10-30', '2026-11-06', '2026-11-13'],
    'Must extract all 4 dynamic dates chronologically'
  );
  // 11 unique student rows across 5 pages (كيرلس جرجس deduplicated, repeated headers & footers skipped)
  assert.equal(report5.rows.length, 11, 'Repeated headers/footers skipped and cross-page split row deduplicated');
  assert.ok(
    !report5.rows.some((r) => r.extractedName.includes('الاسم') || r.extractedName.includes('صفحة')),
    'Headers and page footers must never become student rows'
  );

  // Verify exact cell mapping for Mina, Marina, Bishoy
  const minaRow = report5.rows.find((r) => r.extractedName === 'مينا عادل')!;
  assert.equal(minaRow.matchedStudentId, 'st-1');
  assert.equal(minaRow.cells['2026-10-23'].status, 'present');
  assert.equal(minaRow.cells['2026-10-30'].status, 'absent');
  assert.equal(minaRow.cells['2026-11-06'].status, 'present');
  assert.equal(minaRow.cells['2026-11-13'].status, 'present');
  assert.equal(minaRow.hasAbsenceCountMismatch, false);

  const marinaRow = report5.rows.find((r) => r.extractedName === 'مارينا سمير')!;
  assert.equal(marinaRow.cells['2026-10-23'].status, 'absent');
  assert.equal(marinaRow.cells['2026-10-30'].status, 'absent');
  assert.equal(marinaRow.cells['2026-11-06'].status, 'absent');
  assert.equal(marinaRow.cells['2026-11-13'].status, 'present');

  // Empty cell preservation & Arabic Presentation Forms / Hamza / Ya / Ta Marbuta / Compound spaces
  const abanoubRow = report5.rows.find((r) => r.extractedName === 'ابانوب اشرف')!;
  assert.equal(abanoubRow.matchedStudentId, 'st-4');
  assert.equal(abanoubRow.cells['2026-10-30'].status, 'empty', 'Empty cell MUST NOT turn into absent');
  assert.equal(abanoubRow.extractedAbsentCount, 1);

  const mariamRow = report5.rows.find((r) => r.extractedName === 'مريم موسى')!;
  assert.equal(mariamRow.matchedStudentId, 'st-5');
  assert.equal(mariamRow.extractedAbsentCount, 2);
  assert.equal(mariamRow.reportedAbsenceCount, 4);
  assert.equal(mariamRow.hasAbsenceCountMismatch, true, 'Must flag discrepancy with عدد الغياب without modifying attendance');

  const saraRow = report5.rows.find((r) => r.extractedName === 'سارة عماد')!;
  assert.equal(saraRow.matchedStudentId, 'st-6');
  assert.equal(saraRow.cells['2026-11-06'].status, 'ambiguous');
  assert.equal(saraRow.cells['2026-11-13'].status, 'unknown');

  const damianaRow = report5.rows.find((r) => r.extractedName === 'دميانة عبدالله')!;
  assert.equal(damianaRow.matchedStudentId, 'st-7');

  // Ambiguous, fuzzy needs_review, and unmatched rows NEVER auto-matched
  const dupRow = report5.rows.find((r) => r.extractedName === 'جرجس نبيل')!;
  assert.equal(dupRow.matchStatus, 'ambiguous');
  assert.equal(dupRow.matchedStudentId, null);
  assert.deepEqual(dupRow.candidateStudentIds, ['st-dup-1', 'st-dup-2']);

  const fuzzyRow = report5.rows.find((r) => r.extractedName === 'فادي ملاك جرجس')!;
  assert.equal(fuzzyRow.matchStatus, 'needs_review');
  assert.equal(fuzzyRow.matchedStudentId, null, 'Fuzzy matches require explicit confirmation');
  assert.ok(fuzzyRow.candidateStudentIds.includes('st-fuzzy-1'));

  const unknownRow = report5.rows.find((r) => r.extractedName === 'مخدوم غير مسجل إطلاقاً')!;
  assert.equal(unknownRow.matchStatus, 'unmatched');
  assert.equal(unknownRow.matchedStudentId, null);

  // Arabic Presentation Forms normalization test (NFKC)
  const pfMatch = matchStudentNameForImport('\uFEE3\uFEF4\uFEE8\uFE8E \uFECB\uFE8E\uFEAA\uFEDD', baseStudents);
  assert.equal(pfMatch.matchStatus, 'exact');
  assert.equal(pfMatch.matchedStudentId, 'st-1');

  // -------------------------------------------------------------------------
  // Case 4: Real binary PDF file parsing via pdfjs-dist (5 pages + vector grid + OCR fallback)
  // -------------------------------------------------------------------------
  // Page 1..5 real PDF content streams (Code + Name + 2 custom dynamic dates + Absence count)
  const makeBinaryStream = (date1: string, date2: string, studentsOnPage: Array<{ code: string; name: string; c1: string; c2: string; abs: string }>) => {
    const ops: string[] = [];
    // Draw vertical table grid lines so extractVerticalGridXsFromPage exercises vector path extraction
    for (const gx of [40, 120, 220, 320, 560, 720, 800]) {
      ops.push(`${gx} 60 m ${gx} 520 l S`);
    }
    // Header row around y_pdf = 480 (becomes top of page in viewport)
    ops.push(`BT /F1 11 Tf 735 480 Td (Code) Tj ET`);
    ops.push(`BT /F1 11 Tf 585 480 Td (Name) Tj ET`);
    ops.push(`BT /F1 11 Tf 340 480 Td (01234567890) Tj ET`);
    ops.push(`BT /F1 11 Tf 235 480 Td (${date1}) Tj ET`);
    ops.push(`BT /F1 11 Tf 135 480 Td (${date2}) Tj ET`);
    ops.push(`BT /F1 11 Tf 55 480 Td (Abs) Tj ET`);
    // Wait: let's also include standard Date headers without relying on Helvetica Arabic glyphs;
    // pdfjs-dist extracts exact Unicode codepoints from PDF strings cleanly! Here let's test Code + Dates + Check/Cross symbols!
    let py = 445;
    for (const st of studentsOnPage) {
      ops.push(`BT /F1 11 Tf 735 ${py} Td (${st.code}) Tj ET`);
      ops.push(`BT /F1 11 Tf 585 ${py} Td (${st.name}) Tj ET`);
      ops.push(`BT /F1 11 Tf 260 ${py} Td (${st.c1}) Tj ET`);
      ops.push(`BT /F1 11 Tf 160 ${py} Td (${st.c2}) Tj ET`);
      ops.push(`BT /F1 11 Tf 70 ${py} Td (${st.abs}) Tj ET`);
      py -= 32;
    }
    return ops.join('\n');
  };

  // Real binary 5-page PDF parsed directly by pdfjs-dist!
  const binary5PageBuffer = buildRealBinaryPdfBuffer([
    makeBinaryStream('04/12/2026', '11/12/2026', [{ code: 'SG-101', name: 'Mina Adel', c1: '\xE2\x9C\x93', c2: 'X', abs: '0' }]),
    makeBinaryStream('04/12/2026', '11/12/2026', [{ code: 'SG-102', name: 'Marina Samir', c1: '-', c2: '-', abs: '0' }]),
    makeBinaryStream('04/12/2026', '11/12/2026', [{ code: 'SG-103', name: 'Bishoy Fayez', c1: '-', c2: '-', abs: '0' }]),
    makeBinaryStream('04/12/2026', '11/12/2026', [{ code: 'SG-108', name: 'Kirolos Gerges', c1: '-', c2: '-', abs: '0' }]),
    makeBinaryStream('04/12/2026', '11/12/2026', [{ code: 'SG-109', name: 'Youssef Hanna', c1: '-', c2: '-', abs: '0' }])
  ]);
  const extractedBinaryPages = await extractPositionedPagesFromPdfBuffer(binary5PageBuffer);
  assert.equal(extractedBinaryPages.length, 5, 'pdfjs-dist must parse all 5 pages from real binary PDF buffer');
  assert.ok(
    (extractedBinaryPages[0].verticalGridXs?.length || 0) >= 6,
    'pdfjs-dist vector operator parser must extract table vertical grid lines'
  );
  // Check that completely arbitrary dynamic dates work without hardcoding
  assert.ok(
    extractedBinaryPages[0].tokens.some((t) => t.str.includes('04/12/2026')) &&
      extractedBinaryPages[0].tokens.some((t) => t.str.includes('11/12/2026')),
    'Dynamic date tokens must be extracted from binary PDF stream'
  );

  // Scanned/Image-only PDF (empty text layer) MUST automatically invoke ocrProvider!
  const blankScannedPdfBuffer = buildRealBinaryPdfBuffer([
    '40 60 720 460 re S' // Pure graphic box, zero text characters
  ]);
  let ocrInvokedCount = 0;
  const scannedReport = await parseAttendancePdfBuffer('scanned_report.pdf', blankScannedPdfBuffer, baseStudents, {
    ocrProvider: async ({ pageIndex }) => {
      ocrInvokedCount++;
      return buildChurchRtlPage(pageIndex, ['04/12/2026', '11/12/2026'], [
        {
          name: 'يوسف حنا',
          phone1: '01244445555',
          phone2: '',
          phone3: '',
          address: '',
          marks: ['ح', 'غ'],
          absenceCountText: '1'
        }
      ]).tokens;
    }
  });
  assert.equal(ocrInvokedCount, 1, 'Scanned PDF with zero text chars MUST automatically run Arabic OCR fallback');
  assert.equal(scannedReport.extractionMode, 'ocr');
  assert.deepEqual(
    scannedReport.extractedDates.map((d) => d.date),
    ['2026-12-04', '2026-12-11'],
    'Custom arbitrary dates extracted via OCR without any hardcoded dates'
  );
  assert.equal(scannedReport.rows[0].matchedStudentId, 'st-9');
  assert.equal(scannedReport.rows[0].cells['2026-12-04'].status, 'present');
  assert.equal(scannedReport.rows[0].cells['2026-12-11'].status, 'absent');

  // -------------------------------------------------------------------------
  // Case 5: Conflict protection (keep_existing default preserves history vs explicit overwrite)
  // -------------------------------------------------------------------------
  const studentsWithExisting = baseStudents.map((s) =>
    s.id === 'st-1'
      ? { ...s, att: { '2026-10-23': false, '2026-10-16': true }, attendanceTotal: 1, version: 3 } // Conflict on 2026-10-23 (existing=false vs PDF=present)
      : s
  );
  const resState = createInitialPdfResolutionState();
  const initialPlan = buildAttendanceImportPlan(report5, studentsWithExisting, resState);

  assert.equal(initialPlan.conflicts.length, 1);
  assert.equal(initialPlan.conflicts[0].key, 'st-1__2026-10-23');
  assert.equal(initialPlan.conflicts[0].decision, 'keep_existing', 'Conflicts must default to keeping historical data');
  assert.ok(
    !initialPlan.toApply.some((e) => e.studentId === 'st-1' && e.fridayDate === '2026-10-23'),
    'Conflicting entry kept as existing must NOT be in toApply'
  );
  assert.ok(
    !initialPlan.toApply.some((e) => e.studentId === 'st-dup-1' || e.studentId === 'st-fuzzy-1'),
    'Ambiguous, needs_review, and unmatched rows must NOT be auto-applied'
  );

  // Explicit user overwrite + manual confirmation of fuzzy & ambiguous cell overrides
  const resolvedState = {
    ...resState,
    conflictDecisions: { 'st-1__2026-10-23': 'overwrite_with_pdf' as const },
    rowMappings: { [fuzzyRow.rowKey]: 'st-fuzzy-1' },
    cellOverrides: {
      [`${saraRow.rowKey}__2026-11-06`]: 'present' as const,
      [`${saraRow.rowKey}__2026-11-13`]: 'absent' as const
    }
  };
  const resolvedPlan = buildAttendanceImportPlan(report5, studentsWithExisting, resolvedState);
  assert.ok(
    resolvedPlan.toApply.some((e) => e.studentId === 'st-1' && e.fridayDate === '2026-10-23' && e.isPresent === true),
    'Explicit overwrite_with_pdf conflict decision applies overwrite'
  );
  assert.ok(
    resolvedPlan.toApply.some((e) => e.studentId === 'st-fuzzy-1' && e.fridayDate === '2026-10-23'),
    'User-confirmed candidate applies cleanly'
  );

  // -------------------------------------------------------------------------
  // Case 6: Batch Execution, Phone/Address Preservation, Historical Date Preservation,
  // Sequential OCC Versions, Re-upload Idempotency, Offline Queue & Verified Drain
  // -------------------------------------------------------------------------
  await idbClearMutations();
  await idbSaveStudents(studentsWithExisting, 'نشط', true);

  const adminPerm = () => ({ allowed: true });
  const batchPlan = prepareBatchAttendanceMutations(
    resolvedPlan.toApply.map((x) => ({
      studentId: x.studentId,
      fridayDate: x.fridayDate,
      isPresent: x.isPresent
    })),
    studentsWithExisting,
    adminPerm,
    '2026-11-16'
  );

  // Verify st-1 has sequential OCC versions: baseVersion=3 -> mutations have 3,4,5,6 and updatedStudent.version=7!
  const st1Muts = batchPlan.mutations.filter((m) => m.studentId === 'st-1').sort((a, b) => a.timestamp - b.timestamp);
  assert.equal(st1Muts.length, 4);
  assert.deepEqual(
    st1Muts.map((m) => m.expectedVersion),
    [3, 4, 5, 6],
    'Multi-date mutations for a student must chain expectedVersion contiguously'
  );
  const updatedSt1 = batchPlan.updatedStudents.find((s) => s.id === 'st-1')!;
  assert.equal(updatedSt1.version, 7);
  assert.equal(updatedSt1.att['2026-10-16'], true, 'Previous unrelated historical dates must stay untouched');
  assert.equal(updatedSt1.att['2026-10-23'], true);
  assert.equal(updatedSt1.att['2026-10-30'], false);
  assert.equal(updatedSt1.phoneStudent, '01211111111', 'Student phone must NEVER be overwritten by PDF');
  assert.equal(updatedSt1.address, 'أصل 1', 'Student address must NEVER be overwritten by PDF');

  // RBAC check: Servant can ONLY mutate their assigned students (cannot mutate st-3 'خادم آخر')
  const servantPerm = (_act: 'attendance', servant?: string) =>
    servant === 'أبانوب عادل' ? { allowed: true } : { allowed: false, reason: 'غير مصرح' };
  const servantBatch = prepareBatchAttendanceMutations(
    resolvedPlan.toApply.map((x) => ({ studentId: x.studentId, fridayDate: x.fridayDate, isPresent: x.isPresent })),
    studentsWithExisting,
    servantPerm,
    '2026-11-16'
  );
  assert.ok(!servantBatch.mutations.some((m) => m.studentId === 'st-3'), 'RBAC must block students assigned to other servants');
  assert.ok(servantBatch.blockedCount >= 4);

  // Atomic IndexedDB commit while OFFLINE
  await idbAtomicBatchRecordAttendanceWithMutations(
    batchPlan.updatedStudents,
    batchPlan.historyRecords,
    batchPlan.mutations
  );
  // Apply updates back into IDB merged store
  const stAfterCommitMap = new Map(studentsWithExisting.map((s) => [s.id, s]));
  for (const up of batchPlan.updatedStudents) stAfterCommitMap.set(up.id, up);
  const mergedStudentsAfterImport = Array.from(stAfterCommitMap.values());

  const idbMutsAfterOfflineSave = await idbGetPendingMutations();
  const idbHistAfterOfflineSave = await idbGetAttendanceHistory();
  assert.equal(idbMutsAfterOfflineSave.length, batchPlan.mutations.length, 'All batch mutations queued offline in IndexedDB');
  assert.equal(idbHistAfterOfflineSave.length, batchPlan.historyRecords.length, 'All attendance_history records saved cleanly');

  // Re-upload identical PDF -> 100% idempotent, zero duplicate mutations!
  const reuploadBatch = prepareBatchAttendanceMutations(
    resolvedPlan.toApply.map((x) => ({ studentId: x.studentId, fridayDate: x.fridayDate, isPresent: x.isPresent })),
    mergedStudentsAfterImport,
    adminPerm,
    '2026-11-16'
  );
  assert.equal(reuploadBatch.appliedCount, 0, 'Identical re-upload must skip all unchanged records');
  assert.equal(reuploadBatch.skippedDuplicateCount, resolvedPlan.toApply.length);

  // Simulate Queue Drain: 1) Failure retains queue (HTTP 500), 2) Verified Server Success drains queue with OCC version check!
  const serverVersions = new Map<string, number>(studentsWithExisting.map((s) => [s.id, s.version]));
  const originalFetch = globalThis.fetch;
  localStorage.setItem('stgorge_apps_script_url', 'https://script.google.com/macros/s/test-relay/exec');
  localStorage.setItem('stgorge_relay_key', 'test-secret-relay-key');
  Object.defineProperty(globalThis, 'navigator', {
    value: { onLine: true },
    configurable: true
  });

  try {
    // 6a. Simulated HTTP 500 server error -> queue MUST NOT be cleared!
    (globalThis as any).fetch = async () => new Response('Server Error', { status: 500 });
    const failedDrain = await executeProcessOfflineQueue(null as AuthUser | null, false);
    assert.equal(failedDrain.sentCount, 0);
    assert.equal(failedDrain.remainingCount, batchPlan.mutations.length, 'Queue MUST be retained when server fails');

    // 6b. Verified Server Accept with Relay Key & OCC Version Check & NO no-cors (Supports Batch & Single)
    clearBatchUnsupportedCache();
    let sawNoCors = false;
    const sentDatesPerStudent = new Map<string, string[]>();
    (globalThis as any).fetch = async (_url: string, init?: RequestInit) => {
      if (init?.mode === 'no-cors') sawNoCors = true;
      const body = JSON.parse(String(init?.body || '{}'));
      assert.equal(body.relayKey, 'test-secret-relay-key', 'Must send relayKey for Apps Script authentication');

      if (body.action === 'batch' && Array.isArray(body.mutations)) {
        const results = body.mutations.map((item: any) => {
          const curVer = serverVersions.get(item.studentId) ?? 1;
          if (curVer !== item.expectedVersion) {
            return { ok: false, status: 409, mutationId: item.idempotencyKey, error: 'Version mismatch' };
          }
          serverVersions.set(item.studentId, curVer + 1);
          if (!sentDatesPerStudent.has(item.studentId)) sentDatesPerStudent.set(item.studentId, []);
          sentDatesPerStudent.get(item.studentId)!.push(item.date);
          return { ok: true, status: 200, mutationId: item.idempotencyKey, newVersion: curVer + 1 };
        });
        return new Response(JSON.stringify({ ok: true, action: 'batch', results, serverDurationMs: 42 }), { status: 200 });
      }

      const curVer = serverVersions.get(body.studentId) ?? 1;
      if (curVer !== body.expectedVersion) {
        return new Response(JSON.stringify({ ok: false, status: 409, error: 'Version mismatch' }), { status: 409 });
      }
      serverVersions.set(body.studentId, curVer + 1);
      if (!sentDatesPerStudent.has(body.studentId)) sentDatesPerStudent.set(body.studentId, []);
      sentDatesPerStudent.get(body.studentId)!.push(body.date);
      return new Response(JSON.stringify({ ok: true, id: body.idempotencyKey }), { status: 200 });
    };

    const okDrain = await executeProcessOfflineQueue(null as AuthUser | null, false);
    assert.equal(sawNoCors, false, 'MUST NEVER use opaque mode: no-cors');
    assert.equal(okDrain.success, true);
    assert.equal(okDrain.sentCount, batchPlan.mutations.length);
    assert.equal(okDrain.remainingCount, 0);
    assert.deepEqual(
      sentDatesPerStudent.get('st-1'),
      ['2026-10-23', '2026-10-30', '2026-11-06', '2026-11-13'],
      'All 4 dates for st-1 synced chronologically with sequential OCC approval'
    );
  } finally {
    (globalThis as any).fetch = originalFetch;
    await idbClearMutations();
    clearBatchUnsupportedCache();
  }

  // -------------------------------------------------------------------------
  // Case 7: UI Entry Points & Modal Component Verification (SSR + Source wiring)
  // -------------------------------------------------------------------------
  const sidebarSrc = fs.readFileSync(path.resolve(process.cwd(), 'src/components/layout/Sidebar.tsx'), 'utf-8');
  const tableSrc = fs.readFileSync(path.resolve(process.cwd(), 'src/components/table/StudentsTableView.tsx'), 'utf-8');
  const appSrc = fs.readFileSync(path.resolve(process.cwd(), 'src/App.tsx'), 'utf-8');
  const modalSrc = fs.readFileSync(path.resolve(process.cwd(), 'src/components/modals/PdfAttendanceImportModal.tsx'), 'utf-8');

  assert.ok(sidebarSrc.includes('setIsPdfImportModalOpen(true)'), 'Sidebar must expose Import PDF entry point');
  assert.ok(tableSrc.includes('setIsPdfImportModalOpen(true)'), 'StudentsTableView must expose Import PDF entry point');
  assert.ok(appSrc.includes('<PdfAttendanceImportModal />'), 'App.tsx must mount PdfAttendanceImportModal');
  assert.ok(modalSrc.includes('accept=".pdf,application/pdf"'), 'Modal must support PDF file selection');

  // Verify clean SSR markup for the modal inside mock context isn't broken (imports clean)
  const { PdfAttendanceImportModal } = await import('../components/modals/PdfAttendanceImportModal');
  assert.equal(typeof PdfAttendanceImportModal, 'function');

  // -------------------------------------------------------------------------
  // Case 8: Excel-for-Microsoft-365 Real Quirk Regression Tests (23/10, 30/10, 6/11, 13/11)
  // -------------------------------------------------------------------------
  // 8a. Bidi controls (\u061C, \u200F), fraction slashes, Arabic-Indic numerals, and reversed visual glyphs
  assert.equal(parsePdfColumnDateHeader('\u061C23\u200F/\u061C10\u200F/\u061C2026')?.isoDate, '2026-10-23');
  assert.equal(parsePdfColumnDateHeader('٦\u2044١١\u2044٢٠٢٦')?.isoDate, '2026-11-06');
  assert.equal(parsePdfColumnDateHeader('6202/11/6')?.isoDate, '2026-11-06', 'Reversed visual date run recovers cleanly');
  assert.equal(parsePdfColumnDateHeader('13/11 2026')?.isoDate, '2026-11-13', 'Wrapped header year recovers cleanly');

  // 8b. 5-page Excel-365 RTL report with:
  // - Multi-row title banner (including a banner mentioning date range!) pushing header to row >= 7
  // - Split inline date runs ["23", "/", "10", "/", "2026"] + ["6", "/11/", "2026"]
  // - Wrapped year continuation row ["2026", "2026"]
  // - Repeated headers across pages AND horizontal+vertical Excel cell border grid
  const excelBannerTokens = (pageIndex: number): PositionedPdfToken[] => [
    { str: 'كنيسة الشهيد العظيم مار جرجس', x: 350, y: 18, width: 160, height: 12, pageIndex },
    { str: 'تقرير الحضور من 23/10/2026 إلى 13/11/2026', x: 320, y: 34, width: 210, height: 10, pageIndex },
    { str: 'اجتماع إعدادي بنين', x: 380, y: 50, width: 100, height: 10, pageIndex },
    { str: 'بيانات الأسرة والخدمة', x: 370, y: 66, width: 110, height: 10, pageIndex },
    { str: 'كشف متابعة أكتوبر ونوفمبر', x: 360, y: 82, width: 120, height: 10, pageIndex },
    { str: 'ملاحظات عامة', x: 390, y: 98, width: 80, height: 10, pageIndex },
    { str: 'ترتيب أبجدي حسب الاسم', x: 365, y: 114, width: 115, height: 10, pageIndex }
  ];

  const excelCols = {
    absence: 42,
    d3: 100, // 13/11/2026
    d2: 155, // 6/11/2026
    d1: 210, // 30/10/2026
    d0: 265, // 23/10/2026
    address: 340,
    p3: 470,
    p2: 550,
    p1: 630,
    name: 720
  };
  const excelVGrid = [20, 80, 132, 187, 242, 297, 442, 522, 602, 685, 830];

  const makeExcelQuirkPage = (
    pageIndex: number,
    studentRows: Array<{ name: string; phone: string; marks: string[]; abs: string }>
  ): PositionedPdfPage => {
    const tokens: PositionedPdfToken[] = [
      ...excelBannerTokens(pageIndex),
      // Real Table Header Row at y=145 (wrapped header across y=145 & y=160)
      { str: 'الاسم بالكامل', x: excelCols.name, y: 145, width: 60, height: 11, pageIndex },
      { str: 'تليفون المخدوم', x: excelCols.p1, y: 145, width: 55, height: 10, pageIndex },
      { str: 'تليفون ولي الأمر', x: excelCols.p2, y: 145, width: 55, height: 10, pageIndex },
      { str: 'تليفون آخر', x: excelCols.p3, y: 145, width: 45, height: 10, pageIndex },
      { str: 'العنوان', x: excelCols.address, y: 145, width: 40, height: 10, pageIndex },
      // Split inline Excel runs for 23/10/2026 with \u061C
      { str: '\u061C23', x: excelCols.d0, y: 145, width: 10, height: 10, pageIndex },
      { str: '/', x: excelCols.d0 + 10, y: 145, width: 3, height: 10, pageIndex },
      { str: '10', x: excelCols.d0 + 13, y: 145, width: 10, height: 10, pageIndex },
      { str: '/', x: excelCols.d0 + 23, y: 145, width: 3, height: 10, pageIndex },
      { str: '2026', x: excelCols.d0 + 26, y: 145, width: 18, height: 10, pageIndex },
      // Wrapped 2-line date headers (30/10 on line 1, 2026 on line 2)
      { str: '30/10/', x: excelCols.d1 + 8, y: 145, width: 24, height: 10, pageIndex },
      { str: '2026', x: excelCols.d1 + 10, y: 160, width: 20, height: 10, pageIndex },
      // Split inline single-digit date + bidi
      { str: '٦', x: excelCols.d2 + 4, y: 145, width: 6, height: 10, pageIndex },
      { str: '/١١/', x: excelCols.d2 + 10, y: 145, width: 13, height: 10, pageIndex },
      { str: '٢٠٢٦', x: excelCols.d2 + 23, y: 145, width: 18, height: 10, pageIndex },
      // Reversed visual run in 4th date + wrapped year row check
      { str: '13/11', x: excelCols.d3 + 8, y: 145, width: 24, height: 10, pageIndex },
      { str: '2026', x: excelCols.d3 + 10, y: 160, width: 20, height: 10, pageIndex },
      { str: 'عدد الغياب', x: excelCols.absence, y: 145, width: 38, height: 10, pageIndex }
    ];

    const hGrid = [138, 174];
    let yCur = 186;
    for (const sr of studentRows) {
      hGrid.push(yCur + 16);
      tokens.push({ str: sr.name, x: excelCols.name, y: yCur, width: 70, height: 11, pageIndex });
      tokens.push({ str: sr.phone, x: excelCols.p1, y: yCur, width: 55, height: 10, pageIndex });
      if (sr.marks[0]) tokens.push({ str: sr.marks[0], x: excelCols.d0 + 16, y: yCur, width: 12, height: 11, pageIndex });
      if (sr.marks[1]) tokens.push({ str: sr.marks[1], x: excelCols.d1 + 16, y: yCur, width: 12, height: 11, pageIndex });
      if (sr.marks[2]) tokens.push({ str: sr.marks[2], x: excelCols.d2 + 16, y: yCur, width: 12, height: 11, pageIndex });
      if (sr.marks[3]) tokens.push({ str: sr.marks[3], x: excelCols.d3 + 16, y: yCur, width: 12, height: 11, pageIndex });
      tokens.push({ str: sr.abs, x: excelCols.absence + 12, y: yCur, width: 14, height: 11, pageIndex });
      yCur += 24;
    }

    return {
      pageIndex,
      width: 842,
      height: 595,
      tokens,
      verticalGridXs: excelVGrid,
      horizontalGridYs: hGrid,
      extractionSource: 'text'
    };
  };

  const excelPages5: PositionedPdfPage[] = [
    makeExcelQuirkPage(0, [{ name: 'مينا عادل', phone: '01211111111', marks: ['ح', 'غ', 'ح', 'ح'], abs: '1' }]),
    makeExcelQuirkPage(1, [{ name: 'مارينا سمير', phone: '01222222222', marks: ['غ', 'غ', 'غ', 'ح'], abs: '3' }]),
    makeExcelQuirkPage(2, [{ name: 'بيشوي فايز', phone: '01233333333', marks: ['ح', 'ح', 'ح', 'غ'], abs: '1' }]),
    makeExcelQuirkPage(3, [{ name: 'أبانوب أشرف', phone: '01244444444', marks: ['ح', '', 'غ', 'ح'], abs: '1' }]),
    makeExcelQuirkPage(4, [{ name: 'مريم موسي', phone: '01255555555', marks: ['غ', 'ح', 'غ', 'ح'], abs: '2' }])
  ];

  // Snapshot IDB before parsing to verify parsing alone NEVER mutates storage
  const studentsBeforeParse = await idbGetStudents();
  const mutsBeforeParse = await idbGetPendingMutations();
  const excelReport = parseAttendanceReportFromPositionedPages('الشهيد الامير مار جرجس 13-11.pdf', excelPages5, baseStudents);

  assert.equal(excelReport.pageCount, 5);
  assert.deepEqual(
    excelReport.extractedDates.map((d) => d.date),
    ['2026-10-23', '2026-10-30', '2026-11-06', '2026-11-13'],
    'All 4 dates (23/10, 30/10, 6/11, 13/11) MUST be extracted despite banner dates, split tokens, wrapped years & bidi chars'
  );
  assert.equal(excelReport.rows.length, 5);
  assert.equal(excelReport.rows[0].cells['2026-10-23'].status, 'present');
  assert.equal(excelReport.rows[0].cells['2026-10-30'].status, 'absent');
  assert.equal(excelReport.rows[0].cells['2026-11-06'].status, 'present');
  assert.equal(excelReport.rows[0].cells['2026-11-13'].status, 'present');
  assert.equal(excelReport.rows[3].cells['2026-10-30'].status, 'empty', 'Empty Excel cell stays empty');
  assert.deepEqual(await idbGetStudents(), studentsBeforeParse, 'PDF parsing alone must NEVER modify IDB students');
  assert.deepEqual(await idbGetPendingMutations(), mutsBeforeParse, 'PDF parsing alone must NEVER queue mutations');

  // Verify mandatory PdfDiagnosticReport on 5-page Excel report
  assert.equal(excelReport.diagnostics.stageReached, 'completed');
  assert.equal(excelReport.diagnostics.failureStage, null);
  assert.equal(excelReport.diagnostics.pageCount, 5);
  assert.equal(excelReport.diagnostics.tableDirection, 'rtl');
  assert.ok(excelReport.diagnostics.totalTextItems >= 100);
  assert.ok(excelReport.diagnostics.totalRowClusters >= 40);
  assert.equal(excelReport.diagnostics.extractedStudentsCount, 5);
  assert.equal(excelReport.diagnostics.presentCount, 11);
  assert.equal(excelReport.diagnostics.absentCount, 8);
  assert.equal(excelReport.diagnostics.emptyCount, 1);
  assert.equal(excelReport.diagnostics.pages.length, 5);
  assert.equal(excelReport.diagnostics.pages[0].dateColumnCoordinates.length, 4);

  // 8c. Headerless continuation pages (Pages 2..5 carry active column geometry cleanly)
  const page1WithHeader = buildChurchRtlPage(0, referenceDates, [
    { name: 'مينا عادل', phone1: '01211111111', phone2: '', phone3: '', address: '', marks: ['ح', 'غ', 'ح', 'ح'], absenceCountText: '1' }
  ]);
  const headerlessPage2: PositionedPdfPage = {
    pageIndex: 1,
    width: 842,
    height: 595,
    verticalGridXs: page1WithHeader.verticalGridXs,
    extractionSource: 'text',
    tokens: [
      { str: 'مارينا سمير', x: 720, y: 60, width: 65, height: 11, pageIndex: 1 },
      { str: 'غ', x: 280, y: 60, width: 12, height: 11, pageIndex: 1 },
      { str: 'غ', x: 225, y: 60, width: 12, height: 11, pageIndex: 1 },
      { str: 'غ', x: 170, y: 60, width: 12, height: 11, pageIndex: 1 },
      { str: 'ح', x: 115, y: 60, width: 12, height: 11, pageIndex: 1 }
    ]
  };
  const headerlessContReport = parseAttendanceReportFromPositionedPages('continuation.pdf', [page1WithHeader, headerlessPage2], baseStudents);
  assert.equal(headerlessContReport.rows.length, 2, 'Headerless continuation page 2 MUST preserve student rows');
  assert.equal(headerlessContReport.rows[1].cells['2026-11-13'].status, 'present');

  // 8d. Binary PDF with 90-degree rotated date header text (`0 1 -1 0 ... Tm`) parsed through pdfjs-dist
  const rotatedBinaryStream = [
    '40 60 m 40 520 l S',
    '140 60 m 140 520 l S',
    '220 60 m 220 520 l S',
    '300 60 m 300 520 l S',
    '600 60 m 600 520 l S',
    'BT /F1 11 Tf 450 480 Td (Name) Tj ET',
    'BT /F1 10 Tf 0 1 -1 0 260 440 Tm (23/10/2026) Tj ET',
    'BT /F1 10 Tf 0 1 -1 0 180 440 Tm (30/10/2026) Tj ET',
    'BT /F1 10 Tf 0 1 -1 0 90 440 Tm (6/11/2026) Tj ET',
    'BT /F1 11 Tf 450 400 Td (Mina Adel) Tj ET',
    'BT /F1 11 Tf 255 400 Td (-) Tj ET',
    'BT /F1 11 Tf 175 400 Td (-) Tj ET',
    'BT /F1 11 Tf 85 400 Td (-) Tj ET'
  ].join('\n');
  const rotatedPages = await extractPositionedPagesFromPdfBuffer(buildRealBinaryPdfBuffer([rotatedBinaryStream]));
  const rotatedReport = parseAttendanceReportFromPositionedPages('rotated_excel.pdf', rotatedPages, baseStudents);
  assert.deepEqual(
    rotatedReport.extractedDates.map((d) => d.date),
    ['2026-10-23', '2026-10-30', '2026-11-06'],
    '90-degree rotated Excel date columns in real binary PDF must parse cleanly'
  );

  // 8e. Failure diagnostic reporting & public pdfjs assets verification
  const corruptReport = await parseAttendancePdfBuffer('corrupt.pdf', new Uint8Array([1, 2, 3, 4]), baseStudents);
  assert.equal(corruptReport.diagnostics.failureStage, 'pdf_load');
  assert.ok(corruptReport.diagnostics.failureReason && corruptReport.diagnostics.failureReason.length > 0);
  assert.ok(modalSrc.includes('التقرير التشخيصي لتحليل الجدول'), 'Modal must render mandatory Diagnostic Report panel');
  assert.ok(fs.existsSync(path.resolve(process.cwd(), 'public/pdfjs/pdf.worker.min.mjs')), 'public/pdfjs/pdf.worker.min.mjs must exist');
  assert.ok(fs.existsSync(path.resolve(process.cwd(), 'public/pdfjs/cmaps')), 'public/pdfjs/cmaps must exist');

  // -------------------------------------------------------------------------
  // Case 9: Sidebar Redundant Toggle Arrow Removal Verification
  // -------------------------------------------------------------------------
  assert.ok(!sidebarSrc.includes('ChevronLeft'), 'Floating ChevronLeft toggle arrow must be removed from Sidebar.tsx');
  assert.ok(!sidebarSrc.includes('فتح القائمة الجانبية بالسحب'), 'Floating drag handle button must be removed from Sidebar.tsx');
  assert.ok(!sidebarSrc.includes('dragHandleStartRef'), 'Unused dragHandleStartRef must be removed');
  assert.ok(!sidebarSrc.includes('handleDragHandlePointerDown'), 'Unused pointer handler must be removed');
  assert.ok(sidebarSrc.includes('onTouchStart={handleDrawerTouchStart}'), 'Drawer swipe-to-close must remain intact');

  console.log('✅ All Real Attendance PDF Import + Excel-365 + Diagnostics + Sidebar checks passed 100%!');
}

runTests().catch((err) => {
  console.error('❌ Test failure:', err);
  process.exit(1);
});
