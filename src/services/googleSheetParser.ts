import { Student, APPROVED_SHEETS, ALL_SHEETS_SENTINEL } from '../types/student';
import { FollowupRecord } from '../types/followup';

export const DEFAULT_SPREADSHEET_ID = '15Nda4pGb3WdAfOuRTwRS9Fx822_EORgumOmhZcjTVt0';

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

export function parse2DRowsToStudents(
  headers: string[],
  rows: string[][],
  sheetName: string,
  existingById?: Map<string, Student>
): Student[] {
  const nameIdx = findHeaderIndex(headers, ['الاسم', 'name', 'Name']);
  if (nameIdx === -1) {
    // Empty or placeholder form tab (e.g. only "سؤال بدون عنوان")
    return [];
  }

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
    const clean = h.trim();
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

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!row || row.every((cell) => !String(cell || '').trim())) continue;

    const name = normalizeCellValue(row[nameIdx]);
    if (!name || name === 'الاسم' || name === 'سؤال بدون عنوان') continue;

    const code = (codeIdx >= 0 ? normalizeCellValue(row[codeIdx]) : '') || `SG-${i + 1}`;
    const rawId = idIdx >= 0 ? normalizeCellValue(row[idIdx]) : '';
    const deterministicId = rawId || `gs_${sheetName}_${code}_${i + 1}`.replace(/\s+/g, '_');
    const existing = existingById?.get(deterministicId);

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
    let latestFuMethod = followupColIdx >= 0 ? normalizeCellValue(row[followupColIdx]) : '';
    let latestFuDate = lastFuIdx >= 0 ? normalizeCellValue(row[lastFuIdx]) : '';

    for (const col of fridayFuCols) {
      const fuVal = normalizeCellValue(row[col.idx]);
      if (fuVal && fuVal !== 'بدون') {
        fu[col.date] = fuVal;
        if (!latestFuDate || col.date >= latestFuDate) {
          latestFuDate = col.date;
          latestFuMethod = fuVal;
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

    students.push({
      id: deterministicId,
      code,
      name,
      servant: (servantIdx >= 0 ? normalizeCellValue(row[servantIdx]) : '') || 'غير محدد',
      phoneStudent: phoneStudentIdx >= 0 ? normalizeCellValue(row[phoneStudentIdx]) : '',
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
      version: versionIdx >= 0 ? parseInt(normalizeCellValue(row[versionIdx]) || '1', 10) || 1 : (existing?.version || 1),
      att,
      fu
    });
  }

  return students;
}

function extractGvizTable(gvizText: string, sheetName: string): { headers: string[]; dataRows: string[][] } {
  const match = gvizText.match(/google\.visualization\.Query\.setResponse\(([\s\S]*)\);?/);
  if (!match) {
    throw new Error(`تعذر قراءة استجابة Google Sheets لفصل (${sheetName}): استجابة غير صالحة أو الشيت غير متاح.`);
  }

  const parsed = JSON.parse(match[1]);
  if (parsed.status !== 'ok' || !parsed.table) {
    const errMsg = parsed?.errors?.[0]?.detailed_message || parsed?.errors?.[0]?.message || 'خطأ في قراءة Google Sheets';
    throw new Error(`تعذر تحميل البيانات من Google Sheets (${sheetName}): ${errMsg}`);
  }

  const cols: any[] = parsed.table.cols || [];
  const rawRows: any[] = parsed.table.rows || [];
  const maxColCount = Math.max(
    cols.length,
    ...rawRows.map((r) => (Array.isArray(r?.c) ? r.c.length : 0)),
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

  const colLabels = cols.map((c) => String(c?.label || '').trim());
  const labelsContainHeader = colLabels.some(
    (l) => l === 'الاسم' || l.toLowerCase() === 'name' || l === 'أسبوع الجمعة' || l === 'التاريخ'
  );

  if (labelsContainHeader) {
    return {
      headers: colLabels,
      dataRows: rawRows.map(extractRowValues)
    };
  }
  if (rawRows.length > 0) {
    return {
      headers: extractRowValues(rawRows[0]),
      dataRows: rawRows.slice(1).map(extractRowValues)
    };
  }
  return { headers: [], dataRows: [] };
}

export function parseGoogleVisualizationResponse(
  gvizText: string,
  sheetName: string,
  existingById?: Map<string, Student>
): Student[] {
  const { headers, dataRows } = extractGvizTable(gvizText, sheetName);
  if (headers.length === 0) return [];
  return parse2DRowsToStudents(headers, dataRows, sheetName, existingById);
}

export function parseGoogleVisualizationFollowupLog(
  gvizText: string,
  studentsByCodeOrName?: Map<string, Student>
): FollowupRecord[] {
  const { headers, dataRows } = extractGvizTable(gvizText, 'سجل الافتقاد');
  if (headers.length === 0) return [];

  const dateIdx = findHeaderIndex(headers, ['التاريخ']);
  const fridayIdx = findHeaderIndex(headers, ['أسبوع الجمعة', 'الجمعة']);
  const codeIdx = findHeaderIndex(headers, ['الكود', 'كود', 'code']);
  const nameIdx = findHeaderIndex(headers, ['الاسم', 'name']);
  const servantIdx = findHeaderIndex(headers, ['الأشبين', 'الاشبين', 'الخادم']);
  const typeIdx = findHeaderIndex(headers, ['النوع', 'نوع']);
  const notesIdx = findHeaderIndex(headers, ['ملاحظات', 'ملا حظات']);

  const records: FollowupRecord[] = [];
  for (let i = 0; i < dataRows.length; i++) {
    const row = dataRows[i];
    const studentName = nameIdx >= 0 ? normalizeCellValue(row[nameIdx]) : '';
    const studentCode = codeIdx >= 0 ? normalizeCellValue(row[codeIdx]) : '';
    if (!studentName && !studentCode) continue;

    const dateVal = dateIdx >= 0 ? normalizeCellValue(row[dateIdx]) : '';
    const fridayVal = fridayIdx >= 0 ? normalizeCellValue(row[fridayIdx]) : '';
    const linked: Student | undefined =
      (studentCode ? studentsByCodeOrName?.get(studentCode) : undefined) ||
      (studentName ? studentsByCodeOrName?.get(studentName) : undefined);
    const servant = (servantIdx >= 0 ? normalizeCellValue(row[servantIdx]) : '') || linked?.servant || 'غير محدد';
    const typeVal = (typeIdx >= 0 ? normalizeCellValue(row[typeIdx]) : '') || 'بدون';
    const notesVal = notesIdx >= 0 ? normalizeCellValue(row[notesIdx]) : '';

    // Skip rows that have neither date nor followup method (empty template rows)
    if (!dateVal && (!typeVal || typeVal === 'بدون')) continue;

    records.push({
      id: `gs_fu_${i + 1}_${(studentCode || studentName).replace(/\s+/g, '_')}_${dateVal || fridayVal || 'nodate'}`,
      date: dateVal || fridayVal || '-',
      fridayDate: fridayVal || dateVal || '-',
      studentId: linked?.id || studentCode || studentName,
      studentCode: studentCode || linked?.code || '',
      studentName: studentName || linked?.name || '',
      servant,
      type: typeVal,
      notes: notesVal
    });
  }

  return records.reverse();
}

export async function fetchFollowupLogViaGviz(
  spreadsheetId: string,
  students: Student[] = []
): Promise<FollowupRecord[]> {
  const url = `https://docs.google.com/spreadsheets/d/${spreadsheetId}/gviz/tq?tqx=out:json&sheet=${encodeURIComponent('سجل الافتقاد')}&t=${Date.now()}`;
  const res = await fetch(url, { method: 'GET' });
  if (!res.ok) return [];
  const text = await res.text();
  const lookup = new Map<string, Student>();
  students.forEach((s) => {
    if (s.code) lookup.set(s.code.trim(), s);
    if (s.name) lookup.set(s.name.trim(), s);
  });
  return parseGoogleVisualizationFollowupLog(text, lookup);
}

export interface GvizFetchResult {
  students: Student[];
  confirmedSheets: string[];
  confirmedEmptySheets: string[];
  sheetsMeta: Record<string, { isComplete: boolean }>;
}

export async function fetchSheetStudentsViaGviz(
  spreadsheetId: string,
  targetSheet: string,
  existingById?: Map<string, Student>
): Promise<GvizFetchResult> {
  const sheetsToRead = targetSheet === ALL_SHEETS_SENTINEL ? [...APPROVED_SHEETS] : [targetSheet];
  const allStudents: Student[] = [];
  const confirmedSheets: string[] = [];
  const confirmedEmptySheets: string[] = [];
  const sheetsMeta: Record<string, { isComplete: boolean }> = {};

  for (const sheetName of sheetsToRead) {
    const url = `https://docs.google.com/spreadsheets/d/${spreadsheetId}/gviz/tq?tqx=out:json&sheet=${encodeURIComponent(sheetName)}&t=${Date.now()}`;
    const res = await fetch(url, { method: 'GET' });
    if (!res.ok) {
      throw new Error(`تعذر تحميل البيانات من Google Sheets (HTTP ${res.status})`);
    }
    const text = await res.text();
    const tabStudents = parseGoogleVisualizationResponse(text, sheetName, existingById);
    allStudents.push(...tabStudents);
    confirmedSheets.push(sheetName);
    sheetsMeta[sheetName] = { isComplete: true };
    if (tabStudents.length === 0) {
      confirmedEmptySheets.push(sheetName);
    }
  }

  return {
    students: allStudents,
    confirmedSheets,
    confirmedEmptySheets,
    sheetsMeta
  };
}
