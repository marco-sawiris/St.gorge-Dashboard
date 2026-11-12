export interface FollowupRecord {
  id: string; // UUID
  date: string; // YYYY-MM-DD
  fridayDate: string; // Friday YYYY-MM-DD
  studentId: string; // UUID
  studentCode: string;
  studentName: string;
  servant: string;
  type: string; // "تم تليفونياً" | "تم بزيارة" | "واتساب" | "رسالة نصية" | "بدون"
  notes: string;
}
