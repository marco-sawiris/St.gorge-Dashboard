import React, { useState } from 'react';
import { Student } from '../../types/student';
import { useApp } from '../../context/AppContext';
import {
  CheckCircle2,
  XCircle,
  Phone,
  MessageSquare,
  RotateCw,
  Edit3,
  MapPin,
  Calendar,
  User,
  HeartHandshake
} from 'lucide-react';
import confetti from 'canvas-confetti';
import { getNearestFridayString } from '../../utils/arabicUtils';

interface StudentCardProps {
  student: Student;
  onOpenFollowup: (student: Student) => void;
  onOpenEdit: (student: Student) => void;
}

export const StudentCard: React.FC<StudentCardProps> = ({
  student,
  onOpenFollowup,
  onOpenEdit
}) => {
  const [isFlipped, setIsFlipped] = useState(false);
  const [isAttendanceLoading, setIsAttendanceLoading] = useState(false);
  const { markAttendance } = useApp();

  const currentFriday = getNearestFridayString();
  const isPresentToday = Boolean(student.att && student.att[currentFriday]);

  const handleAttendanceClick = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (isAttendanceLoading) return;
    setIsAttendanceLoading(true);

    const nextState = !isPresentToday;
    const success = await markAttendance(student.id, nextState);

    if (success && nextState) {
      // Gentle celebratory confetti in Blue & Cyan palette (NO GREEN)
      try {
        confetti({
          particleCount: 25,
          spread: 45,
          origin: { y: 0.8 },
          colors: ['#20C7E8', '#267AFF', '#6548F5']
        });
      } catch {}
    }

    setIsAttendanceLoading(false);
  };

  // Avatar Initials
  const initials = student.name
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0])
    .join(' ');

  // Sheet color tone in Blue & Cyan System (Zero Green)
  const getSheetBadge = (sheet: string) => {
    switch (sheet) {
      case 'نشط':
        return 'bg-[var(--accent)]/15 text-[var(--accent)] border-[var(--accent)]/30 shadow-[0_0_8px_rgba(32,199,232,0.2)]';
      case 'غير حاضر':
        return 'bg-[var(--violet)]/15 text-[var(--violet)] border-[var(--violet)]/30';
      case 'فصل البابا شنودة':
        return 'bg-[var(--primary)]/15 text-[var(--primary)] border-[var(--primary)]/30';
      default:
        return 'bg-slate-500/15 text-slate-400 border-slate-500/30';
    }
  };

  return (
    <div className="perspective-1000 w-full h-[365px] select-none">
      <div
        className={`relative w-full h-full duration-500 transform-style-preserve-3d transition-transform ${
          isFlipped ? 'rotate-y-180' : ''
        }`}
      >
        {/* ==================================================== */}
        {/* FRONT OF CARD (Liquid Glass)                         */}
        {/* ==================================================== */}
        <div className="absolute inset-0 backface-hidden p-4.5 rounded-3xl glass shadow-[0_12px_32px_0_rgba(3,7,17,0.7)] flex flex-col justify-between hover:border-[var(--glass-border-2)] hover:shadow-[0_14px_40px_rgba(32,199,232,0.25)] transition-all duration-300">
          <div>
            {/* Top Row: Avatar, Name & Code */}
            <div className="flex items-start justify-between gap-3 mb-3">
              <div className="flex items-center gap-2.5">
                <div className="w-11 h-11 rounded-2xl bg-gradient-to-br from-[var(--navy-mid)] to-[var(--navy)] border border-[var(--glass-border-2)] text-[var(--accent)] font-extrabold text-sm flex items-center justify-center shadow-[0_0_12px_rgba(32,199,232,0.3)] shrink-0">
                  {initials || 'SG'}
                </div>
                <div>
                  <h3 className="font-extrabold text-sm sm:text-base text-[var(--text)] line-clamp-1 m-0">
                    {student.name}
                  </h3>
                  <div className="flex items-center gap-1.5 text-xs text-[var(--text-secondary)] mt-0.5">
                    <User className="w-3.5 h-3.5 text-[var(--accent)]" />
                    <span className="font-semibold">الأشبين: {student.servant}</span>
                  </div>
                </div>
              </div>

              <div className="flex flex-col items-end gap-1 shrink-0">
                <span className="text-[11px] font-mono font-bold px-2 py-0.5 rounded-md bg-[var(--navy)]/80 border border-[var(--glass-border)] text-[var(--accent)]">
                  {student.code}
                </span>
                <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full border ${getSheetBadge(student.sourceSheet)}`}>
                  {student.sourceSheet}
                </span>
              </div>
            </div>

            {/* Quick Attendance Toggle Button (Cyan Glow, Zero Green) */}
            <button
              type="button"
              onClick={handleAttendanceClick}
              disabled={isAttendanceLoading}
              className={`w-full py-2.5 px-3 rounded-xl font-bold text-xs flex items-center justify-center gap-2 transition-all duration-300 cursor-pointer active:scale-98 mb-3 border ${
                isPresentToday
                  ? 'bg-gradient-to-r from-[var(--primary)] to-[var(--accent)] text-white border-[var(--accent)] shadow-[0_0_16px_rgba(32,199,232,0.5)]'
                  : 'bg-[var(--navy)]/60 border-[var(--glass-border)] text-[var(--text-muted)] hover:border-[var(--accent)] hover:text-[var(--text)]'
              }`}
            >
              {isPresentToday ? (
                <>
                  <CheckCircle2 className="w-4 h-4 text-white drop-shadow-[0_0_6px_rgba(255,255,255,0.8)]" />
                  <span>حاضر اليوم الجمعة ({currentFriday})</span>
                </>
              ) : (
                <>
                  <XCircle className="w-4 h-4 text-slate-400" />
                  <span>تسجيل حضور اليوم ({currentFriday})</span>
                </>
              )}
            </button>

            {/* Counters & Attendance Metrics */}
            <div className="grid grid-cols-3 gap-2 text-center mb-3">
              <div className="p-2.5 rounded-xl bg-[var(--navy)]/50 border border-[var(--glass-border)]">
                <span className="block text-[10px] text-[var(--text-muted)] font-semibold mb-0.5">إجمالي الحضور</span>
                <strong className="text-sm font-mono text-[var(--accent)] tabular-nums">{student.attendanceTotal}</strong>
              </div>
              <div className="p-2.5 rounded-xl bg-[var(--navy)]/50 border border-[var(--glass-border)]">
                <span className="block text-[10px] text-[var(--text-muted)] font-semibold mb-0.5">حضور الشهر</span>
                <strong className="text-sm font-mono text-[var(--primary)] tabular-nums">{student.attendanceMonth}</strong>
              </div>
              <div className="p-2.5 rounded-xl bg-[var(--navy)]/50 border border-[var(--glass-border)]">
                <span className="block text-[10px] text-[var(--text-muted)] font-semibold mb-0.5">الافتقاد</span>
                <span className="block text-[11px] font-bold text-[var(--accent)] truncate">{student.followupStatus || 'بدون'}</span>
              </div>
            </div>

            {/* Area & Address preview */}
            <div className="flex items-center gap-1.5 text-xs text-[var(--text-muted)] line-clamp-1">
              <MapPin className="w-3.5 h-3.5 text-[var(--accent)] shrink-0" />
              <span className="truncate">المنطقة: <strong className="text-[var(--text)]">{student.area}</strong> - {student.address}</span>
            </div>
          </div>

          {/* Front Footer: Quick Actions + 3D Flip */}
          <div className="border-t border-[var(--glass-border)] pt-2.5 flex items-center justify-between gap-1.5">
            <div className="flex items-center gap-1">
              {student.phoneStudent && (
                <a
                  href={`tel:${student.phoneStudent}`}
                  onClick={(e) => e.stopPropagation()}
                  className="p-2 rounded-xl bg-[var(--navy)]/60 border border-[var(--glass-border)] text-[var(--text)] hover:text-[var(--accent)] hover:border-[var(--accent)] transition-all"
                  title="اتصال بالطالب"
                >
                  <Phone className="w-3.5 h-3.5" />
                </a>
              )}
              {(student.phoneStudent || student.phoneParent1) && (
                <a
                  href={`https://wa.me/2${(student.phoneStudent || student.phoneParent1)?.replace(/\D/g, '')}`}
                  target="_blank"
                  rel="noreferrer"
                  onClick={(e) => e.stopPropagation()}
                  className="p-2 rounded-xl bg-[var(--navy)]/60 border border-[var(--glass-border)] text-[var(--text)] hover:text-[var(--accent)] hover:border-[var(--accent)] transition-all"
                  title="محادثة واتساب"
                >
                  <MessageSquare className="w-3.5 h-3.5" />
                </a>
              )}
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onOpenFollowup(student);
                }}
                className="px-2.5 py-1.5 rounded-xl bg-[var(--navy)]/60 border border-[var(--glass-border)] text-xs font-bold text-[var(--accent)] hover:bg-[var(--accent)]/10 hover:border-[var(--accent)] transition-all flex items-center gap-1 cursor-pointer"
              >
                <HeartHandshake className="w-3.5 h-3.5" />
                <span>افتقاد</span>
              </button>
            </div>

            <button
              type="button"
              onClick={() => setIsFlipped(true)}
              className="btn--lens px-3.5 py-1.5 text-xs flex items-center gap-1.5 cursor-pointer shadow-md active:scale-95"
            >
              <RotateCw className="w-3 h-3" />
              <span>تفاصيل أكثر</span>
            </button>
          </div>
        </div>

        {/* ==================================================== */}
        {/* BACK OF CARD (Liquid Glass)                          */}
        {/* ==================================================== */}
        <div className="absolute inset-0 backface-hidden rotate-y-180 p-4.5 rounded-3xl glass-strong shadow-[0_12px_32px_0_rgba(3,7,17,0.8)] flex flex-col justify-between hover:border-[var(--glass-border-2)] transition-colors">
          <div>
            {/* Top Back Row: Title + Flip Back Button */}
            <div className="flex items-center justify-between pb-2 border-b border-[var(--glass-border)] mb-2.5">
              <div className="flex items-center gap-2">
                <span className="text-xs font-mono font-bold text-[var(--accent)]">{student.code}</span>
                <h4 className="font-extrabold text-sm text-[var(--text)] m-0">{student.name}</h4>
              </div>
              <button
                type="button"
                onClick={() => setIsFlipped(false)}
                className="px-2.5 py-1 rounded-xl bg-[var(--navy)]/80 border border-[var(--glass-border)] text-xs font-bold text-[var(--text-secondary)] hover:text-[var(--text)] hover:border-[var(--accent)] flex items-center gap-1 cursor-pointer transition-all"
              >
                <RotateCw className="w-3 h-3" />
                <span>الواجهة</span>
              </button>
            </div>

            {/* Back Details Grid */}
            <div className="space-y-2 text-xs">
              {/* Phones List */}
              <div className="p-2.5 rounded-2xl bg-[var(--navy)]/60 border border-[var(--glass-border)] space-y-1.5">
                <div className="flex items-center justify-between">
                  <span className="text-[var(--text-muted)]">موبايل الطالب:</span>
                  <div className="flex items-center gap-2">
                    <strong className="font-mono text-[var(--text)]">{student.phoneStudent || 'غير مسجل'}</strong>
                    {student.phoneStudent && (
                      <a href={`tel:${student.phoneStudent}`} className="text-[var(--accent)] hover:underline">
                        <Phone className="w-3 h-3 inline" />
                      </a>
                    )}
                  </div>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-[var(--text-muted)]">ولي الأمر (1):</span>
                  <div className="flex items-center gap-2">
                    <strong className="font-mono text-[var(--text)]">{student.phoneParent1 || 'غير مسجل'}</strong>
                    {student.phoneParent1 && (
                      <a href={`tel:${student.phoneParent1}`} className="text-[var(--accent)] hover:underline">
                        <Phone className="w-3 h-3 inline" />
                      </a>
                    )}
                  </div>
                </div>
                {student.phoneParent2 && (
                  <div className="flex items-center justify-between">
                    <span className="text-[var(--text-muted)]">ولي الأمر (2):</span>
                    <strong className="font-mono text-[var(--text)]">{student.phoneParent2}</strong>
                  </div>
                )}
              </div>

              {/* Birthdate & Address */}
              <div className="flex items-center gap-1.5 text-[var(--text-muted)]">
                <Calendar className="w-3.5 h-3.5 text-[var(--accent)] shrink-0" />
                <span>تاريخ الميلاد: <strong className="text-[var(--text)]">{student.birthDate || 'غير مسجل'}</strong></span>
              </div>

              <div className="flex items-start gap-1.5 text-[var(--text-muted)]">
                <MapPin className="w-3.5 h-3.5 text-[var(--accent)] shrink-0 mt-0.5" />
                <span>العنوان: <strong className="text-[var(--text)]">{student.address}</strong> ({student.area})</span>
              </div>

              {/* Notes */}
              <div className="p-2.5 rounded-2xl bg-[var(--navy)]/60 border border-[var(--glass-border)] text-[var(--text-muted)]">
                <span className="block text-[10px] font-bold text-[var(--accent)] mb-0.5">ملاحظات الخادم:</span>
                <p className="m-0 text-[11px] leading-relaxed line-clamp-2 text-[var(--text)]">
                  {student.notes || 'لا توجد ملاحظات مسجلة للمخدوم.'}
                </p>
              </div>
            </div>
          </div>

          {/* Back Footer: Action Bar (Strictly NO delete button) */}
          <div className="border-t border-[var(--glass-border)] pt-2.5 flex items-center justify-between gap-2">
            <button
              type="button"
              onClick={() => onOpenFollowup(student)}
              className="flex-1 py-2 px-3 rounded-xl bg-gradient-to-r from-[var(--primary)] to-[var(--accent)] text-white text-xs font-bold flex items-center justify-center gap-1.5 hover:shadow-[0_0_14px_rgba(32,199,232,0.4)] cursor-pointer shadow-sm active:scale-95 transition-all"
            >
              <HeartHandshake className="w-4 h-4" />
              <span>تسجيل افتقاد</span>
            </button>

            <button
              type="button"
              onClick={() => onOpenEdit(student)}
              className="py-2 px-4 rounded-xl bg-[var(--navy)]/80 border border-[var(--glass-border)] text-xs font-bold text-[var(--text)] hover:border-[var(--accent)] hover:text-[var(--accent)] flex items-center gap-1.5 cursor-pointer transition-all shadow-sm active:scale-95"
              title="تعديل بيانات المخدوم"
            >
              <Edit3 className="w-4 h-4" />
              <span>تعديل البيانات</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
