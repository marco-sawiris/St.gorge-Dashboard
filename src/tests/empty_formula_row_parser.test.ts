/**
 * Phase 4.2.3 — Targeted Empty Formula Row Parser Fix Test Suite
 *
 * Strictly verifies the 9 mandatory cases in memory & mocked fetch (0 live calls, 0 POST, 0 IndexedDB user writes):
 * 1. Template/formula row containing only known formula defaults -> ignored, does NOT increment skippedCorruptedRowCount
 * 2. Completely empty row -> ignored
 * 3. Row with student code without name -> corrupted (isPartialParse: true)
 * 4. Row with phone number without name -> corrupted (isPartialParse: true)
 * 5. Row with servant name without name -> corrupted (isPartialParse: true)
 * 6. Row with positive attendance (1 / TRUE / حاضر / positive total / real lastAttendance date) without name -> corrupted
 *    (Plus numeric-only row in non-formula column or non-zero number in unnamed column -> corrupted)
 * 7. Tab with 10 valid students + trailing empty formula row (matching live "فصل البابا شنودة " shape) -> returns 10 students, isPartialParse: false
 * 8. Normal student records are completely unaffected (all fields, attendance, codes, stable IDs intact)
 * 9. Unverified tab remains protected and __ALL__ stays 'partial' when another tab is unverified
 */

import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';

const mockLocalStorage = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => (mockLocalStorage.has(k) ? mockLocalStorage.get(k)! : null),
  setItem: (k: string, v: string) => {
    mockLocalStorage.set(k, String(v));
  },
  removeItem: (k: string) => {
    mockLocalStorage.delete(k);
  },
  clear: () => {
    mockLocalStorage.clear();
  },
  key: (idx: number) => Array.from(mockLocalStorage.keys())[idx] ?? null,
  get length() {
    return mockLocalStorage.size;
  }
};

(globalThis as any).window = {
  location: { origin: 'http://localhost:3000', protocol: 'http:', hostname: 'localhost' },
  localStorage: (globalThis as any).localStorage
};

import {
  NONEXISTENT_SHEET_PROBE_NAME,
  parse2DRowsToStudentsDetailed,
  parseGoogleVisualizationResponseDetailed,
  fetchSheetStudentsViaGviz
} from '../services/googleSheetParser';
import { executeSyncData } from '../context/AppContext';
import type { PartialSyncInfo } from '../context/AppContext';
import { idbCloseDatabase, idbGetStudents, idbSaveStudents } from '../services/indexedDbService';
import { Student } from '../types/student';

const DEFAULT_SPREADSHEET_ID = '15Nda4pGb3WdAfOuRTwRS9Fx822_EORgumOmhZcjTVt0';
const FORM_FALLBACK_HEADERS = ['طابع زمني', 'الرد الأول', 'عنوان البريد الإلكتروني'];
const FOLLOWUP_LOG_HEADERS = ['التاريخ', 'أسبوع الجمعة', 'الاسم', 'النوع', 'الأشبين', 'ملاحظات'];

// Mirrors the real Google Sheet structure of "فصل البابا شنودة " (including lastAttendance + unnamed formula col_12)
const POPE_LIKE_HEADERS = [
  'كود',              // 0
  'الاسم',            // 1
  'الاشبين',          // 2
  'موبيال المخدوم',   // 3
  'موبيل ولي الامر 1',// 4
  'موبيل ولي الامر 2',// 5
  'تاريخ الميلاد',    // 6
  'منطقة',            // 7
  'العنوان',          // 8
  'آخر حضور',         // 9  (formula column)
  'آخر افتقاد',       // 10 (formula column)
  '2026-10-09',       // 11 (Friday attendance)
  '',                 // 12 (unnamed formula helper col_12)
  '2026-10-16',       // 13 (Friday attendance)
  'إجمالي الحضور',    // 14 (formula count column)
  'حالة الافتقاد'     // 15 (formula status column)
];

function makeBlankRow(len: number = POPE_LIKE_HEADERS.length): string[] {
  return Array.from({ length: len }, () => '');
}

function makeValidStudentRow(idx: number): string[] {
  const r = makeBlankRow();
  r[0] = String(650100 + idx);
  r[1] = `طالب صالح رقم ${idx}`;
  r[2] = 'ماركو ملجي فارس';
  r[3] = `012000001${String(idx).padStart(2, '0')}`;
  r[7] = 'شبرا';
  r[9] = '2026-10-16';
  r[11] = '1';
  r[12] = '2';
  r[13] = '1';
  r[14] = '2';
  r[15] = 'بدون';
  return r;
}

function buildGvizPayload(options: {
  sig: string;
  headers: string[];
  rows: (string | number | null)[][];
}): string {
  const payload = {
    version: '0.6',
    reqId: '0',
    status: 'ok',
    sig: options.sig,
    table: {
      cols: options.headers.map((label, idx) => ({ id: String.fromCharCode(65 + idx), label, type: 'string' })),
      rows: options.rows.map((cells) => ({
        c: cells.map((val) => (val === null ? null : { v: val, f: String(val) }))
      }))
    }
  };
  return `/*O_o*/\ngoogle.visualization.Query.setResponse(${JSON.stringify(payload)});`;
}

async function resetFakeDatabase(): Promise<void> {
  idbCloseDatabase();
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.deleteDatabase('StGorgeServiceDB');
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => resolve();
  });
}

async function runTests() {
  console.log('\n=====================================================================');
  console.log('🧪 Phase 4.2.3 — Empty Formula Row Parser Fix Test Suite (9 Cases)');
  console.log('=====================================================================\n');

  let passed = 0;

  // ------------------------------------------------------------------
  // CASE 1: Template/formula row with known formula defaults -> IGNORED
  // ------------------------------------------------------------------
  {
    const templateRowA = makeBlankRow();
    templateRowA[9] = 'غائب';  // آخر حضور formula default (4 chars)
    templateRowA[12] = '0';    // unnamed formula col_12 default

    const templateRowB = makeBlankRow();
    templateRowB[9] = 'بدون';
    templateRowB[10] = 'بدون';
    templateRowB[11] = 'FALSE';
    templateRowB[12] = '0';
    templateRowB[13] = '0';
    templateRowB[14] = '0';
    templateRowB[15] = 'بدون';

    const templateRowC = makeBlankRow();
    templateRowC[9] = '1899-12-30'; // classic Sheets zero-date formula artifact
    templateRowC[14] = '#N/A';

    const res = parse2DRowsToStudentsDetailed(
      POPE_LIKE_HEADERS,
      [makeValidStudentRow(1), templateRowA, templateRowB, templateRowC],
      'فصل البابا شنودة'
    );

    assert.equal(res.students.length, 1, 'Only the 1 valid student should be parsed');
    assert.equal(res.skippedCorruptedRowCount, 0, 'Template/formula rows MUST NOT increment skippedCorruptedRowCount');
    assert.equal(res.ignoredTemplateRowCount, 3, 'All 3 template/formula rows should be counted as ignoredTemplateRowCount');
    assert.equal(res.isPartialParse, false, 'isPartialParse MUST remain false for known formula template rows');
    console.log('✅ Case 1 Passed: Known template/formula rows ignored without incrementing corrupted count');
    passed++;
  }

  // ------------------------------------------------------------------
  // CASE 2: Completely empty row -> IGNORED
  // ------------------------------------------------------------------
  {
    const res = parse2DRowsToStudentsDetailed(
      POPE_LIKE_HEADERS,
      [makeValidStudentRow(1), makeBlankRow(), Array(POPE_LIKE_HEADERS.length).fill('   ')],
      'فصل البابا شنودة'
    );
    assert.equal(res.students.length, 1);
    assert.equal(res.skippedCorruptedRowCount, 0);
    assert.equal(res.isPartialParse, false);
    console.log('✅ Case 2 Passed: Completely empty rows ignored cleanly');
    passed++;
  }

  // ------------------------------------------------------------------
  // CASE 3: Row with student code without name -> CORRUPTED
  // ------------------------------------------------------------------
  {
    const codeOnlyRow = makeBlankRow();
    codeOnlyRow[0] = '650999';

    // Even '0' in the code column MUST be rejected (column semantics, not blanket numeric ignore!)
    const zeroCodeRow = makeBlankRow();
    zeroCodeRow[0] = '0';

    for (const [label, badRow] of [
      ['normal code without name', codeOnlyRow],
      ['numeric 0 in code column without name', zeroCodeRow]
    ] as const) {
      const res = parse2DRowsToStudentsDetailed(
        POPE_LIKE_HEADERS,
        [makeValidStudentRow(1), badRow],
        'فصل البابا شنودة'
      );
      assert.equal(res.skippedCorruptedRowCount, 1, `${label} MUST be flagged as corrupted`);
      assert.equal(res.isPartialParse, true, `${label} MUST trigger isPartialParse: true`);
    }
    console.log('✅ Case 3 Passed: Row with student code (including "0") without name strictly flagged as corrupted');
    passed++;
  }

  // ------------------------------------------------------------------
  // CASE 4: Row with phone number without name -> CORRUPTED
  // ------------------------------------------------------------------
  {
    const studentPhoneRow = makeBlankRow();
    studentPhoneRow[3] = '01234567890';

    const parentPhoneRow = makeBlankRow();
    parentPhoneRow[4] = '01098765432';

    // Also verify generic header 'التليفون'
    const genericHeaders = ['الكود', 'الاسم', 'الخادم', 'التليفون', '2026-10-09', '2026-10-16'];
    const genericPhoneRow = ['', '', '', '01112223334', '', ''];

    assert.equal(
      parse2DRowsToStudentsDetailed(POPE_LIKE_HEADERS, [makeValidStudentRow(1), studentPhoneRow], 'فصل البابا شنودة').isPartialParse,
      true,
      'Student phone without name MUST be corrupted'
    );
    assert.equal(
      parse2DRowsToStudentsDetailed(POPE_LIKE_HEADERS, [makeValidStudentRow(1), parentPhoneRow], 'فصل البابا شنودة').isPartialParse,
      true,
      'Parent phone without name MUST be corrupted'
    );
    assert.equal(
      parse2DRowsToStudentsDetailed(genericHeaders, [['101', 'طالب', 'خادم', '0100', '1', '1'], genericPhoneRow], 'نشط').isPartialParse,
      true,
      'Generic phone column without name MUST be corrupted'
    );
    console.log('✅ Case 4 Passed: Row with phone number without name strictly flagged as corrupted');
    passed++;
  }

  // ------------------------------------------------------------------
  // CASE 5: Row with servant name without name -> CORRUPTED
  // ------------------------------------------------------------------
  {
    const servantOnlyRow = makeBlankRow();
    servantOnlyRow[2] = 'ماركو ملجي فارس';

    const res = parse2DRowsToStudentsDetailed(
      POPE_LIKE_HEADERS,
      [makeValidStudentRow(1), servantOnlyRow],
      'فصل البابا شنودة'
    );
    assert.equal(res.skippedCorruptedRowCount, 1);
    assert.equal(res.isPartialParse, true);
    console.log('✅ Case 5 Passed: Row with servant name without student name strictly flagged as corrupted');
    passed++;
  }

  // ------------------------------------------------------------------
  // CASE 6: Row with positive attendance / real attendance data / non-zero numbers without name -> CORRUPTED
  // ------------------------------------------------------------------
  {
    const posFridayNumeric = makeBlankRow();
    posFridayNumeric[11] = '1';

    const posFridayBool = makeBlankRow();
    posFridayBool[13] = 'TRUE';

    const posFridayArabic = makeBlankRow();
    posFridayArabic[11] = 'حاضر';

    const posTotalAtt = makeBlankRow();
    posTotalAtt[14] = '3';

    const realLastAttDate = makeBlankRow();
    realLastAttDate[9] = '2026-10-16';

    const nonZeroUnnamedCol = makeBlankRow();
    nonZeroUnnamedCol[12] = '5';

    const unrecognizedColHeaders = [...POPE_LIKE_HEADERS, 'عمود بيانات إضافية'];
    const unrecognizedColRow = [...makeBlankRow(), '0'];

    for (const [label, hdrs, badRow] of [
      ['Friday = 1', POPE_LIKE_HEADERS, posFridayNumeric],
      ['Friday = TRUE', POPE_LIKE_HEADERS, posFridayBool],
      ['Friday = حاضر', POPE_LIKE_HEADERS, posFridayArabic],
      ['إجمالي الحضور = 3', POPE_LIKE_HEADERS, posTotalAtt],
      ['آخر حضور = real date 2026-10-16', POPE_LIKE_HEADERS, realLastAttDate],
      ['unnamed col_12 = non-zero 5', POPE_LIKE_HEADERS, nonZeroUnnamedCol],
      ['unrecognized named column with "0"', unrecognizedColHeaders, unrecognizedColRow]
    ] as const) {
      const res = parse2DRowsToStudentsDetailed(
        hdrs,
        [makeValidStudentRow(1), badRow],
        'فصل البابا شنودة'
      );
      assert.equal(res.skippedCorruptedRowCount, 1, `${label} MUST be flagged as corrupted`);
      assert.equal(res.isPartialParse, true, `${label} MUST set isPartialParse: true`);
    }
    console.log('✅ Case 6 Passed: Positive attendance, real dates, non-zero numbers, and unrecognized columns without name strictly corrupted');
    passed++;
  }

  // ------------------------------------------------------------------
  // CASE 7 & 8: Tab with 10 valid students + trailing formula row -> 10 students, isPartialParse: false,
  //             and all normal student data completely unaffected
  // ------------------------------------------------------------------
  {
    const tenValidRows = Array.from({ length: 10 }, (_, idx) => makeValidStudentRow(idx + 1));
    const trailingFormulaRow = makeBlankRow();
    trailingFormulaRow[9] = 'غائب'; // Exact live pattern from "فصل البابا شنودة " row 10
    trailingFormulaRow[12] = '0';

    const gvizBody = buildGvizPayload({
      sig: 'sig_pope_10_plus_formula',
      headers: POPE_LIKE_HEADERS,
      rows: [...tenValidRows, trailingFormulaRow]
    });

    const parsed = parseGoogleVisualizationResponseDetailed(gvizBody, 'فصل البابا شنودة');
    assert.equal(parsed.students.length, 10, 'Must return all 10 valid students');
    assert.equal(parsed.parsedRowCount, 10);
    assert.equal(parsed.skippedCorruptedRowCount, 0, 'Trailing formula row must not count as corrupted');
    assert.equal(parsed.ignoredTemplateRowCount, 1, 'Trailing formula row counted cleanly as ignored template row');
    assert.equal(parsed.isPartialParse, false, 'isPartialParse MUST be false');

    // Case 8: Verify normal student fields are 100% intact
    const first = parsed.students[0];
    const tenth = parsed.students[9];
    assert.equal(first.code, '650101');
    assert.equal(first.id, 'gs_code_فصل_البابا_شنودة_650101');
    assert.equal(first.name, 'طالب صالح رقم 1');
    assert.equal(first.servant, 'ماركو ملجي فارس');
    assert.equal(first.phoneStudent, '01200000101');
    assert.equal(first.area, 'شبرا');
    assert.equal(first.att['2026-10-09'], true);
    assert.equal(first.att['2026-10-16'], true);
    assert.equal(first.attendanceTotal, 2);
    assert.equal(first.identityQuality, 'stable_code');
    assert.equal(first.hasRemoteVersion, false);
    assert.equal(tenth.code, '650110');
    assert.equal(tenth.id, 'gs_code_فصل_البابا_شنودة_650110');

    console.log('✅ Case 7 & 8 Passed: 10 valid students + trailing formula row -> 10 students, isPartialParse: false, all normal fields intact');
    passed += 2;
  }

  // ------------------------------------------------------------------
  // CASE 9: Unverified tab stays protected & __ALL__ stays 'partial' when another tab is unverified
  // ------------------------------------------------------------------
  {
    await resetFakeDatabase();
    mockLocalStorage.clear();

    const localInactive: Student = {
      id: 'gs_code_غير_نشط_901',
      code: '901',
      name: 'مخدوم غير نشط محمي',
      servant: 'ماركو ملجي فارس',
      phoneStudent: '01299999901',
      phoneParent1: '',
      phoneParent2: '',
      birthDate: '',
      area: 'شبرا',
      address: '',
      notes: 'لا يجوز مسحه',
      followupStatus: 'بدون',
      attendanceTotal: 1,
      attendanceMonth: 1,
      attendanceStatus: 'حاضر',
      sourceSheet: 'غير نشط',
      version: 2,
      att: { '2026-10-16': true },
      fu: {}
    };
    await idbSaveStudents([localInactive], 'غير نشط', true);

    const tenPopeRows = Array.from({ length: 10 }, (_, idx) => makeValidStudentRow(idx + 1));
    const popeFormulaRow = makeBlankRow();
    popeFormulaRow[9] = 'غائب';
    popeFormulaRow[12] = '0';

    const httpCalls: string[] = [];
    (globalThis as any).fetch = async (input: any, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : String(input?.url || input);
      const method = (init?.method || 'GET').toUpperCase();
      httpCalls.push(`${method} ${url}`);
      if (method !== 'GET') throw new Error(`FORBIDDEN WRITE: ${method}`);
      const sheet = new URL(url).searchParams.get('sheet') || '';

      let body = buildGvizPayload({
        sig: 'sig_forms_default',
        headers: FORM_FALLBACK_HEADERS,
        rows: []
      });
      if (sheet === 'نشط') {
        body = buildGvizPayload({
          sig: 'sig_active_c9',
          headers: POPE_LIKE_HEADERS,
          rows: [makeValidStudentRow(1)]
        });
      } else if (sheet === 'غير حاضر') {
        body = buildGvizPayload({
          sig: 'sig_absent_c9',
          headers: POPE_LIKE_HEADERS,
          rows: [makeValidStudentRow(2)]
        });
      } else if (sheet === 'فصل البابا شنودة ') {
        body = buildGvizPayload({
          sig: 'sig_pope_c9',
          headers: POPE_LIKE_HEADERS,
          rows: [...tenPopeRows, popeFormulaRow]
        });
      } else if (sheet === 'سجل الافتقاد') {
        body = buildGvizPayload({
          sig: 'sig_fu_c9',
          headers: FOLLOWUP_LOG_HEADERS,
          rows: []
        });
      } else if (sheet === NONEXISTENT_SHEET_PROBE_NAME) {
        body = buildGvizPayload({
          sig: 'sig_forms_default',
          headers: FORM_FALLBACK_HEADERS,
          rows: []
        });
      }
      return { ok: true, status: 200, text: async () => body, json: async () => ({}) };
    };

    // First verify fetchSheetStudentsViaGviz confirms "فصل البابا شنودة" (10 students) while rejecting "غير نشط"
    const gvizAll = await fetchSheetStudentsViaGviz(DEFAULT_SPREADSHEET_ID, '__ALL__');
    assert.equal(gvizAll.confirmedSheets.includes('فصل البابا شنودة'), true, '"فصل البابا شنودة" must now be verified');
    assert.equal(gvizAll.sheetsMeta['فصل البابا شنودة']?.parsedRowCount, 10);
    assert.equal(gvizAll.unverifiedSheets.includes('غير نشط'), true, '"غير نشط" must remain unverified');

    // Run executeSyncData('__ALL__') -> MUST return 'partial', NOT update Last Sync Time, and preserve "غير نشط"!
    let lastSyncCalls = 0;
    let partialInfo: PartialSyncInfo | null = null;
    const syncLock = { current: false };

    const outcome = await executeSyncData(
      '__ALL__',
      null,
      false,
      syncLock,
      undefined,
      undefined,
      () => {
        lastSyncCalls++;
      },
      undefined,
      undefined,
      undefined,
      (info) => {
        partialInfo = info;
      }
    );

    assert.equal(outcome, 'partial', '__ALL__ must remain "partial" while "غير نشط" is unverified');
    assert.equal(lastSyncCalls, 0, 'Last Successful Sync Time MUST NOT update during partial sync');
    assert.deepEqual((partialInfo as PartialSyncInfo | null)?.skippedSheets, ['غير نشط']);
    assert.equal((partialInfo as PartialSyncInfo | null)?.appliedSheets.includes('فصل البابا شنودة'), true);

    const stored = await idbGetStudents();
    assert.equal(
      stored.some((s) => s.id === 'gs_code_غير_نشط_901' && s.sourceSheet === 'غير نشط'),
      true,
      'Unverified "غير نشط" local student MUST remain strictly protected'
    );
    assert.equal(
      stored.filter((s) => s.sourceSheet === 'فصل البابا شنودة').length,
      10,
      'Verified "فصل البابا شنودة" saved cleanly with all 10 students'
    );
    assert.equal(httpCalls.every((c) => c.startsWith('GET ')), true, 'Zero POST/write calls');

    console.log('✅ Case 9 Passed: "فصل البابا شنودة" verified (10/10), unverified "غير نشط" protected, __ALL__ stays "partial"');
    passed++;
  }

  console.log('\n=====================================================================');
  console.log(`🎉 ALL ${passed} OF 9 PHASE 4.2.3 EMPTY FORMULA ROW PARSER TESTS PASSED!`);
  console.log('=====================================================================\n');
}

runTests()
  .then(() => {
    idbCloseDatabase();
    process.exit(0);
  })
  .catch((err) => {
    console.error('\n💥 Phase 4.2.3 Parser Fix Test Failed:', err);
    idbCloseDatabase();
    process.exit(1);
  });
