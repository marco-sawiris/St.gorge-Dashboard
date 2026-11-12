export interface Student {
  id: string; // Real UUID v4
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
  att: Record<string, boolean>; // date (YYYY-MM-DD) -> boolean
  fu: Record<string, string>; // date (YYYY-MM-DD) -> followup status
}

export const ALL_SHEETS_SENTINEL = '__ALL__' as const;
export const APPROVED_SHEETS = ['نشط', 'غير حاضر', 'فصل البابا شنودة', 'غير نشط'] as const;
export type ApprovedSheet = (typeof APPROVED_SHEETS)[number];
export type SheetName = ApprovedSheet | typeof ALL_SHEETS_SENTINEL;

export interface AppFilterState {
  searchQuery: string;
  sheet: SheetName;
  servant: string;
  area: string;
  alphabetLetter: string | null;
}
