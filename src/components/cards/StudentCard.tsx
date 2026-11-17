import React, { useEffect, useMemo, useState } from 'react';
import { motion } from 'motion/react';
import { Student, APPROVED_SHEETS } from '../../types/student';
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
  HeartHandshake,
  Save,
  X,
  AlertCircle,
  Loader2,
  Check,
  CloudOff
} from 'lucide-react';
import confetti from 'canvas-confetti';
import {
  computeMonthlyAttendanceSummary,
  computeMonthlyFollowupSummary,
  getLatestHeldFridayString,
  formatTelHref,
  formatWhatsAppUrl,
  formatArabicWeekLabel,
  formatArabicFridayLabel,
  getLatestFollowupComment
} from '../../utils/arabicUtils';

interface StudentCardProps {
  student: Student;
  onOpenFollowup: (student: Student) => void;
  onOpenEdit: (student: Student) => void;
  initialFlipped?: boolean;
  isFlipped?: boolean;
  onToggleFlip?: (studentId: string) => void;
}

const StudentCardComponent: React.FC<StudentCardProps> = ({
  student,
  onOpenFollowup,
  onOpenEdit,
  initialFlipped = false,
  isFlipped: controlledFlipped,
  onToggleFlip
}) => {
  const [internalFlipped, setInternalFlipped] = useState(Boolean(initialFlipped));
  const isFlipped = typeof controlledFlipped === 'boolean' ? controlledFlipped : internalFlipped;
  const [isAttendanceLoading, setIsAttendanceLoading] = useState(false);
  const [activeTrackTab, setActiveTrackTab] = useState<'all' | 'att' | 'fu'>('all');

  const {
    markAttendance,
    activeEditingId,
    followupRecords,
    updateStudent,
    cancelEditing,
    setHasUnsavedEditChanges,
    inFlightStudentIds,
    syncedStudentIds,
    pendingStudentIds
  } = useApp();

  const isStudentInFlight = inFlightStudentIds?.includes(student.id) || false;
  const isStudentSynced = syncedStudentIds?.includes(student.id) || false;
  const isStudentPending = pendingStudentIds?.includes(student.id) || false;

  const isThisCardEditing = activeEditingId === student.id;
  const isAnotherCardEditing = Boolean(activeEditingId && activeEditingId !== student.id);

  // Reset flip state if inline editing starts on this card.
  useEffect(() => {
    if (isThisCardEditing) {
      if (onToggleFlip && controlledFlipped) {
        onToggleFlip(student.id);
      } else {
        setInternalFlipped(false);
      }
    }
  }, [isThisCardEditing, onToggleFlip, controlledFlipped, student.id]);

  const handleToggleFlip = (e: React.MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    if (onToggleFlip) {
      onToggleFlip(student.id);
    } else {
      setInternalFlipped((prev) => !prev);
    }
  };

  // Inline Card Edit Form State (keeps ALL cards visible in the grid)
  const [editName, setEditName] = useState(student.name || '');
  const [editCode, setEditCode] = useState(student.code || '');
  const [editServant, setEditServant] = useState(student.servant || '');
  const [editSheet, setEditSheet] = useState(student.sourceSheet || 'نشط');
  const [editArea, setEditArea] = useState(student.area || '');
  const [editAddress, setEditAddress] = useState(student.address || '');
  const [editPhoneStudent, setEditPhoneStudent] = useState(student.phoneStudent || '');
  const [editPhoneParent1, setEditPhoneParent1] = useState(student.phoneParent1 || '');
  const [editBirthDate, setEditBirthDate] = useState(student.birthDate || '');
  const [editNotes, setEditNotes] = useState(student.notes || '');
  const [editError, setEditError] = useState('');
  const [isSavingEdit, setIsSavingEdit] = useState(false);
  const [showUnsavedGuard, setShowUnsavedGuard] = useState(false);

  const initialEditSnapshot = useMemo(
    () =>
      JSON.stringify({
        name: student.name || '',
        code: student.code || '',
        servant: student.servant || '',
        sheet: student.sourceSheet || 'نشط',
        area: student.area || '',
        address: student.address || '',
        phoneStudent: student.phoneStudent || '',
        phoneParent1: student.phoneParent1 || '',
        birthDate: student.birthDate || '',
        notes: student.notes || ''
      }),
    [student]
  );

  useEffect(() => {
    if (isThisCardEditing) {
      setEditName(student.name || '');
      setEditCode(student.code || '');
      setEditServant(student.servant || '');
      setEditSheet(student.sourceSheet || 'نشط');
      setEditArea(student.area || '');
      setEditAddress(student.address || '');
      setEditPhoneStudent(student.phoneStudent || '');
      setEditPhoneParent1(student.phoneParent1 || '');
      setEditBirthDate(student.birthDate || '');
      setEditNotes(student.notes || '');
      setEditError('');
      setShowUnsavedGuard(false);
    }
  }, [isThisCardEditing, student]);

  const currentEditSnapshot = useMemo(
    () =>
      JSON.stringify({
        name: editName,
        code: editCode,
        servant: editServant,
        sheet: editSheet,
        area: editArea,
        address: editAddress,
        phoneStudent: editPhoneStudent,
        phoneParent1: editPhoneParent1,
        birthDate: editBirthDate,
        notes: editNotes
      }),
    [
      editName,
      editCode,
      editServant,
      editSheet,
      editArea,
      editAddress,
      editPhoneStudent,
      editPhoneParent1,
      editBirthDate,
      editNotes
    ]
  );

  const isInlineDirty = isThisCardEditing && currentEditSnapshot !== initialEditSnapshot;

  useEffect(() => {
    if (isThisCardEditing) {
      setHasUnsavedEditChanges(isInlineDirty);
    }
  }, [isThisCardEditing, isInlineDirty, setHasUnsavedEditChanges]);

  const latestHeldFriday = getLatestHeldFridayString();
  const currentFridayStatus = student.att?.[latestHeldFriday];
  const isPresentToday = currentFridayStatus === true;
  const isAbsentToday = currentFridayStatus === false;

  const cleanFollowupStatus = String(student.followupStatus || '').trim();
  const hasFollowup = Boolean(
    cleanFollowupStatus &&
    cleanFollowupStatus !== 'بدون' &&
    !cleanFollowupStatus.includes('لم')
  );

  // Matching records from سجل الافتقاد (real records only)
  const matchingFollowups = useMemo(() => {
    return followupRecords.filter((r) => {
      if (r.studentId && r.studentId === student.id) return true;
      if (r.studentCode && student.code && r.studentCode.trim() === student.code.trim()) return true;
      if (r.studentName && student.name && r.studentName.trim() === student.name.trim()) return true;
      return false;
    });
  }, [followupRecords, student.id, student.code, student.name]);

  // Real recorded followups count
  const studentFollowupCount = useMemo(() => {
    const perFridayCount = Object.values(student.fu || {}).filter(
      (v) => v && v.trim() !== '' && v.trim() !== 'بدون'
    ).length;
    return Math.max(matchingFollowups.length, perFridayCount, hasFollowup ? 1 : 0);
  }, [matchingFollowups.length, student.fu, hasFollowup]);

  // Real recorded latest followup method (الوسيلة)
  const latestFollowupMethod = useMemo(() => {
    if (matchingFollowups.length > 0) {
      const sorted = [...matchingFollowups].sort((a, b) =>
        (b.date || b.fridayDate || '').localeCompare(a.date || a.fridayDate || '')
      );
      const latest = sorted[0];
      if (latest?.type?.trim() && latest.type.trim() !== 'بدون') return latest.type.trim();
    }
    const fuDates = Object.keys(student.fu || {}).sort();
    if (fuDates.length > 0) {
      const latestVal = String(student.fu[fuDates[fuDates.length - 1]] || '').trim();
      if (latestVal && latestVal !== 'بدون' && !latestVal.includes('لم')) {
        return latestVal;
      }
    }
    if (hasFollowup) {
      return cleanFollowupStatus;
    }
    return '';
  }, [matchingFollowups, student.fu, hasFollowup, cleanFollowupStatus]);

  const latestPhoneCallOutcome = useMemo(() => {
    const phoneRecords = matchingFollowups
      .filter((r) => r.type === 'تم تليفونياً' || r.type === 'اتصال تليفوني' || r.type === 'اتصال هاتفي')
      .sort((a, b) => (b.date || b.fridayDate || '').localeCompare(a.date || a.fridayDate || ''));
    if (phoneRecords.length > 0) {
      return phoneRecords[0].callOutcome || 'غير مسجل';
    }
    if (student.lastCallOutcome) return student.lastCallOutcome;
    if (latestFollowupMethod === 'تم تليفونياً' || latestFollowupMethod === 'اتصال تليفوني') {
      return 'غير مسجل';
    }
    return null;
  }, [matchingFollowups, student.lastCallOutcome, latestFollowupMethod]);

  // Real Africa/Cairo Monthly Fridays breakdown (supports both 4 & 5 Friday months, excludes future Fridays)
  const monthlySummary = useMemo(
    () => computeMonthlyAttendanceSummary(student.att),
    [student.att]
  );

  // Real Africa/Cairo Monthly Follow-up Weeks (4 or 5 weeks, closes Friday 23:59 Cairo, never inferred from attendance)
  const hasFollowupDataAvailable = Boolean(
    student.fu !== undefined ||
    student.followupStatus !== undefined ||
    matchingFollowups.length > 0
  );
  const monthlyFollowupSummary = useMemo(
    () => computeMonthlyFollowupSummary(student, followupRecords, new Date(), hasFollowupDataAvailable),
    [student, followupRecords, hasFollowupDataAvailable]
  );

  const latestFollowupComment = useMemo(
    () => getLatestFollowupComment(student, followupRecords),
    [student, followupRecords]
  );

  const handleAttendanceToggle = async (
    nextState: boolean,
    targetFridayDate: string = latestHeldFriday
  ): Promise<boolean> => {
    if (isAttendanceLoading) return false;
    setIsAttendanceLoading(true);

    try {
      const success = await markAttendance(student.id, nextState, targetFridayDate);

      if (success && nextState) {
        try {
          confetti({
            particleCount: 25,
            spread: 45,
            origin: { y: 0.8 },
            colors: ['#20C7E8', '#267AFF', '#6548F5']
          });
        } catch {}
      }

      return success;
    } catch (error: any) {
      console.error('Student attendance action failed:', error);
      return false;
    } finally {
      setIsAttendanceLoading(false);
    }
  };

  const handleInlineSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setEditError('');
    if (!editName.trim()) {
      setEditError('يرجى إدخال اسم المخدوم كاملاً.');
      return;
    }
    if (!editServant.trim()) {
      setEditError('يرجى إدخال اسم الأشبين المسؤول.');
      return;
    }

    setIsSavingEdit(true);
    try {
      const ok = await updateStudent(student.id, {
        name: editName.trim(),
        code: editCode.trim(),
        servant: editServant.trim(),
        sourceSheet: editSheet,
        area: editArea.trim(),
        address: editAddress.trim(),
        phoneStudent: editPhoneStudent.trim(),
        phoneParent1: editPhoneParent1.trim(),
        birthDate: editBirthDate.trim(),
        notes: editNotes.trim()
      });
      if (ok) {
        cancelEditing();
      } else {
        setEditError('تعذر حفظ التعديلات محلياً.');
      }
    } catch (err: any) {
      setEditError(err?.message || 'حدث خطأ أثناء حفظ البيانات.');
    } finally {
      setIsSavingEdit(false);
    }
  };

  const handleInlineCancel = () => {
    if (isInlineDirty && !isSavingEdit) {
      setShowUnsavedGuard(true);
      return;
    }
    cancelEditing();
  };

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

  // Inline Edit Mode rendered IN PLACE so ALL student cards remain visible on screen
  if (isThisCardEditing) {
    return (
      <form
        onSubmit={handleInlineSave}
        aria-label={`تعديل بيانات ${student.name}`}
        className="box-border w-full min-w-0 max-w-full overflow-x-clip p-3 sm:p-4 rounded-3xl glass-strong ring-2 ring-[#20C7E8] border-[#20C7E8] shadow-[0_0_28px_rgba(32,199,232,0.35)] flex flex-col gap-2.5 select-none animate-wordIn"
      >
        <div className="flex items-center justify-between gap-2 pb-2 border-b border-[var(--border-color)]">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-[10.5px] font-extrabold px-2 py-0.5 rounded-full bg-[#20C7E8]/20 text-[#20C7E8] border border-[#20C7E8]/45 shrink-0">
              تعديل مباشر
            </span>
            <h3 className="font-extrabold text-xs sm:text-sm text-[var(--text-primary)] m-0 truncate">
              {student.name}
            </h3>
          </div>
          <button
            type="button"
            onClick={handleInlineCancel}
            aria-label="إلغاء التعديل"
            className="glass-btn w-7 h-7 rounded-lg flex items-center justify-center cursor-pointer shrink-0"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>

        {showUnsavedGuard && (
          <div className="p-2 rounded-xl bg-amber-500/15 border border-amber-500/35 flex flex-wrap items-center justify-between gap-1.5 text-[11px] font-bold">
            <span className="text-[var(--warning-text)]">توجد تغييرات غير محفوظة!</span>
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => setShowUnsavedGuard(false)}
                className="glass-btn--primary px-2 py-1 rounded-lg text-[10.5px] cursor-pointer"
              >
                متابعة
              </button>
              <button
                type="button"
                onClick={() => cancelEditing()}
                className="glass-btn px-2 py-1 rounded-lg text-[10.5px] text-rose-400 border-rose-500/40 cursor-pointer"
              >
                تجاهل
              </button>
            </div>
          </div>
        )}

        {editError && (
          <div className="p-2 rounded-xl bg-rose-500/15 border border-rose-500/35 text-rose-300 flex items-center gap-1.5 text-[11px] font-bold">
            <AlertCircle className="w-3.5 h-3.5 shrink-0" />
            <span>{editError}</span>
          </div>
        )}

        <div className="grid grid-cols-2 min-w-0 gap-2 text-xs">
          <div className="col-span-2">
            <label className="block text-[10.5px] font-bold text-[var(--text-secondary)] mb-0.5">الاسم *</label>
            <input
              type="text"
              required
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
              className="box-border w-full min-w-0 min-h-[36px] h-auto py-1.5 px-2.5 rounded-lg bg-[var(--input-bg)] border border-[var(--border-color)] text-xs font-bold text-[var(--text-primary)] focus:outline-none focus:border-[var(--border-focus)]"
            />
          </div>

          <div>
            <label className="block text-[10.5px] font-bold text-[var(--text-secondary)] mb-0.5">الأشبين *</label>
            <input
              type="text"
              required
              value={editServant}
              onChange={(e) => setEditServant(e.target.value)}
              className="box-border w-full min-w-0 min-h-[36px] h-auto py-1.5 px-2.5 rounded-lg bg-[var(--input-bg)] border border-[var(--border-color)] text-xs font-semibold text-[var(--text-primary)] focus:outline-none focus:border-[var(--border-focus)]"
            />
          </div>

          <div>
            <label className="block text-[10.5px] font-bold text-[var(--text-secondary)] mb-0.5">الكود</label>
            <input
              type="text"
              value={editCode}
              onChange={(e) => setEditCode(e.target.value)}
              className="box-border w-full min-w-0 min-h-[36px] h-auto py-1.5 px-2.5 rounded-lg bg-[var(--input-bg)] border border-[var(--border-color)] font-mono text-xs font-bold text-[#20C7E8] focus:outline-none focus:border-[var(--border-focus)]"
            />
          </div>

          <div>
            <label className="block text-[10.5px] font-bold text-[var(--text-secondary)] mb-0.5">الفصل</label>
            <select
              value={editSheet}
              onChange={(e) => setEditSheet(e.target.value)}
              className="box-border w-full min-w-0 min-h-[36px] h-auto py-1.5 px-2 rounded-lg bg-[var(--input-bg)] border border-[var(--border-color)] text-xs font-bold text-[var(--text-primary)] focus:outline-none focus:border-[var(--border-focus)]"
            >
              {APPROVED_SHEETS.map((s) => (
                <option key={s} value={s} className="bg-[var(--surface-primary)] text-[var(--text-primary)]">
                  {s}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-[10.5px] font-bold text-[var(--text-secondary)] mb-0.5">المنطقة</label>
            <input
              type="text"
              value={editArea}
              onChange={(e) => setEditArea(e.target.value)}
              className="box-border w-full min-w-0 min-h-[36px] h-auto py-1.5 px-2.5 rounded-lg bg-[var(--input-bg)] border border-[var(--border-color)] text-xs font-semibold text-[var(--text-primary)] focus:outline-none focus:border-[var(--border-focus)]"
            />
          </div>

          <div>
            <label className="block text-[10.5px] font-bold text-[var(--text-secondary)] mb-0.5">موبايل الطالب</label>
            <input
              type="tel"
              value={editPhoneStudent}
              onChange={(e) => setEditPhoneStudent(e.target.value)}
              className="box-border w-full min-w-0 min-h-[36px] h-auto py-1.5 px-2.5 rounded-lg bg-[var(--input-bg)] border border-[var(--border-color)] font-mono text-xs text-[var(--text-primary)] focus:outline-none focus:border-[var(--border-focus)]"
            />
          </div>

          <div>
            <label className="block text-[10.5px] font-bold text-[var(--text-secondary)] mb-0.5">ولي الأمر</label>
            <input
              type="tel"
              value={editPhoneParent1}
              onChange={(e) => setEditPhoneParent1(e.target.value)}
              className="box-border w-full min-w-0 min-h-[36px] h-auto py-1.5 px-2.5 rounded-lg bg-[var(--input-bg)] border border-[var(--border-color)] font-mono text-xs text-[var(--text-primary)] focus:outline-none focus:border-[var(--border-focus)]"
            />
          </div>

          <div>
            <label className="block text-[10.5px] font-bold text-[var(--text-secondary)] mb-0.5">تاريخ الميلاد</label>
            <input
              type="text"
              value={editBirthDate}
              onChange={(e) => setEditBirthDate(e.target.value)}
              placeholder="YYYY-MM-DD"
              className="box-border w-full min-w-0 min-h-[36px] h-auto py-1.5 px-2.5 rounded-lg bg-[var(--input-bg)] border border-[var(--border-color)] font-mono text-xs text-[var(--text-primary)] focus:outline-none focus:border-[var(--border-focus)]"
            />
          </div>

          <div>
            <label className="block text-[10.5px] font-bold text-[var(--text-secondary)] mb-0.5">العنوان</label>
            <input
              type="text"
              value={editAddress}
              onChange={(e) => setEditAddress(e.target.value)}
              className="box-border w-full min-w-0 min-h-[36px] h-auto py-1.5 px-2.5 rounded-lg bg-[var(--input-bg)] border border-[var(--border-color)] text-xs text-[var(--text-primary)] focus:outline-none focus:border-[var(--border-focus)]"
            />
          </div>

          <div className="col-span-2">
            <label className="block text-[10.5px] font-bold text-[var(--text-secondary)] mb-0.5">ملاحظات</label>
            <textarea
              rows={2}
              value={editNotes}
              onChange={(e) => setEditNotes(e.target.value)}
              className="box-border w-full min-w-0 p-2 rounded-lg bg-[var(--input-bg)] border border-[var(--border-color)] text-xs text-[var(--text-primary)] focus:outline-none focus:border-[var(--border-focus)] resize-none"
            />
          </div>
        </div>

        <div className="border-t border-[var(--border-color)] pt-2.5 flex flex-wrap items-center justify-end gap-2">
          <button
            type="button"
            onClick={handleInlineCancel}
            className="glass-btn min-h-[36px] px-3.5 py-1.5 rounded-xl text-xs font-bold text-[var(--text-secondary)] cursor-pointer"
          >
            إلغاء
          </button>
          <button
            type="submit"
            disabled={isSavingEdit}
            className="glass-btn--primary btn--lens min-h-[36px] px-4 py-1.5 rounded-xl text-xs font-extrabold flex items-center gap-1.5 cursor-pointer"
          >
            <Save className="w-3.5 h-3.5 text-white shrink-0" />
            <span>{isSavingEdit ? 'جاري الحفظ...' : 'حفظ التعديلات'}</span>
          </button>
        </div>
      </form>
    );
  }

  return (
    <article
      aria-label={`بطاقة المخدوم ${student.name}`}
      className="card-flip-scene box-border w-full min-w-0 max-w-full select-none relative z-10"
    >
      <div className={`card-flip-inner ${isFlipped ? 'is-flipped' : ''}`}>
        {/* ==================================================== */}
        {/* FRONT FACE                                           */}
        {/* ==================================================== */}
        <div
          aria-hidden={isFlipped}
          inert={isFlipped || undefined}
          className={`card-flip-face card-flip-face--front card-flip-surface box-border w-full min-w-0 max-w-full p-3.5 sm:p-4 rounded-3xl shadow-[var(--shadow-card)] flex flex-col justify-between gap-2.5 transition-[border-color,box-shadow] duration-300 ease-[var(--ease-spring)] hover:border-[var(--glass-border-2)] hover:shadow-[var(--shadow-accent)] ${
            isFlipped ? 'pointer-events-none' : 'opacity-100 pointer-events-auto relative z-10'
          }`}
        >
          <div className="min-w-0 space-y-2.5">
            {/* Top Row: Full Name, Servant, Code & Sheet (No Initials Avatar) */}
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0 flex-1">
                <h3 className="font-extrabold text-sm sm:text-base text-[var(--text)] leading-snug line-clamp-1 m-0">
                  {student.name || 'مخدوم بدون اسم'}
                </h3>
                <div className="flex items-center gap-1.5 text-xs text-[var(--text-secondary)] mt-0.5">
                  <User className="w-3.5 h-3.5 text-[var(--accent)] shrink-0" />
                  <span className="font-semibold truncate">الأشبين: {student.servant || 'غير محدد'}</span>
                </div>
              </div>

              <div className="flex flex-col items-end gap-1 shrink-0">
                <span className="text-[11px] font-mono font-bold px-2 py-0.5 rounded-md bg-[var(--surface-inset)] border border-[var(--glass-border)] text-[var(--accent)]">
                  {student.code || '-'}
                </span>
                <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full border ${getSheetBadge(student.sourceSheet || 'نشط')}`}>
                  {student.sourceSheet || 'نشط'}
                </span>
              </div>
            </div>

            {/* Quick Attendance Selector: Side-by-side Date & Present/Absent + Sync Status directly underneath Date */}
            <div className="w-full p-2.5 rounded-2xl bg-[var(--surface-inset)] border border-[var(--glass-border)] flex flex-col gap-1.5 shadow-xs">
              <div className="flex items-center justify-between gap-2">
                <div className="flex flex-col items-start min-w-0">
                  <div className="flex items-center gap-1.5 min-w-0 text-right">
                    <Calendar className="w-3.5 h-3.5 text-[var(--accent)] shrink-0" />
                    <span className="text-[11px] font-bold text-[var(--text-secondary)] leading-snug truncate">
                      الجمعة ({latestHeldFriday})
                    </span>
                  </div>

                  {/* Sync Status Badge displayed directly below the date */}
                  {isStudentInFlight ? (
                    <span className="mt-1 inline-flex items-center gap-1 text-[10px] font-bold text-[var(--accent)] bg-[var(--accent)]/15 px-2 py-0.5 rounded-full border border-[var(--accent)]/30 animate-pulse">
                      <Loader2 className="w-3 h-3 animate-spin shrink-0" />
                      <span>جاري المزامنة...</span>
                    </span>
                  ) : isStudentPending ? (
                    <span
                      className="mt-1 inline-flex items-center gap-1 text-[10px] font-bold text-amber-300 bg-amber-500/20 px-2 py-0.5 rounded-full border border-amber-400/40"
                      title="العملية محفوظة محلياً وسيتم إرسالها تلقائياً للشيت فور توفر الإنترنت"
                    >
                      <CloudOff className="w-3 h-3 text-amber-400 shrink-0" />
                      <span>محفوظ محلياً (معلق)</span>
                    </span>
                  ) : isStudentSynced ? (
                    <span className="mt-1 inline-flex items-center gap-1 text-[10px] font-bold text-emerald-300 bg-emerald-500/20 px-2 py-0.5 rounded-full border border-emerald-400/40">
                      <Check className="w-3 h-3 text-emerald-400 shrink-0" />
                      <span>تمت المزامنة</span>
                    </span>
                  ) : null}
                </div>

                <div className="flex items-center gap-1.5 shrink-0" role="group" aria-label={`تسجيل حضور وغياب ${student.name}`}>
                  {/* Present Button (حاضر) */}
                  <button
                    type="button"
                    disabled={isAttendanceLoading || isStudentInFlight}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (isPresentToday || isAttendanceLoading) return;
                      if (isStudentInFlight) return;
                      void handleAttendanceToggle(true, latestHeldFriday);
                    }}
                    aria-pressed={isPresentToday}
                    className={`min-h-[38px] px-2.5 sm:px-3 py-1.5 rounded-xl text-xs font-extrabold flex items-center gap-1.5 transition-all duration-200 cursor-pointer active:scale-95 disabled:opacity-60 ${
                      isPresentToday
                        ? 'bg-emerald-500/25 border border-emerald-400 text-emerald-300 shadow-[0_0_12px_rgba(16,185,129,0.35)] font-black'
                        : 'bg-[var(--surface-primary)] border border-[var(--glass-border)] text-[var(--text-muted)] hover:text-emerald-300 hover:border-emerald-500/40'
                    }`}
                    title={isPresentToday ? 'حاضر مسجل' : 'تسجيل حضور المخدوم'}
                  >
                    {isStudentInFlight && isPresentToday ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin text-emerald-300 shrink-0" />
                    ) : (
                      <CheckCircle2 className={`w-3.5 h-3.5 shrink-0 ${isPresentToday ? 'text-emerald-300' : 'opacity-60'}`} />
                    )}
                    <span>حاضر</span>
                  </button>

                  {/* Absent Button (غائب) */}
                  <button
                    type="button"
                    disabled={isAttendanceLoading || isStudentInFlight}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (isAbsentToday || isAttendanceLoading) return;
                      if (isStudentInFlight) return;
                      void handleAttendanceToggle(false, latestHeldFriday);
                    }}
                    aria-pressed={isAbsentToday}
                    className={`min-h-[38px] px-2.5 sm:px-3 py-1.5 rounded-xl text-xs font-extrabold flex items-center gap-1.5 transition-all duration-200 cursor-pointer active:scale-95 disabled:opacity-60 ${
                      isAbsentToday
                        ? 'bg-rose-500/25 border border-rose-400 text-rose-300 shadow-[0_0_12px_rgba(244,63,94,0.35)] font-black'
                        : 'bg-[var(--surface-primary)] border border-[var(--glass-border)] text-[var(--text-muted)] hover:text-rose-300 hover:border-rose-500/40'
                    }`}
                    title={isAbsentToday ? 'غائب مسجل' : 'تسجيل غياب المخدوم'}
                  >
                    {isStudentInFlight && isAbsentToday ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin text-rose-300 shrink-0" />
                    ) : (
                      <XCircle className={`w-3.5 h-3.5 shrink-0 ${isAbsentToday ? 'text-rose-300' : 'opacity-60'}`} />
                    )}
                    <span>غائب</span>
                  </button>
                </div>
              </div>
            </div>

            {/* Compact Metrics Row */}
            <div className="grid grid-cols-2 gap-2 text-center">
              <div className="py-1.5 px-2.5 rounded-xl bg-[var(--surface-inset)] border border-[var(--glass-border)] flex flex-wrap items-center justify-between gap-1 min-w-0">
                <span className="text-[10px] text-[var(--text-muted)] font-semibold">إجمالي الحضور</span>
                <strong className="text-sm font-mono text-[var(--accent)] tabular-nums">{student.attendanceTotal}</strong>
              </div>
              <div className="py-1.5 px-2.5 rounded-xl bg-[var(--surface-inset)] border border-[var(--glass-border)] flex flex-wrap items-center justify-between gap-1 min-w-0">
                <span className="text-[10px] text-[var(--text-muted)] font-semibold">حضور الشهر</span>
                <strong className="text-sm font-mono text-[var(--primary)] tabular-nums">
                  {`${monthlySummary.presentCount}/${monthlySummary.heldCount}`}
                </strong>
              </div>
            </div>

            {/* Monthly Attendance (Dynamic 4 or 5 Cairo Fridays: Green/Red/Neutral) & Followup Panel */}
            <div className="card-dual-tracks flex flex-col gap-2 p-2.5 rounded-2xl bg-[var(--surface-inset)] border border-[var(--glass-border)]">
              <div className="flex flex-wrap items-center justify-between gap-1.5 pb-1 border-b border-[var(--glass-border)]/60">
                <div className="flex flex-wrap items-center gap-1 min-w-0" role="tablist" aria-label={`تبويبات سجل ${student.name}`}>
                  {[
                    { id: 'all' as const, label: 'الكل' },
                    { id: 'att' as const, label: `${monthlySummary.totalFridaysInMonth} جمع` },
                    { id: 'fu' as const, label: 'الافتقاد' }
                  ].map((tab) => {
                    const isTabActive = activeTrackTab === tab.id;
                    return (
                      <button
                        key={tab.id}
                        type="button"
                        role="tab"
                        aria-selected={isTabActive}
                        onClick={() => setActiveTrackTab(tab.id)}
                        className={`card-anchored-pill relative text-[10px] font-extrabold cursor-pointer ${
                          isTabActive ? 'text-white border-transparent' : 'text-[var(--text-muted)]'
                        }`}
                      >
                        {isTabActive && (
                          <motion.span
                            layoutId={`cardTrackPill_${student.id}`}
                            transition={{ type: 'spring', stiffness: 440, damping: 30 }}
                            aria-hidden="true"
                            className="card-anchored-pill--active absolute inset-0 rounded-full pointer-events-none"
                          />
                        )}
                        <span className="relative z-10">{tab.label}</span>
                      </button>
                    );
                  })}
                </div>

                <span className="text-[10px] font-mono font-bold text-[var(--accent)] tabular-nums">
                  {`${monthlySummary.presentCount}/${monthlySummary.heldCount}`}
                </span>
              </div>

              {/* Track 1: Monthly Attendance (All Fridays of Current Cairo Month — Full Arabic labels) */}
              {(activeTrackTab === 'all' || activeTrackTab === 'att') && (
                <div className="flex flex-col gap-1.5">
                  <div className="flex flex-wrap items-center justify-between gap-1.5 text-[11px]">
                    <span className="font-bold text-[var(--text-secondary)] flex items-center gap-1">
                      <Calendar className="w-3.5 h-3.5 text-[var(--accent)] shrink-0" />
                      <span>الحضور الشهري</span>
                    </span>
                    <span className="font-mono font-extrabold text-[var(--accent)] tabular-nums">
                      {`${monthlySummary.presentCount}/${monthlySummary.heldCount}`}
                    </span>
                  </div>

                  <div
                    className="grid grid-cols-2 gap-1.5"
                    aria-label={`الحضور الشهري ${monthlySummary.presentCount} من ${monthlySummary.heldCount}`}
                  >
                    {monthlySummary.fridays.map((friday) => {
                      const stateStyle =
                        friday.status === 'present'
                          ? 'bg-emerald-500/20 border-emerald-400/75 text-emerald-300 shadow-[0_0_8px_rgba(16,185,129,0.28)]'
                          : friday.status === 'absent'
                            ? 'bg-rose-500/20 border-rose-400/75 text-rose-300 shadow-[0_0_8px_rgba(244,63,94,0.24)]'
                            : 'bg-slate-500/12 border-slate-500/30 text-[var(--text-muted)]';

                      const stateSymbol =
                        friday.status === 'present'
                          ? '✓'
                          : friday.status === 'absent'
                            ? '✕'
                            : '—';

                      const stateTitle =
                        friday.status === 'present'
                          ? 'حاضر مسجل'
                          : friday.status === 'absent'
                            ? 'غائب مسجل'
                            : friday.status === 'future'
                              ? 'جمعة مستقبلية لم تنعقد بعد'
                              : 'لم يُسجل بعد (محايد)';

                      const fridayLabel = formatArabicFridayLabel(friday.fridayNumber);

                      return (
                        <button
                          key={friday.date}
                          type="button"
                          disabled={friday.isFuture || isAttendanceLoading}
                          onClick={(e) => {
                            e.stopPropagation();
                            if (friday.isFuture) return;
                            const nextVal = friday.status !== 'present';
                            void handleAttendanceToggle(nextVal, friday.date);
                          }}
                          title={`${fridayLabel} (${friday.date}) — ${stateTitle}`}
                          aria-label={`${fridayLabel} بتاريخ ${friday.shortLabel}: ${stateTitle}`}
                          className={`rounded-xl min-h-[40px] py-1.5 px-2 text-right border transition-all flex items-center justify-between gap-1.5 min-w-0 ${stateStyle} ${
                            friday.isFuture
                              ? 'cursor-default opacity-65'
                              : 'cursor-pointer hover:brightness-110 active:scale-95'
                          }`}
                        >
                          <div className="min-w-0 flex flex-col">
                            <span className="text-[10.5px] font-bold leading-snug break-words">
                              {fridayLabel}
                            </span>
                            <span className="text-[9.5px] font-mono font-bold opacity-85 leading-tight tabular-nums">
                              {friday.shortLabel}
                            </span>
                          </div>
                          <span className="text-xs font-extrabold leading-none shrink-0">
                            {stateSymbol}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Track 2: Weekly Followup Indicators (Full Arabic Week Names, Friday 23:59 Cairo cutoff) + Details */}
              {(activeTrackTab === 'all' || activeTrackTab === 'fu') && (
                <div className="flex flex-col gap-1.5 pt-1.5 border-t border-[var(--glass-border)]/45">
                  <div className="flex flex-wrap items-center justify-between gap-1.5 text-[11px]">
                    <span className="font-bold text-[var(--text-secondary)] flex items-center gap-1 shrink-0">
                      <HeartHandshake className="w-3.5 h-3.5 text-[var(--primary)] shrink-0" />
                      <span>{`الافتقاد (${studentFollowupCount})`}</span>
                    </span>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        onOpenFollowup(student);
                      }}
                      className={`text-[10.5px] font-extrabold px-2 py-0.5 rounded-md transition-colors cursor-pointer max-w-full break-words ${
                        hasFollowup
                          ? 'text-[var(--accent)] bg-[var(--accent)]/12 hover:bg-[var(--accent)]/22'
                          : 'text-rose-400 bg-rose-500/12 hover:bg-rose-500/22'
                      }`}
                      title="انقر لتسجيل أو تحديث الافتقاد"
                    >
                      {hasFollowup ? cleanFollowupStatus : 'بحاجة لافتقاد'}
                    </button>
                  </div>

                  {/* Weekly Followup Bars Grid (Full Arabic Labels) */}
                  <div
                    className="grid grid-cols-2 gap-1.5"
                    aria-label={`متابعة الافتقاد الأسبوعية (${monthlyFollowupSummary.doneCount} من ${monthlyFollowupSummary.totalWeeksInMonth})`}
                  >
                    {monthlyFollowupSummary.weeks.map((week) => {
                      const barClass =
                        week.status === 'done'
                          ? 'followup-bar--done'
                          : week.status === 'missed'
                            ? 'followup-bar--missed'
                            : week.status === 'open'
                              ? 'followup-bar--open'
                              : week.status === 'no_data'
                                ? 'followup-bar--empty'
                                : 'followup-bar--upcoming';

                      const statusDesc =
                        week.status === 'done'
                          ? `تم الافتقاد (${week.method || 'مسجل'}${week.recordDate ? ` • ${week.recordDate}` : ''})`
                          : week.status === 'missed'
                            ? 'أُغلق الأسبوع بعد الجمعة 11:59 م بتوقيت القاهرة دون تسجيل افتقاد'
                            : week.status === 'open'
                              ? 'الأسبوع الحالي مفتوح حتى الجمعة 11:59 م بتوقيت القاهرة'
                              : week.status === 'no_data'
                                ? 'لا توجد بيانات كافية لهذا الأسبوع'
                                : 'أسبوع قادم لم يبدأ بعد';

                      const weekLabel = formatArabicWeekLabel(week.weekNumber);

                      return (
                        <button
                          key={week.fridayDate}
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            onOpenFollowup(student);
                          }}
                          title={`${weekLabel} (${week.shortLabel}) — ${statusDesc}`}
                          aria-label={`${weekLabel} (${week.shortLabel}): ${statusDesc}`}
                          className={`followup-week-bar ${barClass} cursor-pointer min-h-[40px] px-2 py-1.5 min-w-0`}
                        >
                          <span className="followup-week-line" aria-hidden="true" />
                          <div className="w-full flex flex-wrap items-center justify-between gap-1 text-[10px] font-bold leading-snug">
                            <span className="break-words text-right">{weekLabel}</span>
                            <span className="font-mono text-[9.5px] opacity-85 tabular-nums shrink-0">{week.shortLabel}</span>
                          </div>
                        </button>
                      );
                    })}
                  </div>

                  {/* Followup Method, Call Outcome & Real Count Row */}
                  <div className="flex flex-wrap items-center justify-between gap-1.5 text-[10px]">
                    <span className="px-2 py-0.5 rounded-md bg-[var(--surface-primary)] border border-[var(--glass-border)] text-[var(--text-secondary)] font-bold">
                      عدد المرات: <strong className="font-mono text-[var(--accent)]">{studentFollowupCount}</strong>
                    </span>
                    <span className="px-2 py-0.5 rounded-md bg-[var(--surface-primary)] border border-[var(--glass-border)] text-[var(--text-secondary)] font-bold max-w-full min-w-0 break-words">
                      الوسيلة:{' '}
                      <strong className={latestFollowupMethod ? 'text-[var(--accent)]' : 'text-[var(--text-muted)]'}>
                        {latestFollowupMethod || 'لم تُسجل'}
                      </strong>
                    </span>
                    {latestPhoneCallOutcome && (
                      <span className="px-2 py-0.5 rounded-md bg-[var(--surface-primary)] border border-[var(--glass-border)] text-[var(--text-secondary)] font-bold">
                        نتيجة الاتصال:{' '}
                        <strong
                          className={
                            latestPhoneCallOutcome === 'تم التواصل'
                              ? 'text-[var(--accent)]'
                              : latestPhoneCallOutcome === 'لم يتم التواصل'
                                ? 'text-rose-400'
                                : 'text-[var(--text-muted)]'
                          }
                        >
                          {latestPhoneCallOutcome}
                        </strong>
                      </span>
                    )}
                  </div>
                </div>
              )}
            </div>

            {/* Latest Followup Comment Section ("آخر تعليق افتقاد") */}
            <div className="p-2.5 rounded-2xl bg-[var(--surface-inset)] border border-[var(--glass-border)] space-y-1">
              <div className="flex items-center justify-between gap-2 text-[10.5px]">
                <span className="font-extrabold text-[var(--accent)]">آخر تعليق افتقاد</span>
                {latestFollowupComment?.date && (
                  <span className="font-mono text-[10px] text-[var(--text-muted)] tabular-nums">
                    {latestFollowupComment.date}
                  </span>
                )}
              </div>
              <p className="m-0 text-[11px] font-semibold text-[var(--text-primary)] leading-relaxed line-clamp-2 break-words">
                {latestFollowupComment?.comment || 'لا يوجد تعليق افتقاد حتى الآن'}
              </p>
            </div>

            {/* Area & Address preview */}
            <div className="flex items-center gap-1.5 text-xs text-[var(--text-muted)] line-clamp-1">
              <MapPin className="w-3.5 h-3.5 text-[var(--accent)] shrink-0" />
              <span className="truncate">المنطقة: <strong className="text-[var(--text)]">{student.area || 'غير محددة'}</strong>{student.address ? ` - ${student.address}` : ''}</span>
            </div>
          </div>

          {/* Front Footer: Quick Actions + 3D Flip */}
          <div className="border-t border-[var(--glass-border)] pt-2.5 flex items-center justify-between gap-1.5">
            <div className="flex items-center gap-1.5 min-w-0">
              {(() => {
                const telHref = formatTelHref(student.phoneStudent);
                const waHref = formatWhatsAppUrl(student.phoneStudent || student.phoneParent1);
                return (
                  <>
                    {telHref && (
                      <a
                        href={telHref}
                        onClick={(e) => e.stopPropagation()}
                        className="glass-btn min-w-[36px] min-h-[36px] p-2 rounded-xl text-[var(--text)] hover:text-[var(--accent)] transition-all flex items-center justify-center shrink-0"
                        title="اتصال بالطالب"
                      >
                        <Phone className="w-3.5 h-3.5 shrink-0" />
                      </a>
                    )}
                    {waHref && (
                      <a
                        href={waHref}
                        target="_blank"
                        rel="noreferrer"
                        onClick={(e) => e.stopPropagation()}
                        className="glass-btn min-w-[36px] min-h-[36px] p-2 rounded-xl text-[var(--text)] hover:text-[var(--accent)] transition-all flex items-center justify-center shrink-0"
                        title="محادثة واتساب"
                      >
                        <MessageSquare className="w-3.5 h-3.5 shrink-0" />
                      </a>
                    )}
                  </>
                );
              })()}
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onOpenFollowup(student);
                }}
                className="glass-btn min-h-[36px] px-2.5 py-1.5 rounded-xl text-xs font-bold text-[var(--accent)] flex items-center gap-1.5 cursor-pointer shrink-0"
              >
                <HeartHandshake className="w-3.5 h-3.5 shrink-0" />
                <span>افتقاد</span>
              </button>
            </div>

            <div className="flex items-center gap-1.5 shrink-0">
              <button
                type="button"
                aria-disabled={isAnotherCardEditing}
                onClick={(e) => {
                  e.stopPropagation();
                  onOpenEdit(student);
                }}
                className={`glass-btn min-w-[36px] min-h-[36px] p-2 rounded-xl text-[var(--text)] cursor-pointer flex items-center justify-center shrink-0 ${
                  isAnotherCardEditing ? 'opacity-50' : ''
                }`}
                title={isAnotherCardEditing ? 'يوجد كارت آخر قيد التعديل حالياً' : 'تعديل مباشر'}
                aria-label={`تعديل ${student.name}`}
              >
                <Edit3 className="w-3.5 h-3.5 shrink-0" />
              </button>

              <button
                type="button"
                onClick={handleToggleFlip}
                aria-expanded={isFlipped}
                aria-controls={`student-card-back-${student.id}`}
                className="glass-btn--primary btn--lens min-h-[36px] px-3 py-1.5 text-xs flex items-center gap-1.5 cursor-pointer shrink-0"
                title={isFlipped ? 'العودة للتفاصيل الأساسية' : 'عرض تفاصيل المخدوم'}
                aria-label={`${isFlipped ? 'إخفاء' : 'عرض'} تفاصيل ${student.name}`}
              >
                <RotateCw className={`w-3.5 h-3.5 shrink-0 transition-transform duration-300 ${isFlipped ? 'rotate-180' : ''}`} />
                <span>تفاصيل أكثر</span>
              </button>
            </div>
          </div>
        </div>

        {/* ==================================================== */}
        {/* BACK FACE (3D Y-Axis Flipped Details Face)           */}
        {/* ==================================================== */}
        <div
          id={`student-card-back-${student.id}`}
          aria-hidden={!isFlipped}
          inert={!isFlipped || undefined}
          className={`card-flip-face card-flip-face--back card-flip-surface box-border w-full h-full min-w-0 max-w-full p-3.5 sm:p-4 rounded-3xl shadow-[var(--shadow-card)] border-[var(--glass-border-2)] flex flex-col justify-between gap-2.5 ${
            isFlipped ? 'pointer-events-auto' : 'pointer-events-none'
          }`}
        >
          {/* Back Header */}
          <div className="flex items-start justify-between gap-2 pb-2 border-b border-[var(--glass-border)] shrink-0">
            <div className="min-w-0 flex-1">
              <span className="block text-[10.5px] font-extrabold text-[var(--accent)] mb-0.5">
                التفاصيل الإضافية للمخدوم
              </span>
              <h3 className="font-extrabold text-sm sm:text-base text-[var(--text)] leading-snug line-clamp-1 m-0">
                {student.name || 'مخدوم بدون اسم'}
              </h3>
              <div className="flex items-center gap-1.5 text-xs text-[var(--text-secondary)] mt-0.5">
                <User className="w-3.5 h-3.5 text-[var(--accent)] shrink-0" />
                <span className="font-semibold truncate">الأشبين: {student.servant || 'غير محدد'}</span>
              </div>
            </div>

            <div className="flex flex-col items-end gap-1 shrink-0">
              <span className="text-[11px] font-mono font-bold px-2 py-0.5 rounded-md bg-[var(--surface-inset)] border border-[var(--glass-border)] text-[var(--accent)]">
                {student.code || '-'}
              </span>
              <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full border ${getSheetBadge(student.sourceSheet || 'نشط')}`}>
                {student.sourceSheet || 'نشط'}
              </span>
            </div>
          </div>

          {/* Back Body (Contained scroll inside card bounds if content is long — zero page scroll) */}
          <div className={`flex-1 min-h-0 overflow-y-auto overscroll-contain space-y-2.5 text-xs pl-0.5 ${isFlipped ? 'word-in' : ''}`}>
            {/* Phones List */}
            <div className="p-2.5 rounded-2xl bg-[var(--surface-inset)] border border-[var(--glass-border)] space-y-1.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-[var(--text-muted)]">موبايل الطالب:</span>
                <div className="flex items-center gap-2 shrink-0">
                  <strong className="font-mono text-[var(--text)] selectable-text">
                    {student.phoneStudent || 'غير مسجل'}
                  </strong>
                  {formatTelHref(student.phoneStudent) && (
                    <a
                      href={formatTelHref(student.phoneStudent)!}
                      onClick={(e) => e.stopPropagation()}
                      className="text-[var(--accent)] hover:underline inline-flex items-center"
                      aria-label={`اتصال بموبايل ${student.name}`}
                    >
                      <Phone className="w-3.5 h-3.5 shrink-0" />
                    </a>
                  )}
                </div>
              </div>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-[var(--text-muted)]">ولي الأمر (1):</span>
                <div className="flex items-center gap-2 shrink-0">
                  <strong className="font-mono text-[var(--text)] selectable-text">
                    {student.phoneParent1 || 'غير مسجل'}
                  </strong>
                  {formatTelHref(student.phoneParent1) && (
                    <a
                      href={formatTelHref(student.phoneParent1)!}
                      onClick={(e) => e.stopPropagation()}
                      className="text-[var(--accent)] hover:underline inline-flex items-center"
                      aria-label={`اتصال بولي أمر ${student.name}`}
                    >
                      <Phone className="w-3.5 h-3.5 shrink-0" />
                    </a>
                  )}
                </div>
              </div>
              {student.phoneParent2 && (
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-[var(--text-muted)]">ولي الأمر (2):</span>
                  <strong className="font-mono text-[var(--text)] selectable-text">{student.phoneParent2}</strong>
                </div>
              )}
            </div>

            {/* Attendance, Birthdate & Address */}
            <div className="p-2.5 rounded-2xl bg-[var(--surface-inset)] border border-[var(--glass-border)] space-y-1.5">
              {student.lastAttendance && (
                <div className="flex items-center gap-1.5 text-[var(--text-muted)]">
                  <CheckCircle2 className="w-3.5 h-3.5 text-[var(--accent)] shrink-0" />
                  <span>
                    آخر حضور: <strong className="font-mono text-[var(--text)]">{student.lastAttendance}</strong>
                  </span>
                </div>
              )}

              <div className="flex items-center gap-1.5 text-[var(--text-muted)]">
                <Calendar className="w-3.5 h-3.5 text-[var(--accent)] shrink-0" />
                <span>
                  تاريخ الميلاد: <strong className="text-[var(--text)]">{student.birthDate || 'غير مسجل'}</strong>
                </span>
              </div>

              <div className="flex items-start gap-1.5 text-[var(--text-muted)]">
                <MapPin className="w-3.5 h-3.5 text-[var(--accent)] shrink-0 mt-0.5" />
                <span className="break-words">
                  العنوان: <strong className="text-[var(--text)]">{student.address || 'غير مسجل'}</strong>
                  {student.area ? ` (${student.area})` : ''}
                </span>
              </div>
            </div>

            {/* Followup Extra Details */}
            <div className="p-2.5 rounded-2xl bg-[var(--surface-inset)] border border-[var(--glass-border)] flex flex-wrap items-center justify-between gap-1.5 text-[11px]">
              <span className="text-[var(--text-secondary)] font-bold">
                مرات الافتقاد: <strong className="font-mono text-[var(--accent)]">{studentFollowupCount}</strong>
              </span>
              <span className="text-[var(--text-secondary)] font-bold max-w-full min-w-0 break-words">
                الوسيلة:{' '}
                <strong className={latestFollowupMethod ? 'text-[var(--accent)]' : 'text-[var(--text-muted)]'}>
                  {latestFollowupMethod || 'لم تُسجل'}
                </strong>
              </span>
              {latestPhoneCallOutcome && (
                <span className="text-[var(--text-secondary)] font-bold w-full">
                  نتيجة الاتصال:{' '}
                  <strong
                    className={
                      latestPhoneCallOutcome === 'تم التواصل'
                        ? 'text-[var(--accent)]'
                        : latestPhoneCallOutcome === 'لم يتم التواصل'
                          ? 'text-rose-400'
                          : 'text-[var(--text-muted)]'
                    }
                  >
                    {latestPhoneCallOutcome}
                  </strong>
                </span>
              )}
            </div>

            {/* Notes */}
            <div className="p-2.5 rounded-2xl bg-[var(--surface-inset)] border border-[var(--glass-border)] text-[var(--text-muted)]">
              <span className="block text-[10px] font-bold text-[var(--accent)] mb-0.5">ملاحظات الخادم:</span>
              <p className="m-0 text-[11px] leading-relaxed text-[var(--text)] break-words">
                {student.notes || 'لا توجد ملاحظات مسجلة للمخدوم.'}
              </p>
            </div>
          </div>

          {/* Back Footer (Strictly NO delete button + Clear Return Button) */}
          <div className="border-t border-[var(--glass-border)] pt-2.5 flex items-center justify-between gap-1.5 shrink-0">
            <div className="flex items-center gap-1.5 min-w-0">
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onOpenFollowup(student);
                }}
                className="glass-btn min-h-[36px] px-2.5 py-1.5 rounded-xl text-xs font-bold text-[var(--accent)] flex items-center gap-1.5 cursor-pointer shrink-0"
              >
                <HeartHandshake className="w-3.5 h-3.5 shrink-0" />
                <span>تسجيل افتقاد</span>
              </button>

              <button
                type="button"
                aria-disabled={isAnotherCardEditing}
                onClick={(e) => {
                  e.stopPropagation();
                  onOpenEdit(student);
                }}
                className={`glass-btn min-h-[36px] px-2.5 py-1.5 rounded-xl text-xs font-bold flex items-center gap-1.5 cursor-pointer shrink-0 ${
                  isAnotherCardEditing ? 'opacity-50' : ''
                }`}
                title={isAnotherCardEditing ? 'يوجد كارت آخر قيد التعديل حالياً' : 'تعديل بيانات المخدوم'}
              >
                <Edit3 className="w-3.5 h-3.5 shrink-0" />
                <span>{isThisCardEditing ? 'جاري التعديل' : 'تعديل البيانات'}</span>
              </button>
            </div>

            <button
              type="button"
              onClick={handleToggleFlip}
              aria-label={`العودة للتفاصيل الأساسية لـ ${student.name}`}
              title="العودة للتفاصيل الأساسية"
              className="glass-btn--primary btn--lens min-h-[36px] px-3 py-1.5 text-xs flex items-center gap-1.5 cursor-pointer shrink-0"
            >
              <RotateCw className="w-3.5 h-3.5 shrink-0" />
              <span>رجوع</span>
            </button>
          </div>
        </div>
      </div>
    </article>
  );
};

export const StudentCard = React.memo(StudentCardComponent);
