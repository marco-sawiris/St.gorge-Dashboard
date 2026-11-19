import type { Student } from '../types/student';
import type { FollowupRecord } from '../types/followup';

export const CAIRO_TIMEZONE = 'Africa/Cairo';

export function normalizeArabicText(value: string | undefined | null): string {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\u064b-\u065f\u0670\u0640]/g, '') // remove tashkeel and tatweel
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/چ/g, 'ج')
    .replace(/ڤ/g, 'ف')
    .replace(/پ/g, 'ب')
    .replace(/گ/g, 'ك')
    .replace(/ژ/g, 'ز')
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x6f0))
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizeArabicInitial(value: string | undefined | null): string {
  const cleaned = String(value ?? '')
    .replace(/[\u200B-\u200F\uFEFF\u064b-\u065f\u0670\u0640]/g, '')
    .trim();
  const letterMatch = cleaned.match(/\p{L}/u);
  if (!letterMatch) return '';
  const ch = letterMatch[0];
  if (/[أإآٱ]/.test(ch)) return 'ا';
  if (ch === 'ى') return 'ي';
  if (ch === 'ة') return 'ه';
  if (ch === 'ئ' || ch === 'ؤ') return 'ء';
  if (/[a-z]/.test(ch)) return ch.toUpperCase();
  return ch;
}

export interface DynamicAlphabetBucket {
  letter: string;
  count: number;
}

const arabicAlphabetCollator = new Intl.Collator('ar', { sensitivity: 'base' });

export function extractDynamicAlphabetBuckets(
  students: ReadonlyArray<{ name?: string | null }>
): DynamicAlphabetBucket[] {
  const counts = new Map<string, number>();
  for (const student of students) {
    const initial = normalizeArabicInitial(student?.name);
    if (!initial) continue;
    counts.set(initial, (counts.get(initial) || 0) + 1);
  }
  return Array.from(counts.entries())
    .sort(([a], [b]) => arabicAlphabetCollator.compare(a, b))
    .map(([letter, count]) => ({ letter, count }));
}

export interface CairoDateParts {
  year: number;
  month: number; // 1..12
  day: number; // 1..31
  hour: number; // 0..23
  minute: number; // 0..59
  second: number; // 0..59
  weekday: number; // 0=Sunday..6=Saturday
  isoDate: string; // YYYY-MM-DD
}

const WEEKDAY_MAP: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6
};

/**
 * Extracts calendar & clock components strictly in Africa/Cairo timezone
 * (automatically reflects Egypt Standard Time / DST).
 */
export function getCairoDateParts(refDate: Date = new Date()): CairoDateParts {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: CAIRO_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  });

  const parts = dtf.formatToParts(refDate);
  const pick = (type: string) => parts.find((p) => p.type === type)?.value || '';

  const year = parseInt(pick('year'), 10);
  const month = parseInt(pick('month'), 10);
  const day = parseInt(pick('day'), 10);
  let hour = parseInt(pick('hour'), 10);
  if (hour === 24) hour = 0;
  const minute = parseInt(pick('minute'), 10);
  const second = parseInt(pick('second'), 10);
  const weekday = WEEKDAY_MAP[pick('weekday')] ?? new Date(Date.UTC(year, month - 1, day)).getUTCDay();

  const pad = (n: number) => String(n).padStart(2, '0');
  const isoDate = `${year}-${pad(month)}-${pad(day)}`;

  return { year, month, day, hour, minute, second, weekday, isoDate };
}

/**
 * Computes all Friday dates (YYYY-MM-DD) for a given calendar year and 1-based month (1..12).
 * Automatically handles 4-Friday and 5-Friday months across any year.
 */
export function getMonthFridays(year: number, month: number): string[] {
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const fridays: string[] = [];
  const pad = (n: number) => String(n).padStart(2, '0');
  for (let day = 1; day <= daysInMonth; day++) {
    const dow = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
    if (dow === 5) {
      fridays.push(`${year}-${pad(month)}-${pad(day)}`);
    }
  }
  return fridays;
}

/**
 * Returns today's calendar date (YYYY-MM-DD) strictly in Africa/Cairo timezone.
 * Eliminates UTC midnight date-shift bugs (e.g., 00:00–02:59 Cairo time).
 */
export function getCairoTodayIsoDate(refDate: Date = new Date()): string {
  return getCairoDateParts(refDate).isoDate;
}

/**
 * Returns the nearest upcoming Friday (or today if Friday) in Africa/Cairo timezone.
 */
export function getNearestFridayString(refDate: Date = new Date()): string {
  const cairo = getCairoDateParts(refDate);
  const diff = (5 - cairo.weekday + 7) % 7;
  const base = new Date(Date.UTC(cairo.year, cairo.month - 1, cairo.day + diff));
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${base.getUTCFullYear()}-${pad(base.getUTCMonth() + 1)}-${pad(base.getUTCDate())}`;
}

/**
 * Resolves consistent Cairo-local followup dates for both local storage and offline mutations:
 * - `date`: exact Africa/Cairo calendar date (YYYY-MM-DD) when the followup was recorded.
 * - `friday`: intended service week Friday (YYYY-MM-DD); preserves an explicit valid Friday if supplied,
 *   otherwise resolves the active Africa/Cairo Friday week.
 */
export function resolveFollowupCairoDates(
  refDate: Date = new Date(),
  explicitFriday?: string
): { date: string; friday: string } {
  const date = getCairoTodayIsoDate(refDate);
  const trimmedFriday = typeof explicitFriday === 'string' ? explicitFriday.trim() : '';
  const friday = /^\d{4}-\d{2}-\d{2}$/.test(trimmedFriday)
    ? trimmedFriday
    : getNearestFridayString(refDate);
  return { date, friday };
}

/**
 * Returns the latest Friday that has already started/occurred (today if Friday, else previous Friday)
 * in Africa/Cairo timezone.
 */
export function getLatestHeldFridayString(refDate: Date = new Date()): string {
  const cairo = getCairoDateParts(refDate);
  const diff = (cairo.weekday - 5 + 7) % 7;
  const base = new Date(Date.UTC(cairo.year, cairo.month - 1, cairo.day - diff));
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${base.getUTCFullYear()}-${pad(base.getUTCMonth() + 1)}-${pad(base.getUTCDate())}`;
}

export type FridayAttendanceState = 'present' | 'absent' | 'unrecorded' | 'future';

export interface MonthlyFridayEntry {
  fridayNumber: number;
  date: string; // YYYY-MM-DD
  shortLabel: string; // e.g. 6/11
  status: FridayAttendanceState;
  isFuture: boolean;
}

export interface MonthlyAttendanceSummary {
  year: number;
  month: number;
  todayIso: string;
  fridays: MonthlyFridayEntry[];
  presentCount: number;
  absentCount: number;
  heldCount: number; // Only Fridays with date <= todayIso (future Fridays strictly excluded)
  totalFridaysInMonth: number; // 4 or 5
}

/**
 * Builds monthly Friday breakdown anchored to Africa/Cairo calendar:
 * - true -> 'present' (green)
 * - false -> 'absent' (red)
 * - undefined/missing & past/today -> 'unrecorded' (neutral, NEVER treated as absent)
 * - future friday -> 'future' (neutral, NEVER counted in heldCount)
 */
export function computeMonthlyAttendanceSummary(
  attMap: Record<string, boolean> | undefined,
  refDate: Date = new Date()
): MonthlyAttendanceSummary {
  const cairo = getCairoDateParts(refDate);
  const monthFridays = getMonthFridays(cairo.year, cairo.month);

  let presentCount = 0;
  let absentCount = 0;
  let heldCount = 0;

  const entries: MonthlyFridayEntry[] = monthFridays.map((dateStr, idx) => {
    const isFuture = dateStr > cairo.isoDate;
    const parts = dateStr.split('-');
    const shortLabel = `${Number(parts[2])}/${Number(parts[1])}`;

    if (isFuture) {
      return {
        fridayNumber: idx + 1,
        date: dateStr,
        shortLabel,
        status: 'future',
        isFuture: true
      };
    }

    heldCount++;
    const hasExplicit = Boolean(attMap && Object.prototype.hasOwnProperty.call(attMap, dateStr));
    if (hasExplicit) {
      if (attMap![dateStr] === true) {
        presentCount++;
        return {
          fridayNumber: idx + 1,
          date: dateStr,
          shortLabel,
          status: 'present',
          isFuture: false
        };
      }
      if (attMap![dateStr] === false) {
        absentCount++;
        return {
          fridayNumber: idx + 1,
          date: dateStr,
          shortLabel,
          status: 'absent',
          isFuture: false
        };
      }
    }

    return {
      fridayNumber: idx + 1,
      date: dateStr,
      shortLabel,
      status: 'unrecorded',
      isFuture: false
    };
  });

  return {
    year: cairo.year,
    month: cairo.month,
    todayIso: cairo.isoDate,
    fridays: entries,
    presentCount,
    absentCount,
    heldCount,
    totalFridaysInMonth: monthFridays.length
  };
}

function shiftIsoDateDays(isoDate: string, deltaDays: number): string {
  const [y, m, d] = isoDate.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + deltaDays, 12, 0, 0));
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

function isEmptyFollowupValue(value: unknown): boolean {
  const s = String(value ?? '').trim();
  return !s || s === 'بدون' || s === '-' || s === 'لم يتم' || s === 'لم يتفتقد' || s === 'غير مسجل';
}

/**
 * Weekly Follow-up deadline closes strictly after Friday 23:59 Africa/Cairo time
 * (i.e. starting Saturday 00:00:00 Cairo -> cairo.isoDate > fridayDateIso).
 */
export function isFollowupWeekClosed(fridayDateIso: string, refDate: Date = new Date()): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fridayDateIso)) return false;
  const cairo = getCairoDateParts(refDate);
  return cairo.isoDate > fridayDateIso;
}

/**
 * Returns the active follow-up week Friday (YYYY-MM-DD) respecting Friday 23:59 Africa/Cairo cutoff.
 */
export function getActiveFollowupFridayString(refDate: Date = new Date()): string {
  return getNearestFridayString(refDate);
}

export type FollowupWeekState = 'done' | 'missed' | 'open' | 'upcoming' | 'no_data';

export interface MonthlyFollowupWeekEntry {
  weekNumber: number;
  fridayDate: string; // Friday ending this week (YYYY-MM-DD)
  weekStartDate: string; // Saturday starting this week (YYYY-MM-DD)
  shortLabel: string;
  status: FollowupWeekState;
  isClosed: boolean;
  isOpenWeek: boolean;
  isUpcoming: boolean;
  method?: string;
  callOutcome?: string;
  recordDate?: string;
}

export interface MonthlyFollowupSummary {
  year: number;
  month: number;
  todayIso: string;
  activeWeekFriday: string;
  weeks: MonthlyFollowupWeekEntry[];
  doneCount: number;
  missedCount: number;
  openCount: number;
  totalWeeksInMonth: number; // 4 or 5
}

export interface FollowupStudentLike {
  id: string;
  code?: string;
  fu?: Record<string, string>;
  fuOutcomes?: Record<string, string>;
  lastFollowup?: string;
  lastCallOutcome?: string;
}

export interface FollowupRecordLike {
  studentId?: string;
  studentCode?: string;
  date?: string;
  fridayDate?: string;
  type?: string;
  callOutcome?: string;
}

/**
 * Single source of truth for weekly follow-up tracking used across BOTH StudentCard & Smart Assistant:
 * - Supports 4 or 5 Fridays dynamically per Cairo month.
 * - Never derives follow-up from attendance (att has zero effect).
 * - Weeks close strictly after Friday 23:59 Africa/Cairo (Saturday 00:00 Cairo).
 * - Historical closed weeks remain immutable and never overlap the newly opened week.
 */
export function computeMonthlyFollowupSummary(
  student: FollowupStudentLike,
  followupRecords: ReadonlyArray<FollowupRecordLike> = [],
  refDate: Date = new Date(),
  hasDataAvailable: boolean = true
): MonthlyFollowupSummary {
  const cairo = getCairoDateParts(refDate);
  const monthFridays = getMonthFridays(cairo.year, cairo.month);
  const activeWeekFriday = getActiveFollowupFridayString(refDate);

  let doneCount = 0;
  let missedCount = 0;
  let openCount = 0;

  const weeks: MonthlyFollowupWeekEntry[] = monthFridays.map((fridayDate, idx) => {
    const weekStartDate = shiftIsoDateDays(fridayDate, -6);
    const parts = fridayDate.split('-');
    const shortLabel = `${Number(parts[2])}/${Number(parts[1])}`;
    const isClosed = isFollowupWeekClosed(fridayDate, refDate);
    const isOpenWeek = !isClosed && weekStartDate <= cairo.isoDate;
    const isUpcoming = !isClosed && weekStartDate > cairo.isoDate;

    if (!hasDataAvailable) {
      return {
        weekNumber: idx + 1,
        fridayDate,
        weekStartDate,
        shortLabel,
        status: 'no_data',
        isClosed,
        isOpenWeek,
        isUpcoming
      };
    }

    const studentNormName = normalizeArabicText((student as any).name);
    const matchingLogs = followupRecords.filter((r) => {
      if (!r || isEmptyFollowupValue(r.type)) return false;
      const rCode = String(r.studentCode || '').trim();
      const sCode = String(student.code || '').trim();
      const matchesStudent =
        (r.studentId && r.studentId === student.id) ||
        (Boolean(rCode) && Boolean(sCode) && rCode === sCode) ||
        (Boolean(studentNormName) && Boolean((r as any).studentName) && normalizeArabicText((r as any).studentName) === studentNormName);
      if (!matchesStudent) return false;
      if (r.fridayDate === fridayDate) return true;
      if (r.date && r.date >= weekStartDate && r.date <= fridayDate && (!r.fridayDate || r.fridayDate === fridayDate)) {
        return true;
      }
      return false;
    });

    const sheetMethod = !isEmptyFollowupValue(student.fu?.[fridayDate]) ? student.fu?.[fridayDate]?.trim() : undefined;

    if (matchingLogs.length > 0) {
      const latest = matchingLogs[0];
      doneCount++;
      return {
        weekNumber: idx + 1,
        fridayDate,
        weekStartDate,
        shortLabel,
        status: 'done',
        isClosed,
        isOpenWeek,
        isUpcoming,
        method: latest.type,
        callOutcome: latest.callOutcome,
        recordDate: latest.date || fridayDate
      };
    }

    if (sheetMethod) {
      doneCount++;
      return {
        weekNumber: idx + 1,
        fridayDate,
        weekStartDate,
        shortLabel,
        status: 'done',
        isClosed,
        isOpenWeek,
        isUpcoming,
        method: sheetMethod,
        callOutcome: student.fuOutcomes?.[fridayDate] || student.lastCallOutcome,
        recordDate: student.lastFollowup || fridayDate
      };
    }

    if (isClosed) {
      missedCount++;
      return {
        weekNumber: idx + 1,
        fridayDate,
        weekStartDate,
        shortLabel,
        status: 'missed',
        isClosed: true,
        isOpenWeek: false,
        isUpcoming: false
      };
    }

    if (isOpenWeek) {
      openCount++;
      return {
        weekNumber: idx + 1,
        fridayDate,
        weekStartDate,
        shortLabel,
        status: 'open',
        isClosed: false,
        isOpenWeek: true,
        isUpcoming: false
      };
    }

    return {
      weekNumber: idx + 1,
      fridayDate,
      weekStartDate,
      shortLabel,
      status: 'upcoming',
      isClosed: false,
      isOpenWeek: false,
      isUpcoming: true
    };
  });

  return {
    year: cairo.year,
    month: cairo.month,
    todayIso: cairo.isoDate,
    activeWeekFriday,
    weeks,
    doneCount,
    missedCount,
    openCount,
    totalWeeksInMonth: monthFridays.length
  };
}

export function formatArabicDate(dateStr: string | undefined | null): string {
  if (!dateStr) return '-';
  try {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return dateStr;
    return d.toLocaleDateString('ar-EG', {
      timeZone: CAIRO_TIMEZONE,
      year: 'numeric',
      month: 'short',
      day: 'numeric'
    });
  } catch {
    return dateStr;
  }
}

function toAsciiDigits(value: string): string {
  return value
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x6f0));
}

export function formatTelHref(rawPhone: string | undefined | null): string | null {
  const ascii = toAsciiDigits(String(rawPhone ?? '').trim());
  const cleaned = ascii.replace(/(?!^\+)[^\d]/g, '');
  const digitsOnly = cleaned.replace(/\D/g, '');
  if (digitsOnly.length < 5) return null;
  return `tel:${cleaned}`;
}

export function formatWhatsAppUrl(
  rawPhone: string | undefined | null,
  text?: string
): string | null {
  const ascii = toAsciiDigits(String(rawPhone ?? '').trim());
  let digits = ascii.replace(/\D/g, '');
  if (!digits) {
    return text ? `https://wa.me/?text=${encodeURIComponent(text)}` : null;
  }
  if (digits.startsWith('00')) {
    digits = digits.slice(2);
  }
  if (digits.startsWith('0')) {
    digits = `2${digits}`;
  } else if (/^1[0-25]\d{8}$/.test(digits)) {
    digits = `20${digits}`;
  }
  if (digits.length < 8) {
    return text ? `https://wa.me/?text=${encodeURIComponent(text)}` : null;
  }
  const query = text ? `?text=${encodeURIComponent(text)}` : '';
  return `https://wa.me/${digits}${query}`;
}

const ARABIC_ORDINALS_MASC = ['الأول', 'الثاني', 'الثالث', 'الرابع', 'الخامس', 'السادس'] as const;
const ARABIC_ORDINALS_FEM = ['الأولى', 'الثانية', 'الثالثة', 'الرابعة', 'الخامسة', 'السادسة'] as const;

export function formatArabicWeekLabel(weekNumber: number): string {
  const idx = Number(weekNumber) - 1;
  if (idx >= 0 && idx < ARABIC_ORDINALS_MASC.length) {
    return `الأسبوع ${ARABIC_ORDINALS_MASC[idx]}`;
  }
  return `الأسبوع ${weekNumber}`;
}

export function formatArabicFridayLabel(fridayNumber: number): string {
  const idx = Number(fridayNumber) - 1;
  if (idx >= 0 && idx < ARABIC_ORDINALS_FEM.length) {
    return `الجمعة ${ARABIC_ORDINALS_FEM[idx]}`;
  }
  return `الجمعة ${fridayNumber}`;
}

export interface LatestFollowupCommentInfo {
  comment: string;
  date?: string;
  method?: string;
}

/**
 * Resolves the latest non-empty followup comment/note recorded for a student
 * from live followup records (sorted chronologically descending) with fallback
 * to student.notes if no separate followup record carries a comment.
 */
export function getLatestFollowupComment(
  student: Pick<Student, 'id' | 'code' | 'name' | 'notes'>,
  followupRecords: ReadonlyArray<FollowupRecord>
): LatestFollowupCommentInfo | null {
  const normalizedCode = (student.code || '').trim();
  const normalizedName = normalizeArabicText(student.name);

  const matchingWithNotes = (Array.isArray(followupRecords) ? followupRecords : [])
    .filter((rec) => {
      if (!rec || !String(rec.notes || '').trim()) return false;
      if (rec.studentId && student.id && rec.studentId === student.id) return true;
      if (rec.studentCode && normalizedCode && rec.studentCode.trim() === normalizedCode) return true;
      if (rec.studentName && normalizedName && normalizeArabicText(rec.studentName) === normalizedName) return true;
      return false;
    })
    .sort((a, b) => {
      const dateCompare = String(b.date || b.fridayDate || '').localeCompare(String(a.date || a.fridayDate || ''));
      if (dateCompare !== 0) return dateCompare;
      return String(b.id || '').localeCompare(String(a.id || ''));
    });

  if (matchingWithNotes.length > 0) {
    const latest = matchingWithNotes[0];
    return {
      comment: String(latest.notes || '').trim(),
      date: latest.date || latest.fridayDate || undefined,
      method: latest.type || undefined
    };
  }

  const fallbackNote = String(student.notes || '').trim();
  if (fallbackNote) {
    return {
      comment: fallbackNote
    };
  }

  return null;
}

export type FollowupMethodCategory = 'call' | 'visit' | 'whatsapp' | 'sms' | 'excuse' | 'none' | 'other';

export function classifyFollowupMethod(rawType: unknown): FollowupMethodCategory {
  const raw = String(rawType ?? '').trim();
  if (!raw || raw === '-' || raw === 'بدون' || raw === 'لم يتم' || raw === 'لم يتفتقد' || raw === 'غير مسجل') {
    return 'none';
  }
  const norm = normalizeArabicText(raw);
  if (!norm || norm === 'بدون' || norm === 'لم يتم' || norm === 'غير مسجل') {
    return 'none';
  }
  if (norm.includes('زيار')) return 'visit';
  if (norm.includes('تليفون') || norm.includes('هاتف') || norm.includes('تلفون') || norm.includes('اتصال') || norm.includes('مكالم')) {
    return 'call';
  }
  if (norm.includes('واتس')) return 'whatsapp';
  if (norm.includes('نصي') || norm.includes('sms') || norm.includes('رساله')) return 'sms';
  if (norm.includes('اعتذار')) return 'excuse';
  return 'other';
}

export function extractFollowupCallOutcome(
  rawType: unknown,
  explicitOutcome?: unknown
): 'تم التواصل' | 'لم يتم التواصل' | undefined {
  const explicitRaw = String(explicitOutcome ?? '').trim();
  if (explicitRaw) {
    const normExp = normalizeArabicText(explicitRaw);
    if (normExp.includes('لم يتم التواصل') || normExp.includes('لم يتم الوصول') || normExp.includes('لم يرد') || normExp.includes('لم يتم الرد')) {
      return 'لم يتم التواصل';
    }
    if (normExp.includes('تم التواصل') || normExp.includes('تم الوصول') || normExp.includes('تم الرد')) {
      return 'تم التواصل';
    }
  }

  const normType = normalizeArabicText(String(rawType ?? ''));
  if (!normType) return undefined;
  if (normType.includes('لم يتم الوصول') || normType.includes('لم يتم التواصل') || normType.includes('لم يرد') || normType.includes('لم يتم الرد')) {
    return 'لم يتم التواصل';
  }
  if (normType.includes('تم الوصول') || normType.includes('تم التواصل') || normType.includes('تم الرد')) {
    return 'تم التواصل';
  }
  return undefined;
}

export function formatFollowupTypeDisplay(rawType: unknown): string {
  const raw = String(rawType ?? '').trim();
  if (!raw) return 'بدون';
  const cat = classifyFollowupMethod(raw);
  if (cat === 'call') return 'اتصال تليفوني';
  if (cat === 'visit') return 'زيارة منزلية';
  if (cat === 'whatsapp') return 'واتساب';
  if (cat === 'sms') return 'رسالة نصية';
  if (cat === 'excuse') return 'اعتذار';
  return raw;
}

export function getFridayWeekForDateIso(dateIso: string): string {
  const clean = String(dateIso || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(clean)) return clean;
  const [y, m, d] = clean.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  const dow = dt.getUTCDay(); // 0=Sun..5=Fri..6=Sat
  const deltaToFriday = (5 - dow + 7) % 7;
  dt.setUTCDate(dt.getUTCDate() + deltaToFriday);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

export function findStudentForFollowupRecord(
  record: Pick<FollowupRecord, 'studentId' | 'studentCode' | 'studentName'>,
  students: ReadonlyArray<Student>
): Student | undefined {
  if (!record || !Array.isArray(students) || students.length === 0) return undefined;
  const targetId = String(record.studentId || '').trim();
  if (targetId) {
    const byId = students.find((s) => s.id === targetId);
    if (byId) return byId;
  }
  const targetCode = String(record.studentCode || '').trim();
  if (targetCode) {
    const byCode = students.find((s) => s.code && s.code.trim() === targetCode);
    if (byCode) return byCode;
  }
  const normName = normalizeArabicText(record.studentName);
  if (normName) {
    const byName = students.find((s) => normalizeArabicText(s.name) === normName);
    if (byName) return byName;
  }
  return undefined;
}

export function getCanonicalFollowupStudentKey(
  record: Pick<FollowupRecord, 'studentId' | 'studentCode' | 'studentName'>,
  matchedStudent?: Student
): string {
  if (matchedStudent?.id) return matchedStudent.id;
  const normName = normalizeArabicText(record.studentName);
  if (normName) return `name:${normName}`;
  const cleanCode = String(record.studentCode || '').trim();
  if (cleanCode) return `code:${cleanCode}`;
  return String(record.studentId || '');
}

/**
 * Unifies authoritative 'سجل الافتقاد' records with real per-date followup columns
 * (`student.fu[YYYY-MM-DD]`, e.g. 'افتقاد 2026-10-30') without creating duplicates
 * and strictly NEVER turning standalone text notes (without a followup date + method)
 * into a followup record.
 */
export function buildUnifiedFollowupRecords(
  sheetRecords: ReadonlyArray<FollowupRecord>,
  students: ReadonlyArray<Student>
): FollowupRecord[] {
  const byId = new Map<string, Student>();
  const byCode = new Map<string, Student>();
  const byNormName = new Map<string, Student>();

  for (const s of students) {
    if (s.id) byId.set(s.id, s);
    if (s.code && s.code.trim()) byCode.set(s.code.trim(), s);
    const nn = normalizeArabicText(s.name);
    if (nn && !byNormName.has(nn)) byNormName.set(nn, s);
  }

  const resolveMatch = (rec: Pick<FollowupRecord, 'studentId' | 'studentCode' | 'studentName'>): Student | undefined => {
    const tid = String(rec.studentId || '').trim();
    if (tid && byId.has(tid)) return byId.get(tid);
    const tcode = String(rec.studentCode || '').trim();
    if (tcode && byCode.has(tcode)) return byCode.get(tcode);
    const tname = normalizeArabicText(rec.studentName);
    if (tname && byNormName.has(tname)) return byNormName.get(tname);
    return undefined;
  };

  const unified: FollowupRecord[] = [];
  const exactIndexMap = new Map<string, number>();
  const weekKeySet = new Set<string>();

  for (const rawRec of sheetRecords) {
    if (!rawRec) continue;
    const cat = classifyFollowupMethod(rawRec.type);
    const rawDate = String(rawRec.date || '').trim();
    const rawFriday = String(rawRec.fridayDate || '').trim();
    const resolvedDate = rawDate && rawDate !== '-' ? rawDate : (rawFriday && rawFriday !== '-' ? rawFriday : '-');

    // Never include blank/placeholder rows with neither valid method nor date
    if (cat === 'none' && (resolvedDate === '-' || !resolvedDate)) continue;
    if (cat === 'none') continue;

    const matched = resolveMatch(rawRec);
    const resolvedFriday =
      rawFriday && rawFriday !== '-'
        ? rawFriday
        : /^\d{4}-\d{2}-\d{2}$/.test(resolvedDate)
        ? getFridayWeekForDateIso(resolvedDate)
        : resolvedDate;

    const studentKey = getCanonicalFollowupStudentKey(rawRec, matched);
    const exactKey = `${studentKey}__${resolvedDate}__${cat}`;
    const weekKey = `${studentKey}__${resolvedFriday}__${cat}`;
    const extractedOutcome = extractFollowupCallOutcome(rawRec.type, rawRec.callOutcome);

    const normalizedRec: FollowupRecord = {
      id: rawRec.id,
      date: resolvedDate,
      fridayDate: resolvedFriday,
      studentId: matched?.id || rawRec.studentId || rawRec.studentCode || rawRec.studentName,
      studentCode: String(rawRec.studentCode || '').trim() || matched?.code || '',
      studentName: String(rawRec.studentName || '').trim() || matched?.name || '',
      servant:
        rawRec.servant && rawRec.servant.trim() && rawRec.servant.trim() !== 'غير محدد'
          ? rawRec.servant.trim()
          : matched?.servant || 'غير محدد',
      type: String(rawRec.type || '').trim(),
      ...(extractedOutcome ? { callOutcome: extractedOutcome } : {}),
      notes: String(rawRec.notes || '').trim()
    };

    if (exactIndexMap.has(exactKey)) {
      // Merge richer fields without duplicating the same student/date/method record
      const idx = exactIndexMap.get(exactKey)!;
      const existing = unified[idx];
      if (!existing.notes && normalizedRec.notes) existing.notes = normalizedRec.notes;
      if (!existing.callOutcome && normalizedRec.callOutcome) existing.callOutcome = normalizedRec.callOutcome;
      if ((!existing.studentCode || existing.studentCode === '-') && normalizedRec.studentCode) existing.studentCode = normalizedRec.studentCode;
      if ((!existing.servant || existing.servant === 'غير محدد') && normalizedRec.servant !== 'غير محدد') existing.servant = normalizedRec.servant;
      continue;
    }

    exactIndexMap.set(exactKey, unified.length);
    if (resolvedFriday && resolvedFriday !== '-') {
      weekKeySet.add(weekKey);
    }
    unified.push(normalizedRec);
  }

  // Synthesize historical per-date followups from student.fu columns when not already in 'سجل الافتقاد'
  for (const s of students) {
    if (!s.fu || typeof s.fu !== 'object') continue;
    for (const [fuDate, fuMethod] of Object.entries(s.fu)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(fuDate)) continue;
      const cat = classifyFollowupMethod(fuMethod);
      if (cat === 'none') continue;

      const weekFriday = getFridayWeekForDateIso(fuDate);
      const exactKey = `${s.id}__${fuDate}__${cat}`;
      const weekKey = `${s.id}__${weekFriday}__${cat}`;

      if (exactIndexMap.has(exactKey) || weekKeySet.has(weekKey)) {
        continue;
      }

      const outcome = extractFollowupCallOutcome(fuMethod, s.fuOutcomes?.[fuDate]);
      exactIndexMap.set(exactKey, unified.length);
      weekKeySet.add(weekKey);

      unified.push({
        id: `sheet_fu_${s.id}_${fuDate}_${cat}`,
        date: fuDate,
        fridayDate: weekFriday,
        studentId: s.id,
        studentCode: s.code || '',
        studentName: s.name || '',
        servant: s.servant || 'غير محدد',
        type: String(fuMethod).trim(),
        ...(outcome ? { callOutcome: outcome } : {}),
        notes: ''
      });
    }
  }

  // Sort descending chronologically by date (newest first), stable tie-break by id
  unified.sort((a, b) => {
    const dateA = /^\d{4}-\d{2}-\d{2}$/.test(a.date) ? a.date : '';
    const dateB = /^\d{4}-\d{2}-\d{2}$/.test(b.date) ? b.date : '';
    const cmp = dateB.localeCompare(dateA);
    if (cmp !== 0) return cmp;
    return String(b.fridayDate || '').localeCompare(String(a.fridayDate || ''));
  });

  return unified;
}

