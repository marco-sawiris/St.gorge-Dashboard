import {
  Student,
  StudentIdentityQuality,
  LIVE_GOOGLE_SHEET_TABS,
  STUDENT_CLASSIFICATION_OPTIONS,
  ALL_SHEETS_SENTINEL
} from '../types/student';
import { FollowupRecord, CallOutcome } from '../types/followup';
import { extractFollowupCallOutcome, normalizeArabicText } from '../utils/arabicUtils';
import { CENTRAL_SPREADSHEET_ID } from '../config/centralSheetConfig';

export const DEFAULT_SPREADSHEET_ID = CENTRAL_SPREADSHEET_ID;

const INVALID_STUDENT_CODE_TOKENS = new Set([
  '',
  '-',
  '—',
  '--',
  'null',
  'undefined',
  'n/a',
  'na',
  'none',
  'كود',
  'الكود',
  'code',
  'غير محدد'
]);

function normalizeArabicDigits(input: string): string {
  return input
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0));
}

export function normalizeStudentCodeKey(rawCode: string | undefined | null): string {
  const cleaned = normalizeArabicDigits(String(rawCode || ''))
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  return cleaned;
}

export function isValidStudentCode(rawCode: string | undefined | null): boolean {
  const norm = normalizeStudentCodeKey(rawCode);
  return norm.length > 0 && !INVALID_STUDENT_CODE_TOKENS.has(norm);
}

export function buildStableStudentIdFromCode(sheetName: string, rawCode: string): string {
  const cleanSheet = String(sheetName || '').trim().replace(/\s+/g, '_');
  const normCode = normalizeStudentCodeKey(rawCode).replace(/\s+/g, '_');
  return `gs_code_${cleanSheet}_${normCode}`;
}

function computeDualFnv1aHex(input: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < input.length; i++) {
    const ch = input.charCodeAt(i);
    h1 ^= ch;
    h1 = Math.imul(h1, 0x01000193);
    h2 ^= ch ^ (i & 0xff);
    h2 = Math.imul(h2, 0x01000193);
  }
  return `${(h1 >>> 0).toString(16).padStart(8, '0')}${(h2 >>> 0).toString(16).padStart(8, '0')}`;
}

export function buildUnkeyedStudentId(
  sheetName: string,
  name: string,
  phone: string,
  servant: string,
  occurrenceIndex: number
): string {
  const cleanSheet = String(sheetName || '').trim().replace(/\s+/g, '_');
  const payload = [
    cleanSheet,
    normalizeArabicText(name),
    normalizeArabicDigits(phone).replace(/\D+/g, ''),
    normalizeArabicText(servant),
    String(occurrenceIndex)
  ].join('|');
  return `gs_unkeyed_${cleanSheet}_${computeDualFnv1aHex(payload)}`;
}

function normalizeCellValue(val: any): string {
  if (val === null || val === undefined) return '';
  if (typeof val === 'string') {
    const trimmed = val.trim();
    // Convert gviz Date(Y,M,D) strings when formatted value wasn't provided
    const dateMatch = trimmed.match(/^Date\((\d+),(\d+),(\d+)(?:,\d+,\d+,\d+)?\)$/);
    if (dateMatch) {
      const y = dateMatch[1];
      const m = String(parseInt(dateMatch[2], 10) + 1).padStart(2, '0');
      const d = String(parseInt(dateMatch[3], 10)).padStart(2, '0');
      return `${y}-${m}-${d}`;
    }
    return trimmed;
  }
  return String(val).trim();
}

function findHeaderIndex(headers: string[], candidateNames: string[]): number {
  const cleanHeaders = headers.map((h) => h.replace(/\s+/g, ' ').trim());
  for (const candidate of candidateNames) {
    const idx = cleanHeaders.findIndex((h) => h === candidate);
    if (idx !== -1) return idx;
  }
  for (const candidate of candidateNames) {
    const idx = cleanHeaders.findIndex((h) => h.toLowerCase().includes(candidate.toLowerCase()));
    if (idx !== -1) return idx;
  }
  return -1;
}

function parseAttendanceCellState(val: string): boolean | undefined {
  const normalized = val.trim().toLowerCase();
  if (!normalized || normalized === '-' || normalized === 'null') return undefined;
  if (normalized === '1' || normalized === 'true' || normalized === 'حاضر' || normalized === 'yes' || normalized === '✓') {
    return true;
  }
  if (normalized === '0' || normalized === 'false' || normalized === 'غائب' || normalized === 'no' || normalized === '✗' || normalized === 'x') {
    return false;
  }
  return undefined;
}

export type GvizSheetVerificationStatus = 'verified' | 'unverified' | 'failed';

export type SheetHeaderInvalidReason =
  | 'empty_headers'
  | 'form_responses_tab'
  | 'followup_log_tab'
  | 'missing_name_column'
  | 'insufficient_student_columns';

export interface SheetHeaderValidationResult {
  valid: boolean;
  reason?: SheetHeaderInvalidReason;
  matchedColumns: string[];
}

export interface ParsedStudentsDetailedResult {
  students: Student[];
  headerValidation: SheetHeaderValidationResult;
  totalNonEmptyRows: number;
  parsedRowCount: number;
  skippedCorruptedRowCount: number;
  ignoredTemplateRowCount?: number;
  skippedRowErrors: string[];
  isPartialParse: boolean;
  unkeyedRowCount: number;
  hasVersionColumn: boolean;
}

export interface GvizSheetMeta {
  isComplete: boolean;
  verified: boolean;
  status: GvizSheetVerificationStatus;
  resolvedRemoteSheetName?: string;
  reason?: string;
  parsedRowCount?: number;
  skippedCorruptedRowCount?: number;
}

// Explicit, strictly-scoped remote tab name candidates for known Google Sheet trailing-space mismatches.
// Never guesses unrelated tabs and never modifies the remote Google Sheet tab name.
export const REMOTE_SHEET_GVIZ_CANDIDATES: Record<string, readonly string[]> = {
  'فصل البابا شنودة': ['فصل البابا شنودة ', 'فصل البابا شنودة']
};

export const NONEXISTENT_SHEET_PROBE_NAME = '__STGORGE_NONEXISTENT_TAB_PROBE__';

const FORM_RESPONSE_HEADER_MARKERS = [
  'طابع زمني',
  'timestamp',
  'سؤال بدون عنوان',
  'untitled question',
  'عنوان البريد الإلكتروني',
  'عنوان البريد الالكتروني',
  'email address'
];

function cleanHeaderLabel(header: string): string {
  return String(header || '').replace(/\s+/g, ' ').trim();
}

export function validateStudentTableHeaders(headers: string[]): SheetHeaderValidationResult {
  const cleaned = (Array.isArray(headers) ? headers : []).map(cleanHeaderLabel);
  const nonEmpty = cleaned.filter((h) => h.length > 0);
  if (nonEmpty.length === 0) {
    return { valid: false, reason: 'empty_headers', matchedColumns: [] };
  }

  const lowerSet = nonEmpty.map((h) => h.toLowerCase());
  const hasFormMarker = FORM_RESPONSE_HEADER_MARKERS.some((marker) =>
    lowerSet.some((h) => h === marker || h.includes(marker))
  );
  if (hasFormMarker) {
    return { valid: false, reason: 'form_responses_tab', matchedColumns: [] };
  }

  const nameIdx = findHeaderIndex(cleaned, ['الاسم', 'name', 'Name']);
  if (nameIdx === -1) {
    return { valid: false, reason: 'missing_name_column', matchedColumns: [] };
  }

  // Distinguish student roster tabs from 'سجل الافتقاد' log tab
  const hasFollowupLogDate = findHeaderIndex(cleaned, ['التاريخ']) !== -1;
  const hasFollowupLogFriday = findHeaderIndex(cleaned, ['أسبوع الجمعة', 'اسبوع الجمعة']) !== -1;
  const hasFollowupLogType = findHeaderIndex(cleaned, ['النوع', 'نوع']) !== -1;

  const matchedColumns: string[] = ['الاسم'];
  const corroboratingChecks: Array<[string, string[]]> = [
    ['كود', ['كود', 'الكود', 'code', 'Code']],
    ['الاشبين', ['الاشبين', 'الأشبين', 'الخادم', 'servant']],
    ['موبيال المخدوم', ['موبيال المخدوم', 'موبايل المخدوم', 'موبايل الطالب', 'تليفون الطالب', 'phoneStudent']],
    ['موبيل ولي الامر 1', ['موبيل ولي الامر 1', 'ولي الأمر 1', 'ولي الامر 1', 'تليفون ولي الأمر', 'phoneParent1']],
    ['موبيل ولي الامر 2', ['موبيل ولي الامر 2', 'ولي الأمر 2', 'ولي الامر 2', 'phoneParent2']],
    ['تاريخ الميلاد', ['تاريخ الميلاد', 'birthDate']],
    ['منطقة', ['منطقة', 'المنطقة', 'area']],
    ['العنوان', ['العنوان', 'address']],
    ['ملاحظات الافتقاد', ['ملاحظات الافتقاد']],
    ['آخر حضور', ['آخر حضور', 'اخر حضور', 'lastAttendance']],
    ['آخر افتقاد', ['آخر افتقاد', 'اخر افتقاد', 'lastFollowup']],
    ['حالة الافتقاد', ['حالة الافتقاد', 'followupStatus']],
    ['إجمالي الحضور', ['إجمالي الحضور', 'اجمالي الحضور', 'attendanceTotal']],
    ['حضور الشهر', ['حضور الشهر', 'attendanceMonth']]
  ];

  const strongRosterOnlyMatches: string[] = [];
  for (const [label, candidates] of corroboratingChecks) {
    if (findHeaderIndex(cleaned, candidates) !== -1) {
      matchedColumns.push(label);
      if (label !== 'كود' && label !== 'الاشبين') {
        strongRosterOnlyMatches.push(label);
      }
    }
  }

  const hasFridayColumn = cleaned.some(
    (h) => /^\d{4}-\d{2}-\d{2}$/.test(h) || /^افتقاد\s+\d{4}-\d{2}-\d{2}$/.test(h)
  );
  if (hasFridayColumn) {
    matchedColumns.push('friday_date_column');
    strongRosterOnlyMatches.push('friday_date_column');
  }

  // If the table matches the follow-up log schema without any student roster-specific columns, reject as followup_log_tab
  if (hasFollowupLogDate && (hasFollowupLogFriday || hasFollowupLogType) && strongRosterOnlyMatches.length === 0) {
    return { valid: false, reason: 'followup_log_tab', matchedColumns: [] };
  }

  // Require 'الاسم' plus at least one valid corroborating student roster column
  if (matchedColumns.length < 2) {
    return { valid: false, reason: 'insufficient_student_columns', matchedColumns };
  }

  return { valid: true, matchedColumns };
}

export interface StudentRowColumnRoles {
  identityIndices: ReadonlySet<number>;
  fridayAttIndices: ReadonlySet<number>;
  fridayFuIndices: ReadonlySet<number>;
  lastAttIdx: number;
  lastFuIdx: number;
  followupStatusIdx: number;
  numericSummaryIndices: ReadonlySet<number>;
  formulaFallbackIndices: ReadonlySet<number>;
}

const IDENTITY_HEADER_MARKERS = [
  'الاسم', 'اسم', 'name', 'كود', 'الكود', 'code',
  'الاشبين', 'الأشبين', 'اشبين', 'الخادم', 'خادم', 'servant',
  'موبيال', 'موبايل', 'تليفون', 'هاتف', 'phone', 'mobile', 'ولي',
  'ميلاد', 'birth', 'منطقة', 'منطقه', 'area', 'العنوان', 'عنوان', 'address',
  'ملاحظ', 'note', 'version', 'الإصدار', 'الاصدار'
];

const SUMMARY_FORMULA_HEADER_MARKERS = [
  'إجمالي', 'اجمالي', 'مجموع', 'نسبة', 'نسبه', 'حالة الحضور', 'حاله الحضور',
  'attendance', 'total', 'count', 'sum', 'percent', 'status'
];

const TEMPLATE_ZERO_FORMULA_VALUES = new Set([
  '0', '0.0', '0.00', '0%', '0.0%', '0.00%',
  'false', '-', '—', '–', 'none', 'null', 'n/a',
  '#n/a', '#div/0!', '#value!', '#ref!', '#num!'
]);

const TEMPLATE_ATTENDANCE_DEFAULT_VALUES = new Set([
  ...TEMPLATE_ZERO_FORMULA_VALUES,
  'بدون', 'غائب', 'لا يوجد', 'لايوجد', 'لم يحضر', 'غير محدد', 'غير مسجل', 'ابدا',
  '1899-12-30', '1899-12-31', '1900-01-00'
]);

const TEMPLATE_FOLLOWUP_DEFAULT_VALUES = new Set([
  ...TEMPLATE_ZERO_FORMULA_VALUES,
  'بدون', 'لا يوجد', 'لايوجد', 'لم يفتقد', 'غير محدد', 'غير مسجل'
]);

function buildStudentRowColumnRoles(
  headers: string[],
  known: {
    nameIdx: number;
    codeIdx: number;
    servantIdx: number;
    phoneStudentIdx: number;
    phoneParent1Idx: number;
    phoneParent2Idx: number;
    birthDateIdx: number;
    areaIdx: number;
    addressIdx: number;
    notesIdx: number;
    idIdx: number;
    versionIdx: number;
    lastAttIdx: number;
    lastFuIdx: number;
    followupColIdx: number;
    totalAttColIdx: number;
    monthAttColIdx: number;
    fridayAttCols: ReadonlyArray<{ idx: number; date: string }>;
    fridayFuCols: ReadonlyArray<{ idx: number; date: string }>;
  }
): StudentRowColumnRoles {
  const identityIndices = new Set<number>();
  const fridayAttIndices = new Set<number>(known.fridayAttCols.map((c) => c.idx));
  const fridayFuIndices = new Set<number>(known.fridayFuCols.map((c) => c.idx));
  const numericSummaryIndices = new Set<number>();
  const formulaFallbackIndices = new Set<number>();

  const explicitIdentity = [
    known.nameIdx,
    known.codeIdx,
    known.servantIdx,
    known.phoneStudentIdx,
    known.phoneParent1Idx,
    known.phoneParent2Idx,
    known.birthDateIdx,
    known.areaIdx,
    known.addressIdx,
    known.notesIdx,
    known.idIdx,
    known.versionIdx
  ];
  for (const idx of explicitIdentity) {
    if (idx >= 0) identityIndices.add(idx);
  }
  if (known.totalAttColIdx >= 0) numericSummaryIndices.add(known.totalAttColIdx);
  if (known.monthAttColIdx >= 0) numericSummaryIndices.add(known.monthAttColIdx);

  headers.forEach((rawHeader, ci) => {
    if (
      identityIndices.has(ci) ||
      fridayAttIndices.has(ci) ||
      fridayFuIndices.has(ci) ||
      ci === known.lastAttIdx ||
      ci === known.lastFuIdx ||
      ci === known.followupColIdx ||
      numericSummaryIndices.has(ci)
    ) {
      return;
    }

    const clean = cleanHeaderLabel(rawHeader);
    if (!clean) {
      // Blank-header helper column (e.g., unnamed COUNTIF/SUM formula column in Google Sheets)
      formulaFallbackIndices.add(ci);
      return;
    }

    const lower = clean.toLowerCase();
    if (
      lower === 'id' ||
      IDENTITY_HEADER_MARKERS.some((marker) => lower.includes(marker))
    ) {
      identityIndices.add(ci);
      return;
    }

    if (SUMMARY_FORMULA_HEADER_MARKERS.some((marker) => lower.includes(marker))) {
      numericSummaryIndices.add(ci);
    }
  });

  return {
    identityIndices,
    fridayAttIndices,
    fridayFuIndices,
    lastAttIdx: known.lastAttIdx,
    lastFuIdx: known.lastFuIdx,
    followupStatusIdx: known.followupColIdx,
    numericSummaryIndices,
    formulaFallbackIndices
  };
}

/**
 * Strictly classifies a nameless non-empty row as an Empty Template / Formula Row ONLY when:
 * 1. Zero student identity/profile/contact/followup cells are populated (no name, code, phone, servant, etc.).
 * 2. Zero positive attendance evidence exists (no TRUE/1/حاضر, no real date, no positive counts).
 * 3. Every remaining non-empty cell belongs to a known formula/template column AND holds an explicit
 *    zero/false/default template value (e.g. 0, FALSE, بدون, غائب, #N/A).
 * Any cell in an identity column, unrecognized named column, or with non-default/positive values returns false
 * so genuinely corrupted student rows remain strictly rejected.
 */
export function isEmptyTemplateOrFormulaRow(
  row: string[],
  headers: string[],
  roles: StudentRowColumnRoles
): boolean {
  const maxCols = Math.max(row.length, headers.length);
  for (let ci = 0; ci < maxCols; ci++) {
    const rawVal = normalizeCellValue(row[ci]);
    if (!rawVal) continue;

    // 1. Any non-empty identity/profile/contact/friday-followup cell proves a corrupted student row
    if (roles.identityIndices.has(ci) || roles.fridayFuIndices.has(ci)) {
      return false;
    }

    const asciiNorm = normalizeArabicDigits(rawVal).replace(/\s+/g, ' ').trim().toLowerCase();
    const arabicNorm = normalizeArabicText(rawVal);

    // 2. Friday attendance column: only unchecked/false template defaults allowed (NEVER positive attendance)
    if (roles.fridayAttIndices.has(ci)) {
      const attState = parseAttendanceCellState(asciiNorm);
      if (attState === false || TEMPLATE_ZERO_FORMULA_VALUES.has(asciiNorm)) {
        continue;
      }
      return false;
    }

    // 3. "آخر حضور" formula column: only known empty/default placeholders allowed (NEVER a real date)
    if (ci === roles.lastAttIdx) {
      if (
        TEMPLATE_ATTENDANCE_DEFAULT_VALUES.has(asciiNorm) ||
        TEMPLATE_ATTENDANCE_DEFAULT_VALUES.has(arabicNorm)
      ) {
        continue;
      }
      return false;
    }

    // 4. "آخر افتقاد" / "حالة الافتقاد" formula columns: only known default placeholders allowed
    if (ci === roles.lastFuIdx || ci === roles.followupStatusIdx) {
      if (
        TEMPLATE_FOLLOWUP_DEFAULT_VALUES.has(asciiNorm) ||
        TEMPLATE_FOLLOWUP_DEFAULT_VALUES.has(arabicNorm)
      ) {
        continue;
      }
      return false;
    }

    // 5. Numeric summary / attendance status formula columns: only zero/false/default values allowed
    if (roles.numericSummaryIndices.has(ci)) {
      if (
        TEMPLATE_ATTENDANCE_DEFAULT_VALUES.has(asciiNorm) ||
        TEMPLATE_ATTENDANCE_DEFAULT_VALUES.has(arabicNorm)
      ) {
        continue;
      }
      return false;
    }

    // 6. Unnamed blank-header formula helper columns (e.g. col_12 = "0"): strictly zero/false/error defaults only
    if (roles.formulaFallbackIndices.has(ci)) {
      if (TEMPLATE_ZERO_FORMULA_VALUES.has(asciiNorm)) {
        continue;
      }
      return false;
    }

    // 7. Any non-empty value in an unrecognized named column or beyond header bounds is NOT an empty template row
    return false;
  }

  return true;
}

export function parse2DRowsToStudentsDetailed(
  headers: string[],
  rows: string[][],
  sheetName: string,
  existingById?: Map<string, Student>
): ParsedStudentsDetailedResult {
  const headerValidation = validateStudentTableHeaders(headers);
  if (!headerValidation.valid) {
    return {
      students: [],
      headerValidation,
      totalNonEmptyRows: 0,
      parsedRowCount: 0,
      skippedCorruptedRowCount: 0,
      ignoredTemplateRowCount: 0,
      skippedRowErrors: [],
      isPartialParse: false,
      unkeyedRowCount: 0,
      hasVersionColumn: false
    };
  }

  const nameIdx = findHeaderIndex(headers, ['الاسم', 'name', 'Name']);
  const codeIdx = findHeaderIndex(headers, ['كود', 'الكود', 'code', 'Code']);
  const servantIdx = findHeaderIndex(headers, ['الاشبين', 'الأشبين', 'الخادم', 'servant']);
  const phoneStudentIdx = findHeaderIndex(headers, ['موبيال المخدوم', 'موبايل المخدوم', 'موبايل الطالب', 'تليفون الطالب', 'phoneStudent']);
  const phoneParent1Idx = findHeaderIndex(headers, ['موبيل ولي الامر 1', 'ولي الأمر 1', 'ولي الامر 1', 'تليفون ولي الأمر', 'phoneParent1']);
  const phoneParent2Idx = findHeaderIndex(headers, ['موبيل ولي الامر 2', 'ولي الأمر 2', 'ولي الامر 2', 'phoneParent2']);
  const birthDateIdx = findHeaderIndex(headers, ['تاريخ الميلاد', 'birthDate']);
  const areaIdx = findHeaderIndex(headers, ['منطقة', 'المنطقة', 'area']);
  const addressIdx = findHeaderIndex(headers, ['العنوان', 'address']);
  const notesIdx = findHeaderIndex(headers, ['ملاحظات الافتقاد', 'ملاحظات', 'notes']);
  const lastAttIdx = findHeaderIndex(headers, ['آخر حضور', 'اخر حضور', 'lastAttendance']);
  const lastFuIdx = findHeaderIndex(headers, ['آخر افتقاد', 'اخر افتقاد', 'lastFollowup']);
  const followupColIdx = findHeaderIndex(headers, ['حالة الافتقاد', 'followupStatus']);
  const totalAttColIdx = findHeaderIndex(headers, ['إجمالي الحضور', 'اجمالي الحضور', 'attendanceTotal']);
  const monthAttColIdx = findHeaderIndex(headers, ['حضور الشهر', 'attendanceMonth']);
  const idIdx = findHeaderIndex(headers, ['id', 'ID']);
  const versionIdx = findHeaderIndex(headers, ['version', 'الإصدار']);

  // Identify dynamic Friday attendance ("YYYY-MM-DD") and followup ("افتقاد YYYY-MM-DD") columns
  const fridayAttCols: { idx: number; date: string }[] = [];
  const fridayFuCols: { idx: number; date: string }[] = [];

  headers.forEach((h, idx) => {
    const clean = cleanHeaderLabel(h);
    const fuMatch = clean.match(/^افتقاد\s+(\d{4}-\d{2}-\d{2})$/);
    if (fuMatch) {
      fridayFuCols.push({ idx, date: fuMatch[1] });
      return;
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(clean)) {
      fridayAttCols.push({ idx, date: clean });
    }
  });

  // Compute current month prefix in Africa/Cairo
  const cairoFormatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Cairo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
  const cairoTodayIso = cairoFormatter.format(new Date());
  const currentMonthPrefix = cairoTodayIso.slice(0, 7);
  const students: Student[] = [];
  let totalNonEmptyRows = 0;
  let skippedCorruptedRowCount = 0;
  let ignoredTemplateRowCount = 0;
  let unkeyedRowCount = 0;
  const skippedRowErrors: string[] = [];
  const hasVersionColumn = versionIdx >= 0;

  const rowColumnRoles = buildStudentRowColumnRoles(headers, {
    nameIdx,
    codeIdx,
    servantIdx,
    phoneStudentIdx,
    phoneParent1Idx,
    phoneParent2Idx,
    birthDateIdx,
    areaIdx,
    addressIdx,
    notesIdx,
    idIdx,
    versionIdx,
    lastAttIdx,
    lastFuIdx,
    followupColIdx,
    totalAttColIdx,
    monthAttColIdx,
    fridayAttCols,
    fridayFuCols
  });

  // Pass 1: Scan all valid rows to verify strict uniqueness of studentCode & explicit id within this sheet
  const codeFrequency = new Map<string, number>();
  const explicitIdFrequency = new Map<string, number>();
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!Array.isArray(row) || row.every((cell) => !String(cell || '').trim())) continue;
    const name = normalizeCellValue(row[nameIdx]);
    const rawCode = codeIdx >= 0 ? normalizeCellValue(row[codeIdx]) : '';
    if ((name === 'الاسم' || name.toLowerCase() === 'name') && (!rawCode || rawCode === 'كود' || rawCode === 'الكود')) {
      continue;
    }
    if (!name || name === 'سؤال بدون عنوان') continue;
    const rawId = idIdx >= 0 ? normalizeCellValue(row[idIdx]) : '';
    if (rawId) {
      explicitIdFrequency.set(rawId, (explicitIdFrequency.get(rawId) || 0) + 1);
    }
    if (isValidStudentCode(rawCode)) {
      const normCode = normalizeStudentCodeKey(rawCode);
      codeFrequency.set(normCode, (codeFrequency.get(normCode) || 0) + 1);
    }
  }

  // Build unique local code index for this sheet to safely link legacy IDs without ever merging unkeyed records
  const existingByUniqueCode = new Map<string, Student>();
  if (existingById) {
    const localCodeCounts = new Map<string, number>();
    const localByCode = new Map<string, Student>();
    for (const s of existingById.values()) {
      if (s && s.sourceSheet === sheetName && isValidStudentCode(s.code)) {
        const nk = normalizeStudentCodeKey(s.code);
        localCodeCounts.set(nk, (localCodeCounts.get(nk) || 0) + 1);
        localByCode.set(nk, s);
      }
    }
    for (const [nk, count] of localCodeCounts.entries()) {
      if (count === 1) {
        const match = localByCode.get(nk);
        if (match) existingByUniqueCode.set(nk, match);
      }
    }
  }

  // Track unkeyed content-key collisions cleanly without relying on row index i + 1
  const unkeyedContentCounts = new Map<string, number>();

  // Pass 2: Parse students using strictly stable identity (NEVER i + 1)
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!Array.isArray(row)) {
      totalNonEmptyRows++;
      skippedCorruptedRowCount++;
      skippedRowErrors.push(`الصف ${i + 1}: بنية الصف غير صالحة (ليست مصفوفة).`);
      continue;
    }
    if (row.every((cell) => !String(cell || '').trim())) continue;

    try {
      const name = normalizeCellValue(row[nameIdx]);
      const rawCode = codeIdx >= 0 ? normalizeCellValue(row[codeIdx]) : '';

      // Repeated embedded header row inside sheet (skip cleanly without flagging corruption)
      if ((name === 'الاسم' || name.toLowerCase() === 'name') && (!rawCode || rawCode === 'كود' || rawCode === 'الكود')) {
        continue;
      }

      if (!name) {
        if (isEmptyTemplateOrFormulaRow(row, headers, rowColumnRoles)) {
          ignoredTemplateRowCount++;
          continue;
        }
        totalNonEmptyRows++;
        skippedCorruptedRowCount++;
        skippedRowErrors.push(`الصف ${i + 1}: صف غير فارغ يفتقد عمود الاسم الصالح.`);
        continue;
      }

      totalNonEmptyRows++;

      if (name === 'سؤال بدون عنوان') {
        skippedCorruptedRowCount++;
        skippedRowErrors.push(`الصف ${i + 1}: صف غير فارغ يفتقد عمود الاسم الصالح.`);
        continue;
      }

      const rawId = idIdx >= 0 ? normalizeCellValue(row[idIdx]) : '';
      const servantVal = (servantIdx >= 0 ? normalizeCellValue(row[servantIdx]) : '') || 'غير محدد';
      const phoneStudentVal = phoneStudentIdx >= 0 ? normalizeCellValue(row[phoneStudentIdx]) : '';
      const normCode = normalizeStudentCodeKey(rawCode);

      let stableId: string;
      let identityQuality: StudentIdentityQuality;
      let code: string;
      let existing: Student | undefined;

      if (rawId && explicitIdFrequency.get(rawId) === 1) {
        stableId = rawId;
        identityQuality = 'explicit_id';
        code = isValidStudentCode(rawCode) ? rawCode : rawId;
        existing = existingById?.get(stableId) || (isValidStudentCode(rawCode) && codeFrequency.get(normCode) === 1 ? existingByUniqueCode.get(normCode) : undefined);
      } else if (isValidStudentCode(rawCode) && codeFrequency.get(normCode) === 1) {
        stableId = buildStableStudentIdFromCode(sheetName, rawCode);
        identityQuality = 'stable_code';
        code = rawCode;
        existing = existingById?.get(stableId) || existingByUniqueCode.get(normCode);
      } else {
        // Missing, invalid, or duplicate studentCode: NEVER fabricate SG-${i+1} or merge automatically!
        unkeyedRowCount++;
        identityQuality = 'unkeyed';
        code = rawCode || '';
        const baseContentKey = `${normalizeArabicText(name)}|${normalizeArabicDigits(phoneStudentVal).replace(/\D+/g, '')}|${normalizeArabicText(servantVal)}`;
        const occ = unkeyedContentCounts.get(baseContentKey) || 0;
        unkeyedContentCounts.set(baseContentKey, occ + 1);
        stableId = buildUnkeyedStudentId(sheetName, name, phoneStudentVal, servantVal, occ);
        // Only link if exact unkeyed ID already exists (never fuzzy-merge into another student!)
        existing = existingById?.get(stableId);
      }

      const att: Record<string, boolean> = { ...(existing?.att || {}) };
      let totalCount = 0;
      let monthCount = 0;
      let latestAttDate = lastAttIdx >= 0 ? normalizeCellValue(row[lastAttIdx]) : '';

      for (const col of fridayAttCols) {
        const state = parseAttendanceCellState(normalizeCellValue(row[col.idx]));
        if (state === true) {
          att[col.date] = true;
          totalCount++;
          if (col.date.startsWith(currentMonthPrefix) && col.date <= cairoTodayIso) {
            monthCount++;
          }
          if (!latestAttDate || col.date > latestAttDate) {
            latestAttDate = col.date;
          }
        } else if (state === false) {
          att[col.date] = false;
        }
      }

      const fu: Record<string, string> = { ...(existing?.fu || {}) };
      const fuOutcomes: Record<string, 'تم التواصل' | 'لم يتم التواصل'> = { ...(existing?.fuOutcomes || {}) };
      let latestFuMethod = followupColIdx >= 0 ? normalizeCellValue(row[followupColIdx]) : '';
      let latestFuDate = lastFuIdx >= 0 ? normalizeCellValue(row[lastFuIdx]) : '';
      let latestCallOutcome = existing?.lastCallOutcome;

      for (const col of fridayFuCols) {
        const fuVal = normalizeCellValue(row[col.idx]);
        if (fuVal && fuVal !== 'بدون') {
          fu[col.date] = fuVal;
          const parsedOutcome = extractFollowupCallOutcome(fuVal);
          if (parsedOutcome) {
            fuOutcomes[col.date] = parsedOutcome;
          }
          if (!latestFuDate || col.date >= latestFuDate) {
            latestFuDate = col.date;
            latestFuMethod = fuVal;
            if (parsedOutcome) latestCallOutcome = parsedOutcome;
          }
        }
      }

      const rawNotes = notesIdx >= 0 ? normalizeCellValue(row[notesIdx]) : '';
      const isShortFollowupToken = ['بدون', 'تم تليفونياً', 'تم بزيارة', 'واتساب', 'رسالة نصية'].includes(rawNotes);
      const derivedFollowupStatus = latestFuMethod || (isShortFollowupToken ? rawNotes : 'بدون');
      const cleanNotes = isShortFollowupToken && rawNotes === 'بدون' ? '' : rawNotes;

      const parsedTotal = totalAttColIdx >= 0 ? parseInt(normalizeCellValue(row[totalAttColIdx]) || '0', 10) : NaN;
      const parsedMonth = monthAttColIdx >= 0 ? parseInt(normalizeCellValue(row[monthAttColIdx]) || '0', 10) : NaN;
      const attendanceTotal = !isNaN(parsedTotal) && totalAttColIdx >= 0 ? Math.max(parsedTotal, totalCount) : totalCount;
      const attendanceMonth = !isNaN(parsedMonth) && monthAttColIdx >= 0 ? Math.max(parsedMonth, monthCount) : monthCount;

      const latestFridayCol = fridayAttCols.length > 0 ? fridayAttCols[fridayAttCols.length - 1].date : '';
      const isPresentLatest = latestFridayCol ? att[latestFridayCol] === true : Boolean(latestAttDate);

      // Phase 4.2.1 Version Provenance: NEVER copy existing.version as if it came from the remote source!
      const rawVersionVal = hasVersionColumn ? parseInt(normalizeCellValue(row[versionIdx]) || '', 10) : NaN;
      const hasAuthoritativeRemoteVersion = hasVersionColumn && Number.isFinite(rawVersionVal) && rawVersionVal >= 1;
      const remoteVersion = hasAuthoritativeRemoteVersion ? rawVersionVal : 1;

      students.push({
        id: stableId,
        code,
        name,
        servant: servantVal,
        phoneStudent: phoneStudentVal,
        phoneParent1: phoneParent1Idx >= 0 ? normalizeCellValue(row[phoneParent1Idx]) : '',
        phoneParent2: phoneParent2Idx >= 0 ? normalizeCellValue(row[phoneParent2Idx]) : '',
        birthDate: birthDateIdx >= 0 ? normalizeCellValue(row[birthDateIdx]) : '',
        area: (areaIdx >= 0 ? normalizeCellValue(row[areaIdx]) : '') || 'غير محددة',
        address: addressIdx >= 0 ? normalizeCellValue(row[addressIdx]) : '',
        notes: cleanNotes,
        followupStatus: derivedFollowupStatus || 'بدون',
        attendanceTotal,
        attendanceMonth,
        attendanceStatus: isPresentLatest ? 'حاضر' : 'غائب',
        lastAttendance: latestAttDate || undefined,
        lastFollowup: latestFuDate || undefined,
        sourceSheet: sheetName,
        version: remoteVersion,
        hasRemoteVersion: hasAuthoritativeRemoteVersion,
        identityQuality,
        att,
        fu,
        ...(Object.keys(fuOutcomes).length > 0 ? { fuOutcomes } : {}),
        ...(latestCallOutcome ? { lastCallOutcome: latestCallOutcome } : {})
      });
    } catch (err: any) {
      skippedCorruptedRowCount++;
      skippedRowErrors.push(`الصف ${i + 1}: ${err?.message || 'خطأ غير متوقع أثناء التحليل'}`);
    }
  }

  return {
    students,
    headerValidation,
    totalNonEmptyRows,
    parsedRowCount: students.length,
    skippedCorruptedRowCount,
    ignoredTemplateRowCount,
    skippedRowErrors,
    isPartialParse: skippedCorruptedRowCount > 0,
    unkeyedRowCount,
    hasVersionColumn
  };
}

export function parse2DRowsToStudents(
  headers: string[],
  rows: string[][],
  sheetName: string,
  existingById?: Map<string, Student>
): Student[] {
  return parse2DRowsToStudentsDetailed(headers, rows, sheetName, existingById).students;
}

interface ExtractedGvizTable {
  headers: string[];
  dataRows: string[][];
  sig?: string;
  malformedRowCount: number;
  hasWarnings: boolean;
  warningMessages: string[];
  tableFingerprint: string;
}

// Full-table deterministic 64-bit content hash over ALL headers AND ALL rows (never limited to first/last row)
export function computeGvizTableFingerprint(headers: string[], dataRows: string[][]): string {
  const cleanHeaders = headers.map(cleanHeaderLabel).join('\u001f');
  const headerHash = computeDualFnv1aHex(cleanHeaders);
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let r = 0; r < dataRows.length; r++) {
    const row = dataRows[r] || [];
    const serialized = row.map((v) => String(v || '').trim()).join('\u001f');
    for (let i = 0; i < serialized.length; i++) {
      const ch = serialized.charCodeAt(i);
      h1 ^= ch;
      h1 = Math.imul(h1, 0x01000193);
      h2 ^= ch ^ ((r + i) & 0xff);
      h2 = Math.imul(h2, 0x01000193);
    }
    // Row delimiter
    h1 ^= 0x1e;
    h1 = Math.imul(h1, 0x01000193);
    h2 ^= 0x1e;
    h2 = Math.imul(h2, 0x01000193);
  }
  const rowsHash = `${(h1 >>> 0).toString(16).padStart(8, '0')}${(h2 >>> 0).toString(16).padStart(8, '0')}`;
  return `h:${headerHash}::c:${headers.length}::n:${dataRows.length}::rows:${rowsHash}`;
}

function extractGvizTableDetailed(gvizText: string, sheetName: string): ExtractedGvizTable {
  const match = gvizText.match(/google\.visualization\.Query\.setResponse\(([\s\S]*)\);?/);
  if (!match) {
    throw new Error(`تعذر قراءة استجابة Google Sheets لفصل (${sheetName}): استجابة غير صالحة أو الشيت غير متاح.`);
  }

  let parsed: any;
  try {
    parsed = JSON.parse(match[1]);
  } catch {
    throw new Error(`تعذر تحليل JSON من استجابة Google Sheets لفصل (${sheetName}).`);
  }

  if (parsed.status !== 'ok' || !parsed.table || !Array.isArray(parsed.table.cols) || !Array.isArray(parsed.table.rows)) {
    const errMsg = parsed?.errors?.[0]?.detailed_message || parsed?.errors?.[0]?.message || 'خطأ في قراءة Google Sheets';
    throw new Error(`تعذر تحميل البيانات من Google Sheets (${sheetName}): ${errMsg}`);
  }

  const warningMessages: string[] = [];
  if (Array.isArray(parsed.warnings) && parsed.warnings.length > 0) {
    for (const w of parsed.warnings) {
      warningMessages.push(String(w?.detailed_message || w?.message || w?.reason || 'تحذير في استجابة Gviz'));
    }
  }
  if (Array.isArray(parsed.errors) && parsed.errors.length > 0) {
    for (const e of parsed.errors) {
      warningMessages.push(String(e?.detailed_message || e?.message || e?.reason || 'خطأ جزئي في استجابة Gviz'));
    }
  }

  const cols: any[] = parsed.table.cols;
  const rawRows: any[] = parsed.table.rows;
  let malformedRowCount = 0;

  for (const r of rawRows) {
    if (r !== null && (typeof r !== 'object' || !Array.isArray(r.c))) {
      malformedRowCount++;
    }
  }

  const validRawRows = rawRows.filter((r) => r && typeof r === 'object' && Array.isArray(r.c));
  const maxColCount = Math.max(
    cols.length,
    ...validRawRows.map((r) => r.c.length),
    0
  );

  const extractRowValues = (r: any): string[] => {
    const cells = r?.c || [];
    const out: string[] = [];
    for (let idx = 0; idx < maxColCount; idx++) {
      const cell = cells[idx];
      if (!cell) {
        out.push('');
      } else if (cell.f !== undefined && cell.f !== null && String(cell.f).trim() !== '') {
        out.push(String(cell.f).trim());
      } else {
        out.push(normalizeCellValue(cell.v));
      }
    }
    return out;
  };

  const colLabels = cols.map((c) => cleanHeaderLabel(c?.label || ''));
  const labelsContainHeader = colLabels.some(
    (l) => l === 'الاسم' || l.toLowerCase() === 'name' || l === 'أسبوع الجمعة' || l === 'التاريخ'
  );

  let headers: string[] = [];
  let dataRows: string[][] = [];

  if (labelsContainHeader) {
    headers = colLabels;
    dataRows = validRawRows.map(extractRowValues);
  } else if (validRawRows.length > 0) {
    headers = extractRowValues(validRawRows[0]);
    dataRows = validRawRows.slice(1).map(extractRowValues);
  } else if (colLabels.some((l) => l.length > 0)) {
    headers = colLabels;
    dataRows = [];
  }

  const sig = typeof parsed.sig === 'string' && parsed.sig.trim() ? parsed.sig.trim() : undefined;
  return {
    headers,
    dataRows,
    sig,
    malformedRowCount,
    hasWarnings: warningMessages.length > 0,
    warningMessages,
    tableFingerprint: computeGvizTableFingerprint(headers, dataRows)
  };
}

export interface ParsedGvizStudentsResponse extends ParsedStudentsDetailedResult {
  sig?: string;
  malformedGvizRowCount: number;
  hasWarnings: boolean;
  warningMessages: string[];
  tableFingerprint: string;
}

export function parseGoogleVisualizationResponseDetailed(
  gvizText: string,
  sheetName: string,
  existingById?: Map<string, Student>
): ParsedGvizStudentsResponse {
  const extracted = extractGvizTableDetailed(gvizText, sheetName);
  const parsed = parse2DRowsToStudentsDetailed(extracted.headers, extracted.dataRows, sheetName, existingById);
  const isPartialParse = parsed.isPartialParse || extracted.malformedRowCount > 0 || extracted.hasWarnings;
  return {
    ...parsed,
    isPartialParse,
    sig: extracted.sig,
    malformedGvizRowCount: extracted.malformedRowCount,
    hasWarnings: extracted.hasWarnings,
    warningMessages: extracted.warningMessages,
    tableFingerprint: extracted.tableFingerprint
  };
}

export function parseGoogleVisualizationResponse(
  gvizText: string,
  sheetName: string,
  existingById?: Map<string, Student>
): Student[] {
  const result = parseGoogleVisualizationResponseDetailed(gvizText, sheetName, existingById);
  return result.students;
}

export interface FollowupLogFetchResult {
  records: FollowupRecord[];
  verified: boolean;
  isComplete: boolean;
  isPartialParse: boolean;
  reason?: string;
  totalNonEmptyRows: number;
  parsedRowCount: number;
  skippedCorruptedRowCount: number;
  sig?: string;
  tableFingerprint?: string;
}

export function parseGoogleVisualizationFollowupLogDetailed(
  gvizText: string,
  studentsByCodeOrName?: Map<string, Student>
): FollowupLogFetchResult {
  const extracted = extractGvizTableDetailed(gvizText, 'سجل الافتقاد');
  const { headers, dataRows } = extracted;
  if (headers.length === 0) {
    return {
      records: [],
      verified: false,
      isComplete: false,
      isPartialParse: false,
      reason: 'empty_headers',
      totalNonEmptyRows: 0,
      parsedRowCount: 0,
      skippedCorruptedRowCount: 0,
      sig: extracted.sig,
      tableFingerprint: extracted.tableFingerprint
    };
  }

  // Reject Google Forms fallback responses so they can never pollute followup logs
  const lowerHeaders = headers.map((h) => cleanHeaderLabel(h).toLowerCase());
  if (FORM_RESPONSE_HEADER_MARKERS.some((m) => lowerHeaders.some((h) => h === m || h.includes(m)))) {
    return {
      records: [],
      verified: false,
      isComplete: false,
      isPartialParse: false,
      reason: 'form_responses_tab',
      totalNonEmptyRows: 0,
      parsedRowCount: 0,
      skippedCorruptedRowCount: 0,
      sig: extracted.sig,
      tableFingerprint: extracted.tableFingerprint
    };
  }

  const dateIdx = findHeaderIndex(headers, ['التاريخ']);
  const fridayIdx = findHeaderIndex(headers, ['أسبوع الجمعة', 'الجمعة']);
  const codeIdx = findHeaderIndex(headers, ['الكود', 'كود', 'code']);
  const nameIdx = findHeaderIndex(headers, ['الاسم', 'name']);
  const servantIdx = findHeaderIndex(headers, ['الأشبين', 'الاشبين', 'الخادم']);
  const typeIdx = findHeaderIndex(headers, ['النوع', 'نوع']);
  const outcomeIdx = findHeaderIndex(headers, ['نتيجة الاتصال', 'نتيجه الاتصال', 'callOutcome', 'النتيجة']);
  const notesIdx = findHeaderIndex(headers, ['ملاحظات', 'ملا حظات']);

  if (nameIdx === -1 || (dateIdx === -1 && fridayIdx === -1 && typeIdx === -1)) {
    return {
      records: [],
      verified: false,
      isComplete: false,
      isPartialParse: false,
      reason: 'incompatible_followup_headers',
      totalNonEmptyRows: 0,
      parsedRowCount: 0,
      skippedCorruptedRowCount: 0,
      sig: extracted.sig,
      tableFingerprint: extracted.tableFingerprint
    };
  }

  const normNameLookup = new Map<string, Student>();
  if (studentsByCodeOrName) {
    for (const s of studentsByCodeOrName.values()) {
      const nn = normalizeArabicText(s.name);
      if (nn && !normNameLookup.has(nn)) normNameLookup.set(nn, s);
    }
  }

  const records: FollowupRecord[] = [];
  let totalNonEmptyRows = 0;
  let skippedCorruptedRowCount = 0;

  for (let i = 0; i < dataRows.length; i++) {
    const row = dataRows[i];
    if (!Array.isArray(row)) {
      totalNonEmptyRows++;
      skippedCorruptedRowCount++;
      continue;
    }
    if (row.every((cell) => !String(cell || '').trim())) continue;

    try {
      const studentName = nameIdx >= 0 ? normalizeCellValue(row[nameIdx]) : '';
      const studentCode = codeIdx >= 0 ? normalizeCellValue(row[codeIdx]) : '';
      const dateVal = dateIdx >= 0 ? normalizeCellValue(row[dateIdx]) : '';
      const fridayVal = fridayIdx >= 0 ? normalizeCellValue(row[fridayIdx]) : '';
      const typeVal = (typeIdx >= 0 ? normalizeCellValue(row[typeIdx]) : '') || 'بدون';
      const notesVal = notesIdx >= 0 ? normalizeCellValue(row[notesIdx]) : '';

      // Embedded repeated header row inside sheet
      if (studentName === 'الاسم' && (!dateVal || dateVal === 'التاريخ')) continue;

      totalNonEmptyRows++;

      if (!studentName && !studentCode) {
        // Non-empty followup row containing data without any student identity => corrupted/partial
        if (dateVal || fridayVal || (typeVal && typeVal !== 'بدون') || notesVal) {
          skippedCorruptedRowCount++;
        }
        continue;
      }

      // Skip rows that have neither date nor followup method (empty template rows)
      if (!dateVal && (!typeVal || typeVal === 'بدون')) continue;

      const normStudentName = normalizeArabicText(studentName);
      const linked: Student | undefined =
        (studentCode ? studentsByCodeOrName?.get(studentCode) : undefined) ||
        (studentName ? studentsByCodeOrName?.get(studentName) : undefined) ||
        (normStudentName ? studentsByCodeOrName?.get(normStudentName) || normNameLookup.get(normStudentName) : undefined);
      const servant = (servantIdx >= 0 ? normalizeCellValue(row[servantIdx]) : '') || linked?.servant || 'غير محدد';
      const rawOutcome = outcomeIdx >= 0 ? normalizeCellValue(row[outcomeIdx]) : '';
      const callOutcome: CallOutcome | undefined = extractFollowupCallOutcome(typeVal, rawOutcome);

      const stableKey = computeDualFnv1aHex(
        `${normalizeStudentCodeKey(studentCode)}|${normStudentName}|${dateVal}|${fridayVal}|${typeVal}|${notesVal}`
      );
      records.push({
        id: `gs_fu_${stableKey}`,
        date: dateVal || fridayVal || '-',
        fridayDate: fridayVal || dateVal || '-',
        studentId: linked?.id || studentCode || studentName,
        studentCode: studentCode || linked?.code || '',
        studentName: studentName || linked?.name || '',
        servant,
        type: typeVal,
        ...(callOutcome ? { callOutcome } : {}),
        notes: notesVal
      });
    } catch {
      skippedCorruptedRowCount++;
    }
  }

  const sorted = records.reverse().sort((a, b) => {
    const da = /^\d{4}-\d{2}-\d{2}$/.test(a.date) ? a.date : '';
    const db = /^\d{4}-\d{2}-\d{2}$/.test(b.date) ? b.date : '';
    return db.localeCompare(da);
  });

  const isPartialParse =
    skippedCorruptedRowCount > 0 || extracted.malformedRowCount > 0 || extracted.hasWarnings;

  return {
    records: isPartialParse ? [] : sorted,
    verified: !isPartialParse,
    isComplete: !isPartialParse,
    isPartialParse,
    ...(isPartialParse ? { reason: 'partial_parse_failure' } : {}),
    totalNonEmptyRows,
    parsedRowCount: sorted.length,
    skippedCorruptedRowCount: skippedCorruptedRowCount + extracted.malformedRowCount,
    sig: extracted.sig,
    tableFingerprint: extracted.tableFingerprint
  };
}

export function parseGoogleVisualizationFollowupLog(
  gvizText: string,
  studentsByCodeOrName?: Map<string, Student>
): FollowupRecord[] {
  const result = parseGoogleVisualizationFollowupLogDetailed(gvizText, studentsByCodeOrName);
  return result.verified && result.isComplete ? result.records : [];
}

export type GvizFallbackProbeStatus = 'fallback_active' | 'explicit_error' | 'probe_failed';

export interface DefaultSheetFallbackProbe {
  status: GvizFallbackProbeStatus;
  sig?: string;
  tableFingerprint?: string;
  reason?: string;
}

export interface GvizFetchResult {
  students: Student[];
  confirmedSheets: string[];
  confirmedEmptySheets: string[];
  unverifiedSheets: string[];
  failedSheets: string[];
  sheetsMeta: Record<string, GvizSheetMeta>;
  fallbackProbe: DefaultSheetFallbackProbe;
}

export async function probeGvizDefaultFallback(spreadsheetId: string): Promise<DefaultSheetFallbackProbe> {
  try {
    const probeUrl = `https://docs.google.com/spreadsheets/d/${spreadsheetId}/gviz/tq?tqx=out:json&sheet=${encodeURIComponent(NONEXISTENT_SHEET_PROBE_NAME)}&t=${Date.now()}`;
    const res = await fetch(probeUrl, { method: 'GET' });
    if (res.status === 400 || res.status === 404) {
      return { status: 'explicit_error', reason: `HTTP ${res.status}` };
    }
    if (!res.ok) {
      return { status: 'probe_failed', reason: `HTTP ${res.status}` };
    }
    const text = await res.text();
    const match = text.match(/google\.visualization\.Query\.setResponse\(([\s\S]*)\);?/);
    if (!match) {
      return { status: 'probe_failed', reason: 'invalid_probe_response' };
    }
    let parsed: any;
    try {
      parsed = JSON.parse(match[1]);
    } catch {
      return { status: 'probe_failed', reason: 'invalid_probe_json' };
    }
    if (parsed.status === 'error') {
      return { status: 'explicit_error', reason: parsed?.errors?.[0]?.message || 'gviz_error' };
    }
    const extracted = extractGvizTableDetailed(text, NONEXISTENT_SHEET_PROBE_NAME);
    return {
      status: 'fallback_active',
      sig: extracted.sig,
      tableFingerprint: extracted.tableFingerprint
    };
  } catch (err: any) {
    // Network / timeout / transport failure -> Fail-Closed! Never assume fallback is inactive.
    return {
      status: 'probe_failed',
      reason: err?.message || 'probe_network_error'
    };
  }
}

export function matchesDefaultFallbackProbe(
  response: { sig?: string; tableFingerprint?: string },
  probe: DefaultSheetFallbackProbe
): boolean {
  if (probe.status !== 'fallback_active') return false;
  // When BOTH responses carry Google Gviz's server-computed `sig`:
  // - Same sig => identical table (silent fallback!)
  // - Different sig => GUARANTEED distinct table (never reject due to fingerprint similarity!)
  if (probe.sig && response.sig) {
    return response.sig === probe.sig;
  }
  // Only when `sig` is unavailable on at least one side, compare the FULL-table hash (all headers + all rows)
  return Boolean(probe.tableFingerprint && response.tableFingerprint && response.tableFingerprint === probe.tableFingerprint);
}

export async function fetchFollowupLogViaGvizDetailed(
  spreadsheetId: string,
  students: Student[] = [],
  existingProbe?: DefaultSheetFallbackProbe
): Promise<FollowupLogFetchResult> {
  const probe = existingProbe || (await probeGvizDefaultFallback(spreadsheetId));
  if (probe.status === 'probe_failed') {
    return {
      records: [],
      verified: false,
      isComplete: false,
      isPartialParse: false,
      reason: 'probe_failed_fail_closed',
      totalNonEmptyRows: 0,
      parsedRowCount: 0,
      skippedCorruptedRowCount: 0
    };
  }

  const url = `https://docs.google.com/spreadsheets/d/${spreadsheetId}/gviz/tq?tqx=out:json&sheet=${encodeURIComponent('سجل الافتقاد')}&t=${Date.now()}`;
  let res: Response;
  try {
    res = await fetch(url, { method: 'GET' });
  } catch (err: any) {
    return {
      records: [],
      verified: false,
      isComplete: false,
      isPartialParse: false,
      reason: err?.message || 'network_error',
      totalNonEmptyRows: 0,
      parsedRowCount: 0,
      skippedCorruptedRowCount: 0
    };
  }
  if (!res.ok) {
    return {
      records: [],
      verified: false,
      isComplete: false,
      isPartialParse: false,
      reason: `HTTP ${res.status}`,
      totalNonEmptyRows: 0,
      parsedRowCount: 0,
      skippedCorruptedRowCount: 0
    };
  }

  let text: string;
  try {
    text = await res.text();
  } catch (err: any) {
    return {
      records: [],
      verified: false,
      isComplete: false,
      isPartialParse: false,
      reason: err?.message || 'read_error',
      totalNonEmptyRows: 0,
      parsedRowCount: 0,
      skippedCorruptedRowCount: 0
    };
  }

  const lookup = new Map<string, Student>();
  students.forEach((s) => {
    if (s.code) lookup.set(s.code.trim(), s);
    if (s.name) {
      lookup.set(s.name.trim(), s);
      const nn = normalizeArabicText(s.name);
      if (nn && !lookup.has(nn)) lookup.set(nn, s);
    }
  });

  let detailed: FollowupLogFetchResult;
  try {
    detailed = parseGoogleVisualizationFollowupLogDetailed(text, lookup);
  } catch (err: any) {
    return {
      records: [],
      verified: false,
      isComplete: false,
      isPartialParse: false,
      reason: err?.message || 'parse_error',
      totalNonEmptyRows: 0,
      parsedRowCount: 0,
      skippedCorruptedRowCount: 0
    };
  }

  if (matchesDefaultFallbackProbe(detailed, probe)) {
    return {
      ...detailed,
      records: [],
      verified: false,
      isComplete: false,
      reason: 'default_sheet_fallback'
    };
  }

  return detailed;
}

export async function fetchFollowupLogViaGviz(
  spreadsheetId: string,
  students: Student[] = [],
  existingProbe?: DefaultSheetFallbackProbe
): Promise<FollowupRecord[]> {
  const res = await fetchFollowupLogViaGvizDetailed(spreadsheetId, students, existingProbe);
  return res.verified && res.isComplete ? res.records : [];
}

export function getRemoteGvizCandidatesForSheet(canonicalSheetName: string): string[] {
  const mapped = REMOTE_SHEET_GVIZ_CANDIDATES[canonicalSheetName];
  if (mapped && mapped.length > 0) {
    return [...mapped];
  }
  return [canonicalSheetName];
}

export async function fetchSheetStudentsViaGviz(
  spreadsheetId: string,
  targetSheet: string,
  existingById?: Map<string, Student>
): Promise<GvizFetchResult> {
  const cleanedTarget = String(targetSheet || '').trim();
  const safeTarget =
    !cleanedTarget ||
    cleanedTarget.toLowerCase() === 'undefined' ||
    cleanedTarget.toLowerCase() === 'null'
      ? ALL_SHEETS_SENTINEL
      : cleanedTarget;
  if (safeTarget !== ALL_SHEETS_SENTINEL && !STUDENT_CLASSIFICATION_OPTIONS.includes(safeTarget as any)) {
    throw new Error(`اسم التاب غير معتمد في Google Sheets: "${safeTarget}"`);
  }

  const sheetsToRead = safeTarget === ALL_SHEETS_SENTINEL ? [...LIVE_GOOGLE_SHEET_TABS] : [safeTarget];
  const allStudents: Student[] = [];
  const confirmedSheets: string[] = [];
  const confirmedEmptySheets: string[] = [];
  const unverifiedSheets: string[] = [];
  const failedSheets: string[] = [];
  const sheetsMeta: Record<string, GvizSheetMeta> = {};

  // Capture Gviz's default-sheet fallback fingerprint once per pull.
  // Phase 4.2.1 Fail-Closed policy: if probe itself fails due to network/transport outage,
  // tab identity cannot be proven, so refuse to accept ANY tab and preserve all local data.
  const fallbackProbe = await probeGvizDefaultFallback(spreadsheetId);
  if (fallbackProbe.status === 'probe_failed') {
    for (const canonicalSheetName of sheetsToRead) {
      sheetsMeta[canonicalSheetName] = {
        isComplete: false,
        verified: false,
        status: 'failed',
        reason: `probe_failed_fail_closed${fallbackProbe.reason ? `: ${fallbackProbe.reason}` : ''}`
      };
      failedSheets.push(canonicalSheetName);
    }
    return {
      students: [],
      confirmedSheets,
      confirmedEmptySheets,
      unverifiedSheets,
      failedSheets,
      sheetsMeta,
      fallbackProbe
    };
  }

  for (const canonicalSheetName of sheetsToRead) {
    const remoteCandidates = getRemoteGvizCandidatesForSheet(canonicalSheetName);
    let resolvedMeta: GvizSheetMeta | null = null;
    let resolvedStudents: Student[] | null = null;
    let lastRejectionReason = 'unverified_response';
    let hadTransportOrHttpFailure = false;

    for (const remoteSheetName of remoteCandidates) {
      const url = `https://docs.google.com/spreadsheets/d/${spreadsheetId}/gviz/tq?tqx=out:json&sheet=${encodeURIComponent(remoteSheetName)}&t=${Date.now()}`;
      let res: Response;
      try {
        res = await fetch(url, { method: 'GET' });
      } catch (netErr: any) {
        hadTransportOrHttpFailure = true;
        lastRejectionReason = netErr?.message || `فشل الاتصال بقراءة تاب "${canonicalSheetName}"`;
        continue;
      }

      if (!res.ok) {
        hadTransportOrHttpFailure = true;
        lastRejectionReason = `HTTP ${res.status} أثناء قراءة تاب "${canonicalSheetName}"`;
        continue;
      }

      let parsedDetailed: ParsedGvizStudentsResponse;
      try {
        const text = await res.text();
        parsedDetailed = parseGoogleVisualizationResponseDetailed(text, canonicalSheetName, existingById);
      } catch (parseErr: any) {
        hadTransportOrHttpFailure = true;
        lastRejectionReason = parseErr?.message || `فشل تحليل استجابة Gviz لتاب "${canonicalSheetName}"`;
        continue;
      }

      // Guard A: Detect silent Gviz fallback to spreadsheet's default first tab (sig-first + full-table hash)
      if (matchesDefaultFallbackProbe(parsedDetailed, fallbackProbe)) {
        lastRejectionReason = 'default_sheet_fallback';
        continue;
      }

      // Guard B: Strictly validate student table header structure (distinguishes valid empty sheet from form/unknown tab)
      if (!parsedDetailed.headerValidation.valid) {
        lastRejectionReason = parsedDetailed.headerValidation.reason || 'incompatible_header';
        continue;
      }

      // Guard C: Reject partial/corrupted parsing — never mark as Complete
      if (parsedDetailed.isPartialParse) {
        resolvedMeta = {
          isComplete: false,
          verified: false,
          status: 'unverified',
          resolvedRemoteSheetName: remoteSheetName,
          reason: 'partial_parse_failure',
          parsedRowCount: parsedDetailed.parsedRowCount,
          skippedCorruptedRowCount:
            parsedDetailed.skippedCorruptedRowCount + parsedDetailed.malformedGvizRowCount
        };
        resolvedStudents = null;
        break;
      }

      // Verified & Complete!
      resolvedMeta = {
        isComplete: true,
        verified: true,
        status: 'verified',
        resolvedRemoteSheetName: remoteSheetName,
        parsedRowCount: parsedDetailed.parsedRowCount,
        skippedCorruptedRowCount: 0
      };
      resolvedStudents = parsedDetailed.students;
      break;
    }

    if (resolvedMeta && resolvedMeta.verified && resolvedMeta.isComplete && resolvedStudents !== null) {
      allStudents.push(...resolvedStudents);
      confirmedSheets.push(canonicalSheetName);
      sheetsMeta[canonicalSheetName] = resolvedMeta;
      if (resolvedStudents.length === 0) {
        confirmedEmptySheets.push(canonicalSheetName);
      }
    } else if (resolvedMeta) {
      // Partial parse or explicit unverified state
      sheetsMeta[canonicalSheetName] = resolvedMeta;
      unverifiedSheets.push(canonicalSheetName);
    } else {
      const status: GvizSheetVerificationStatus = hadTransportOrHttpFailure ? 'failed' : 'unverified';
      sheetsMeta[canonicalSheetName] = {
        isComplete: false,
        verified: false,
        status,
        reason: lastRejectionReason
      };
      if (status === 'failed') {
        failedSheets.push(canonicalSheetName);
      } else {
        unverifiedSheets.push(canonicalSheetName);
      }
    }
  }

  return {
    students: allStudents,
    confirmedSheets,
    confirmedEmptySheets,
    unverifiedSheets,
    failedSheets,
    sheetsMeta,
    fallbackProbe
  };
}

