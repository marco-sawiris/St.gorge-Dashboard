export type CallOutcome = 'تم التواصل' | 'لم يتم التواصل';

export interface FollowupRecord {
  id: string; // UUID
  date: string; // YYYY-MM-DD
  fridayDate: string; // Friday YYYY-MM-DD
  studentId: string; // UUID
  studentCode: string;
  studentName: string;
  servant: string;
  type: string; // "تم تليفونياً" | "تم بزيارة" | "واتساب" | "رسالة نصية" | "اعتذار" | "بدون"
  callOutcome?: CallOutcome; // Recorded strictly for phone calls ("تم التواصل" | "لم يتم التواصل"); undefined on legacy rows
  notes: string;
}
