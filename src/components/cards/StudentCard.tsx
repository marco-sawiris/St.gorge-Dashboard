import React, { useEffect, useMemo, useState } from 'react';
import { motion } from 'motion/react';
import { Student, APPROVED_SHEETS } from '../../types/student';
import { useApp } from '../../context/AppContext';
import { LiquidToggle } from '../glass/LiquidToggle';
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
  AlertCircle
} from 'lucide-react';
import confetti from 'canvas-confetti';
import {
  computeMonthlyAttendanceSummary,
  getLatestHeldFridayString
} from '../../utils/arabicUtils';

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
  const [activeTrackTab, setActiveTrackTab] = useState<'all' | 'att' | 'fu'>('all');

  const {
    markAttendance,
    activeEditingId,
    followupRecords,
    updateStudent,
    cancelEditing,
    setHasUnsavedEditChanges
  } = useApp();

  const isThisCardEditing = activeEditingId === student.id;
  const isAnotherCardEditing = Boolean(activeEditingId && activeEditingId !== student.id);

  // Any card that was showing its reverse/details face returns to the front as soon as editing starts.
  useEffect(() => {
    if (activeEditingId) setIsFlipped(false);
  }, [activeEditingId]);

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
  const isPresentToday = student.att?.[latestHeldFriday] === true;

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

  // Real Africa/Cairo Monthly Fridays breakdown (supports both 4 & 5 Friday months, excludes future Fridays)
  const monthlySummary = useMemo(
    () => computeMonthlyAttendanceSummary(student.att),
    [student.att]
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
            <span className="text-amber-300">توجد تغييرات غير محفوظة!</span>
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

        <div className="grid grid-cols-1 min-[420px]:grid-cols-2 min-w-0 gap-2 text-xs">
          <div className="col-span-1 min-[420px]:col-span-2">
            <label className="block text-[10.5px] font-bold text-[var(--text-secondary)] mb-0.5">الاسم *</label>
            <input
              type="text"
              required
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
              className="box-border w-full min-w-0 h-8 px-2.5 rounded-lg bg-[var(--input-bg)] border border-[var(--border-color)] text-xs font-bold text-[var(--text-primary)] focus:outline-none focus:border-[var(--border-focus)]"
            />
          </div>

          <div>
            <label className="block text-[10.5px] font-bold text-[var(--text-secondary)] mb-0.5">الأشبين *</label>
            <input
              type="text"
              required
              value={editServant}
              onChange={(e) => setEditServant(e.target.value)}
              className="box-border w-full min-w-0 h-8 px-2.5 rounded-lg bg-[var(--input-bg)] border border-[var(--border-color)] text-xs font-semibold text-[var(--text-primary)] focus:outline-none focus:border-[var(--border-focus)]"
            />
          </div>

          <div>
            <label className="block text-[10.5px] font-bold text-[var(--text-secondary)] mb-0.5">الكود</label>
            <input
              type="text"
              value={editCode}
              onChange={(e) => setEditCode(e.target.value)}
              className="box-border w-full min-w-0 h-8 px-2.5 rounded-lg bg-[var(--input-bg)] border border-[var(--border-color)] font-mono text-xs font-bold text-[#20C7E8] focus:outline-none focus:border-[var(--border-focus)]"
            />
          </div>

          <div>
            <label className="block text-[10.5px] font-bold text-[var(--text-secondary)] mb-0.5">الفصل</label>
            <select
              value={editSheet}
              onChange={(e) => setEditSheet(e.target.value)}
              className="box-border w-full min-w-0 h-8 px-2 rounded-lg bg-[var(--input-bg)] border border-[var(--border-color)] text-xs font-bold text-[var(--text-primary)] focus:outline-none focus:border-[var(--border-focus)]"
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
              className="box-border w-full min-w-0 h-8 px-2.5 rounded-lg bg-[var(--input-bg)] border border-[var(--border-color)] text-xs font-semibold text-[var(--text-primary)] focus:outline-none focus:border-[var(--border-focus)]"
            />
          </div>

          <div>
            <label className="block text-[10.5px] font-bold text-[var(--text-secondary)] mb-0.5">موبايل الطالب</label>
            <input
              type="tel"
              value={editPhoneStudent}
              onChange={(e) => setEditPhoneStudent(e.target.value)}
              className="box-border w-full min-w-0 h-8 px-2.5 rounded-lg bg-[var(--input-bg)] border border-[var(--border-color)] font-mono text-xs text-[var(--text-primary)] focus:outline-none focus:border-[var(--border-focus)]"
            />
          </div>

          <div>
            <label className="block text-[10.5px] font-bold text-[var(--text-secondary)] mb-0.5">ولي الأمر</label>
            <input
              type="tel"
              value={editPhoneParent1}
              onChange={(e) => setEditPhoneParent1(e.target.value)}
              className="box-border w-full min-w-0 h-8 px-2.5 rounded-lg bg-[var(--input-bg)] border border-[var(--border-color)] font-mono text-xs text-[var(--text-primary)] focus:outline-none focus:border-[var(--border-focus)]"
            />
          </div>

          <div>
            <label className="block text-[10.5px] font-bold text-[var(--text-secondary)] mb-0.5">تاريخ الميلاد</label>
            <input
              type="text"
              value={editBirthDate}
              onChange={(e) => setEditBirthDate(e.target.value)}
              placeholder="YYYY-MM-DD"
              className="box-border w-full min-w-0 h-8 px-2.5 rounded-lg bg-[var(--input-bg)] border border-[var(--border-color)] font-mono text-xs text-[var(--text-primary)] focus:outline-none focus:border-[var(--border-focus)]"
            />
          </div>

          <div>
            <label className="block text-[10.5px] font-bold text-[var(--text-secondary)] mb-0.5">العنوان</label>
            <input
              type="text"
              value={editAddress}
              onChange={(e) => setEditAddress(e.target.value)}
              className="box-border w-full min-w-0 h-8 px-2.5 rounded-lg bg-[var(--input-bg)] border border-[var(--border-color)] text-xs text-[var(--text-primary)] focus:outline-none focus:border-[var(--border-focus)]"
            />
          </div>

          <div className="col-span-1 min-[420px]:col-span-2">
            <label className="block text-[10.5px] font-bold text-[var(--text-secondary)] mb-0.5">ملاحظات</label>
            <textarea
              rows={2}
              value={editNotes}
              onChange={(e) => setEditNotes(e.target.value)}
              className="box-border w-full min-w-0 p-2 rounded-lg bg-[var(--input-bg)] border border-[var(--border-color)] text-xs text-[var(--text-primary)] focus:outline-none focus:border-[var(--border-focus)] resize-none"
            />
          </div>
        </div>

        <div className="border-t border-[var(--border-color)] pt-2.5 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={handleInlineCancel}
            className="glass-btn px-3.5 py-1.5 rounded-xl text-xs font-bold text-[var(--text-secondary)] cursor-pointer"
          >
            إلغاء
          </button>
          <button
            type="submit"
            disabled={isSavingEdit}
            className="glass-btn--primary btn--lens px-4 py-1.5 rounded-xl text-xs font-extrabold flex items-center gap-1.5 cursor-pointer"
          >
            <Save className="w-3.5 h-3.5 text-white" />
            <span>{isSavingEdit ? 'جاري الحفظ...' : 'حفظ التعديلات'}</span>
          </button>
        </div>
      </form>
    );
  }

  return (
    <div className="perspective-1000 box-border w-full min-w-0 max-w-full overflow-x-clip select-none">
      {/* CSS Grid Stacking ensures ZERO clipping and ZERO internal scrollbar across any viewport */}
      <div
        className={`grid box-border w-full min-w-0 max-w-full duration-500 ease-[var(--ease-spring)] transform-style-preserve-3d transition-transform ${
          isFlipped ? 'rotate-y-180' : ''
        }`}
      >
        {/* ==================================================== */}
        {/* FRONT OF CARD (Liquid Glass)                         */}
        {/* ==================================================== */}
        <div className="col-start-1 row-start-1 backface-hidden box-border w-full min-w-0 max-w-full p-3.5 sm:p-4 rounded-3xl glass shadow-[0_12px_32px_0_rgba(3,7,17,0.7)] flex flex-col justify-between gap-2.5 transition-all duration-300 hover:border-[var(--glass-border-2)] hover:shadow-[0_14px_40px_rgba(32,199,232,0.25)]">
          <div className="min-w-0 space-y-2.5">
            {/* Top Row: Full Name, Servant, Code & Sheet (No Initials Avatar) */}
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0 flex-1">
                <h3 className="font-extrabold text-sm sm:text-base text-[var(--text)] leading-snug line-clamp-1 m-0">
                  {student.name}
                </h3>
                <div className="flex items-center gap-1.5 text-xs text-[var(--text-secondary)] mt-0.5">
                  <User className="w-3.5 h-3.5 text-[var(--accent)] shrink-0" />
                  <span className="font-semibold truncate">الأشبين: {student.servant}</span>
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

            {/* Quick Attendance Toggle Row (LiquidToggle Switch + Status Badge, Zero Green) */}
            <div
              className={`w-full py-1.5 px-3 rounded-xl font-bold text-xs flex items-center justify-between gap-2 transition-all duration-300 border ${
                isPresentToday
                  ? 'bg-gradient-to-r from-[#123FCE]/45 to-[#20C7E8]/25 text-white border-[#20C7E8]/60 shadow-[0_0_16px_rgba(32,199,232,0.35)]'
                  : 'bg-[var(--navy)]/60 border-[var(--glass-border)] text-[var(--text-secondary)]'
              }`}
            >
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  void handleAttendanceToggle(!isPresentToday);
                }}
                disabled={isAttendanceLoading}
                className="flex items-center gap-1.5 min-w-0 text-right cursor-pointer disabled:opacity-50"
              >
                {isPresentToday ? (
                  <>
                    <CheckCircle2 className="w-4 h-4 text-[#20C7E8] shrink-0 drop-shadow-[0_0_6px_rgba(32,199,232,0.8)]" />
                    <span className="truncate font-extrabold text-[var(--text-primary)]">
                      حاضر الجمعة ({latestHeldFriday})
                    </span>
                  </>
                ) : (
                  <>
                    <XCircle className="w-4 h-4 text-slate-400 shrink-0" />
                    <span className="truncate">تسجيل حضور الجمعة ({latestHeldFriday})</span>
                  </>
                )}
              </button>

              <LiquidToggle
                size="sm"
                checked={isPresentToday}
                loading={isAttendanceLoading}
                onChange={(next) => handleAttendanceToggle(next, latestHeldFriday)}
                label={`تسجيل حضور ${student.name}`}
              />
            </div>

            {/* Compact Metrics Row */}
            <div className="grid grid-cols-2 gap-2 text-center">
              <div className="py-1.5 px-2.5 rounded-xl bg-[var(--navy)]/50 border border-[var(--glass-border)] flex items-center justify-between">
                <span className="text-[10px] text-[var(--text-muted)] font-semibold">إجمالي الحضور</span>
                <strong className="text-sm font-mono text-[var(--accent)] tabular-nums">{student.attendanceTotal}</strong>
              </div>
              <div className="py-1.5 px-2.5 rounded-xl bg-[var(--navy)]/50 border border-[var(--glass-border)] flex items-center justify-between">
                <span className="text-[10px] text-[var(--text-muted)] font-semibold">حضور الشهر</span>
                <strong className="text-sm font-mono text-[var(--primary)] tabular-nums">
                  {`${monthlySummary.presentCount}/${monthlySummary.heldCount}`}
                </strong>
              </div>
            </div>

            {/* Monthly Attendance (Dynamic 4 or 5 Cairo Fridays: Green/Red/Neutral) & Followup Panel */}
            <div className="card-dual-tracks flex flex-col gap-2 p-2.5 rounded-2xl bg-[var(--navy)]/55 border border-[var(--glass-border)]">
              <div className="flex items-center justify-between gap-1 pb-1 border-b border-[var(--glass-border)]/60">
                <div className="flex items-center gap-1" role="tablist" aria-label={`تبويبات سجل ${student.name}`}>
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

              {/* Track 1: Monthly Attendance (All Fridays of Current Cairo Month — Green=Present, Red=Absent, Neutral=Unrecorded/Future) */}
              {(activeTrackTab === 'all' || activeTrackTab === 'att') && (
                <div className="flex flex-col gap-1.5 word-in" style={{ '--i': 0 } as React.CSSProperties}>
                  <div className="flex items-center justify-between text-[11px]">
                    <span className="font-bold text-[var(--text-secondary)] flex items-center gap-1">
                      <Calendar className="w-3 h-3 text-[var(--accent)]" />
                      <span>الحضور الشهري</span>
                    </span>
                    <span className="font-mono font-extrabold text-[var(--accent)] tabular-nums">
                      {`${monthlySummary.presentCount}/${monthlySummary.heldCount}`}
                    </span>
                  </div>

                  <div
                    className={`grid ${
                      monthlySummary.totalFridaysInMonth === 5 ? 'grid-cols-5 gap-1' : 'grid-cols-4 gap-1.5'
                    }`}
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
                          title={`ج${friday.fridayNumber} (${friday.date}) — ${stateTitle}`}
                          aria-label={`الجمعة ${friday.fridayNumber} بتاريخ ${friday.shortLabel}: ${stateTitle}`}
                          className={`rounded-lg py-1 px-0.5 text-center border transition-all ${stateStyle} ${
                            friday.isFuture
                              ? 'cursor-default opacity-65'
                              : 'cursor-pointer hover:brightness-110 active:scale-95'
                          }`}
                        >
                          <div className="text-[8.5px] font-bold opacity-85 leading-none">
                            {`ج${friday.fridayNumber}`}
                          </div>
                          <div className="text-[9.5px] font-mono font-extrabold leading-tight mt-0.5">
                            {friday.shortLabel}
                          </div>
                          <div className="text-[9px] font-extrabold leading-none mt-0.5">
                            {stateSymbol}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Track 2: Followup Summary (Status + Count + Method) */}
              {(activeTrackTab === 'all' || activeTrackTab === 'fu') && (
                <div
                  className="flex flex-col gap-1.5 pt-1 border-t border-[var(--glass-border)]/45 word-in"
                  style={{ '--i': 1 } as React.CSSProperties}
                >
                  <div className="flex items-center justify-between gap-1.5 text-[11px]">
                    <span className="font-bold text-[var(--text-secondary)] flex items-center gap-1 shrink-0">
                      <HeartHandshake className="w-3 h-3 text-[var(--primary)]" />
                      <span>{`الافتقاد (${studentFollowupCount})`}</span>
                    </span>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        onOpenFollowup(student);
                      }}
                      className={`text-[10.5px] font-extrabold px-2 py-0.5 rounded-md transition-colors cursor-pointer truncate ${
                        hasFollowup
                          ? 'text-[var(--accent)] bg-[var(--accent)]/12 hover:bg-[var(--accent)]/22'
                          : 'text-rose-400 bg-rose-500/12 hover:bg-rose-500/22'
                      }`}
                      title="انقر لتسجيل أو تحديث الافتقاد"
                    >
                      {hasFollowup ? cleanFollowupStatus : 'بحاجة لافتقاد'}
                    </button>
                  </div>

                  {/* Followup Method & Real Count Row */}
                  <div className="flex flex-wrap items-center justify-between gap-1.5 text-[10px]">
                    <span className="px-2 py-0.5 rounded-md bg-[var(--navy)]/75 border border-[var(--glass-border)] text-[var(--text-secondary)] font-bold">
                      عدد المرات: <strong className="font-mono text-[var(--accent)]">{studentFollowupCount}</strong>
                    </span>
                    <span className="px-2 py-0.5 rounded-md bg-[var(--navy)]/75 border border-[var(--glass-border)] text-[var(--text-secondary)] font-bold truncate max-w-[60%]">
                      الوسيلة:{' '}
                      <strong className={latestFollowupMethod ? 'text-[var(--accent)]' : 'text-[var(--text-muted)]'}>
                        {latestFollowupMethod || 'لم تُسجل'}
                      </strong>
                    </span>
                  </div>
                </div>
              )}
            </div>

            {/* Area & Address preview */}
            <div className="flex items-center gap-1.5 text-xs text-[var(--text-muted)] line-clamp-1">
              <MapPin className="w-3.5 h-3.5 text-[var(--accent)] shrink-0" />
              <span className="truncate">المنطقة: <strong className="text-[var(--text)]">{student.area}</strong>{student.address ? ` - ${student.address}` : ''}</span>
            </div>
          </div>

          {/* Front Footer: Quick Actions + 3D Flip (Always visible, never clipped) */}
          <div className="border-t border-[var(--glass-border)] pt-2.5 flex items-center justify-between gap-1.5">
            <div className="flex items-center gap-1">
              {student.phoneStudent && (
                <a
                  href={`tel:${student.phoneStudent}`}
                  onClick={(e) => e.stopPropagation()}
                  className="glass-btn p-2 rounded-xl text-[var(--text)] hover:text-[var(--accent)] transition-all"
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
                  className="glass-btn p-2 rounded-xl text-[var(--text)] hover:text-[var(--accent)] transition-all"
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
                className="glass-btn px-2.5 py-1.5 rounded-xl text-xs font-bold text-[var(--accent)] flex items-center gap-1 cursor-pointer"
              >
                <HeartHandshake className="w-3.5 h-3.5" />
                <span>افتقاد</span>
              </button>
            </div>

            <div className="flex items-center gap-1.5">
              <button
                type="button"
                disabled={isAnotherCardEditing}
                onClick={(e) => {
                  e.stopPropagation();
                  onOpenEdit(student);
                }}
                className="glass-btn p-2 rounded-xl text-[var(--text)] cursor-pointer"
                title={isAnotherCardEditing ? 'يوجد كارت آخر قيد التعديل حالياً' : 'تعديل مباشر'}
                aria-label={`تعديل ${student.name}`}
              >
                <Edit3 className="w-3.5 h-3.5" />
              </button>

              <button
                type="button"
                disabled={isAnotherCardEditing}
                onClick={() => setIsFlipped(true)}
                className="glass-btn--primary btn--lens px-3 py-1.5 text-xs flex items-center gap-1.5 cursor-pointer"
              >
                <RotateCw className="w-3 h-3" />
                <span>تفاصيل أكثر</span>
              </button>
            </div>
          </div>
        </div>

        {/* ==================================================== */}
        {/* BACK OF CARD (Liquid Glass)                          */}
        {/* ==================================================== */}
        <div className="col-start-1 row-start-1 backface-hidden rotate-y-180 p-3.5 sm:p-4 rounded-3xl glass-strong shadow-[0_12px_32px_0_rgba(3,7,17,0.8)] flex flex-col justify-between gap-2.5 hover:border-[var(--glass-border-2)] transition-colors">
          <div>
            {/* Top Back Row: Title + Flip Back Button */}
            <div className="flex items-center justify-between pb-2 border-b border-[var(--glass-border)] mb-2.5">
              <div className="flex items-center gap-2 min-w-0">
                <span className="text-xs font-mono font-bold text-[var(--accent)] shrink-0">{student.code}</span>
                <h4 className="font-extrabold text-sm text-[var(--text)] m-0 truncate">{student.name}</h4>
              </div>
              <button
                type="button"
                onClick={() => setIsFlipped(false)}
                className="glass-btn px-2.5 py-1 rounded-xl text-xs font-bold text-[var(--text-secondary)] hover:text-[var(--text)] flex items-center gap-1 cursor-pointer shrink-0"
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

              {/* Last attendance & Birthdate & Address */}
              {student.lastAttendance && (
                <div className="flex items-center gap-1.5 text-[var(--text-muted)]">
                  <CheckCircle2 className="w-3.5 h-3.5 text-[var(--accent)] shrink-0" />
                  <span>آخر حضور: <strong className="font-mono text-[var(--text)]">{student.lastAttendance}</strong></span>
                </div>
              )}

              <div className="flex items-center gap-1.5 text-[var(--text-muted)]">
                <Calendar className="w-3.5 h-3.5 text-[var(--accent)] shrink-0" />
                <span>تاريخ الميلاد: <strong className="text-[var(--text)]">{student.birthDate || 'غير مسجل'}</strong></span>
              </div>

              <div className="flex items-start gap-1.5 text-[var(--text-muted)]">
                <MapPin className="w-3.5 h-3.5 text-[var(--accent)] shrink-0 mt-0.5" />
                <span className="line-clamp-2">العنوان: <strong className="text-[var(--text)]">{student.address || 'غير مسجل'}</strong> ({student.area})</span>
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
              className="glass-btn--primary flex-1 py-2 px-3 rounded-xl text-xs font-bold flex items-center justify-center gap-1.5 cursor-pointer"
            >
              <HeartHandshake className="w-4 h-4" />
              <span>تسجيل افتقاد</span>
            </button>

            <button
              type="button"
              aria-disabled={isAnotherCardEditing}
              onClick={() => onOpenEdit(student)}
              className="glass-btn py-2 px-4 rounded-xl text-xs font-bold flex items-center gap-1.5 cursor-pointer"
              title={isAnotherCardEditing ? 'يوجد كارت آخر قيد التعديل حالياً' : 'تعديل بيانات المخدوم'}
            >
              <Edit3 className="w-4 h-4" />
              <span>{isThisCardEditing ? 'جاري التعديل' : 'تعديل البيانات'}</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
