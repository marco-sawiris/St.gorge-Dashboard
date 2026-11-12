export const CAIRO_TIMEZONE = 'Africa/Cairo';

export function normalizeArabicText(value: string | undefined | null): string {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\u064b-\u065f\u0670\u0640]/g, '') // remove tashkeel and tatweel
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x6f0))
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizeArabicInitial(value: string | undefined | null): string {
  const raw = String(value ?? '').trim().replace(/[\u064b-\u065f\u0670\u0640]/g, '');
  const ch = raw.charAt(0);
  if (!ch) return '';
  if (/[أإآٱ]/.test(ch)) return 'ا';
  if (ch === 'ى') return 'ي';
  if (ch === 'ة') return 'ه';
  if (ch === 'ئ' || ch === 'ؤ') return 'ء';
  return ch;
}

export const ARABIC_ALPHABET = [
  'ا', 'ب', 'ت', 'ث', 'ج', 'ح', 'خ',
  'د', 'ذ', 'ر', 'ز', 'س', 'ش', 'ص',
  'ض', 'ط', 'ظ', 'ع', 'غ', 'ف', 'ق',
  'ك', 'ل', 'م', 'ن', 'ه', 'و', 'ي'
];

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
