export type StudentIdentityQuality = 'explicit_id' | 'stable_code' | 'unkeyed';

export interface Student {
  id: string; // Real UUID v4 or canonical stable student code ID
  code: string; // e.g. "SG-101"
  name: string;
  servant: string;
  phoneStudent?: string;
  phoneParent1?: string;
  phoneParent2?: string;
  birthDate?: string;
  area: string;
  address: string;
  notes: string;
  followupStatus: string; // e.g. "بدون", "تم تليفونياً", "تم بزيارة", "واتساب", "رسالة نصية"
  attendanceTotal: number;
  attendanceMonth: number;
  attendanceStatus: 'حاضر' | 'غائب';
  lastAttendance?: string;
  lastFollowup?: string;
  sourceSheet: string;
  rowNumber?: number;
  version: number; // Concurrency version
  hasRemoteVersion?: boolean; // True only when remote source provided an explicit authoritative version column
  hasUnsyncedLocalChanges?: boolean; // True while local edits are awaiting remote confirmation
  identityQuality?: StudentIdentityQuality; // Provenance of student ID stability
  att: Record<string, boolean>; // date (YYYY-MM-DD) -> boolean
  fu: Record<string, string>; // date (YYYY-MM-DD) -> followup status
  fuOutcomes?: Record<string, 'تم التواصل' | 'لم يتم التواصل'>; // date (YYYY-MM-DD) -> phone call outcome
  lastCallOutcome?: 'تم التواصل' | 'لم يتم التواصل';
}

export const ALL_SHEETS_SENTINEL = '__ALL__' as const;

// Actual existing student roster tabs in the central Google Sheets file
export const LIVE_GOOGLE_SHEET_TABS = ['نشط', 'غير حاضر', 'فصل البابا شنودة'] as const;

// In-app student classification preserved locally without requiring a Google Sheets tab
export const INACTIVE_STUDENT_CLASSIFICATION = 'غير نشط' as const;

export const STUDENT_CLASSIFICATION_OPTIONS = [
  ...LIVE_GOOGLE_SHEET_TABS,
  INACTIVE_STUDENT_CLASSIFICATION
] as const;

// Remote completeness checks (__ALL__) only require the actual Google Sheets tabs
export const APPROVED_SHEETS = LIVE_GOOGLE_SHEET_TABS;

export type LiveGoogleSheetTab = (typeof LIVE_GOOGLE_SHEET_TABS)[number];
export type StudentClassificationOption = (typeof STUDENT_CLASSIFICATION_OPTIONS)[number];
export type ApprovedSheet = StudentClassificationOption;
export type SheetName = ApprovedSheet | typeof ALL_SHEETS_SENTINEL;

export interface AppFilterState {
  searchQuery: string;
  sheet: SheetName;
  servant: string;
  area: string;
  alphabetLetter: string | null;
}
