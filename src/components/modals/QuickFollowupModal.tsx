import React, { useEffect, useState } from 'react';
import { Student } from '../../types/student';
import { CallOutcome } from '../../types/followup';
import { useApp } from '../../context/AppContext';
import { useAuth } from '../../context/AuthContext';
import { X, HeartHandshake, Phone, MessageSquare, Home, Mail, AlertCircle, CheckCircle2, PhoneCall, PhoneOff } from 'lucide-react';
import { formatTelHref, formatWhatsAppUrl } from '../../utils/arabicUtils';

interface QuickFollowupModalProps {
  student: Student | null;
  isOpen: boolean;
  onClose: () => void;
}

export const QuickFollowupModal: React.FC<QuickFollowupModalProps> = ({
  student,
  isOpen,
  onClose
}) => {
  const { recordFollowup } = useApp();
  const { canPerformAction } = useAuth();

  const [method, setMethod] = useState<'تم تليفونياً' | 'تم بزيارة' | 'واتساب' | 'رسالة نصية' | 'اعتذار'>('تم تليفونياً');
  const [callOutcome, setCallOutcome] = useState<CallOutcome | null>(null);
  const [notes, setNotes] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');

  useEffect(() => {
    if (isOpen) {
      setCallOutcome(null);
      setErrorMsg('');
    }
  }, [isOpen, student?.id]);

  if (!isOpen || !student) return null;

  const methodsList = [
    { id: 'تم تليفونياً', label: 'اتصال تليفوني', icon: Phone, color: 'text-[#20c7e8]' },
    { id: 'تم بزيارة', label: 'افتقاد منزلي (زيارة)', icon: Home, color: 'text-amber-400' },
    { id: 'واتساب', label: 'رسالة واتساب', icon: MessageSquare, color: 'text-[#267aff]' },
    { id: 'رسالة نصية', label: 'رسالة SMS', icon: Mail, color: 'text-[#6548f5]' },
    { id: 'اعتذار', label: 'اعتذار عن الحضور', icon: CheckCircle2, color: 'text-rose-400' }
  ] as const;

  const isPhoneCallMethod = method === 'تم تليفونياً';

  const handleSelectMethod = (nextMethod: typeof method) => {
    setMethod(nextMethod);
    setErrorMsg('');
    if (nextMethod !== 'تم تليفونياً') {
      setCallOutcome(null);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg('');

    const permission = canPerformAction('followup', student.servant);
    if (!permission.allowed) {
      setErrorMsg(permission.reason || 'العملية تتطلب تسجيل دخول موثق');
      return;
    }

    if (isPhoneCallMethod && !callOutcome) {
      setErrorMsg('يرجى تحديد نتيجة الاتصال (تم التواصل أو لم يتم التواصل) قبل الحفظ.');
      return;
    }

    setIsSubmitting(true);
    try {
      const success = await recordFollowup(
        student.id,
        method,
        notes,
        isPhoneCallMethod && callOutcome ? { callOutcome } : undefined
      );
      if (success) {
        setNotes('');
        setCallOutcome(null);
        onClose();
      } else {
        setErrorMsg('تعذر تسجيل الافتقاد محلياً في قاعدة البيانات.');
      }
    } catch (err: any) {
      setErrorMsg(err?.message || 'حدث خطأ أثناء تسجيل الافتقاد.');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-black/75 backdrop-blur-md animate-fadeIn select-none">
      <div className="w-full max-w-md glass-strong border border-[var(--border-color)] rounded-3xl shadow-[var(--shadow)] overflow-hidden flex flex-col animate-wordIn">
        {/* Header */}
        <div className="px-5 py-4 border-b border-[var(--border-color)] flex items-center justify-between bg-[var(--surface-secondary)]/60">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-xl bg-[#20c7e8]/10 border border-[#20c7e8]/30 flex items-center justify-center text-[#20c7e8] shadow-[0_0_12px_rgba(32,199,232,0.25)]">
              <HeartHandshake className="w-5 h-5" />
            </div>
            <div>
              <h3 className="font-extrabold text-base text-[var(--text-primary)] m-0">
                تسجيل افتقاد
              </h3>
              <p className="text-xs text-[var(--text-secondary)] font-semibold m-0">
                للمخدوم: <strong className="text-[var(--text-primary)]">{student.name}</strong> ({student.code})
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="إغلاق النافذة"
            className="glass-btn w-8 h-8 rounded-xl text-[var(--text-secondary)] hover:text-[var(--text-primary)] flex items-center justify-center cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <form onSubmit={handleSubmit} className="p-5 space-y-4">
          {errorMsg && (
            <div className="p-3 rounded-xl bg-red-500/15 border border-red-500/30 text-red-500 flex items-center gap-2 text-xs font-bold">
              <AlertCircle className="w-4 h-4 shrink-0" />
              <span>{errorMsg}</span>
            </div>
          )}

          <div>
            <label className="block text-xs font-bold text-[var(--text-secondary)] mb-2">طريقة الافتقاد المنفذة</label>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {methodsList.map((m) => {
                const IconComponent = m.icon;
                const isSelected = method === m.id;
                return (
                  <button
                    key={m.id}
                    type="button"
                    onClick={() => handleSelectMethod(m.id)}
                    aria-pressed={isSelected}
                    className={`glass-btn p-2.5 rounded-xl text-xs font-bold flex items-center gap-2.5 cursor-pointer ${
                      isSelected ? 'glass-btn--active' : 'text-[var(--text-primary)]'
                    }`}
                  >
                    <IconComponent className={`w-4 h-4 ${isSelected ? 'text-white' : m.color}`} />
                    <span>{m.label}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {isPhoneCallMethod && (
            <div className="p-3 rounded-2xl bg-[var(--surface-primary)]/75 border border-[#20c7e8]/30 space-y-2">
              <label className="block text-xs font-extrabold text-[var(--text-primary)]">
                نتيجة الاتصال <span className="text-rose-400">*</span>
              </label>
              <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="نتيجة الاتصال">
                <button
                  type="button"
                  role="radio"
                  aria-checked={callOutcome === 'تم التواصل'}
                  onClick={() => {
                    setCallOutcome('تم التواصل');
                    setErrorMsg('');
                  }}
                  className={`p-2.5 rounded-xl border text-xs font-extrabold flex items-center justify-center gap-2 transition-all cursor-pointer ${
                    callOutcome === 'تم التواصل'
                      ? 'bg-[#20c7e8]/20 border-[#20c7e8] text-[#20c7e8] shadow-[0_0_12px_rgba(32,199,232,0.25)]'
                      : 'bg-[var(--input-bg)] border-[var(--border-color)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
                  }`}
                >
                  <PhoneCall className="w-4 h-4 shrink-0" />
                  <span>تم التواصل</span>
                </button>
                <button
                  type="button"
                  role="radio"
                  aria-checked={callOutcome === 'لم يتم التواصل'}
                  onClick={() => {
                    setCallOutcome('لم يتم التواصل');
                    setErrorMsg('');
                  }}
                  className={`p-2.5 rounded-xl border text-xs font-extrabold flex items-center justify-center gap-2 transition-all cursor-pointer ${
                    callOutcome === 'لم يتم التواصل'
                      ? 'bg-rose-500/20 border-rose-400 text-rose-300 shadow-[0_0_12px_rgba(244,63,94,0.25)]'
                      : 'bg-[var(--input-bg)] border-[var(--border-color)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
                  }`}
                >
                  <PhoneOff className="w-4 h-4 shrink-0" />
                  <span>لم يتم التواصل</span>
                </button>
              </div>
              {!callOutcome && (
                <p className="text-[11px] font-semibold text-[var(--text-muted)] m-0">
                  اختر «تم التواصل» أو «لم يتم التواصل» قبل حفظ المكالمة.
                </p>
              )}
            </div>
          )}

          <div>
            <label className="block text-xs font-bold text-[var(--text-secondary)] mb-1">تفاصيل وملاحظات الافتقاد</label>
            <textarea
              rows={3}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="مثال: تم الاتصال بوالدة المخدوم للتأكيد على حضور القداس، ووعد بالحضور..."
              className="w-full p-3 rounded-xl bg-[var(--input-bg)] border border-[var(--border-color)] font-semibold text-xs sm:text-sm text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:border-[var(--border-focus)] resize-none"
            />
          </div>

          {/* Quick Direct Link helpers */}
          {(() => {
            const telHref = formatTelHref(student.phoneStudent);
            const waHref = formatWhatsAppUrl(student.phoneStudent);
            if (!student.phoneStudent || (!telHref && !waHref)) return null;
            return (
              <div className="p-3 rounded-xl bg-[var(--surface-primary)] border border-[var(--border-color)] flex items-center justify-between text-xs">
                <span className="text-[var(--text-secondary)] font-medium">رقم المخدوم: {student.phoneStudent}</span>
                <div className="flex items-center gap-2">
                  {telHref && (
                    <a
                      href={telHref}
                      className="px-2.5 py-1 rounded-lg bg-[var(--surface-secondary)] border border-[var(--border-color)] text-[#20c7e8] font-bold hover:brightness-110 transition-colors"
                    >
                      اتصال الآن
                    </a>
                  )}
                  {waHref && (
                    <a
                      href={waHref}
                      target="_blank"
                      rel="noreferrer"
                      className="px-2.5 py-1 rounded-lg bg-[#20c7e8]/15 border border-[#20c7e8]/30 text-[#20c7e8] font-bold hover:bg-[#20c7e8] hover:text-[#030711] transition-all"
                    >
                      فتح واتساب
                    </a>
                  )}
                </div>
              </div>
            );
          })()}

          {/* Actions */}
          <div className="pt-2 border-t border-[var(--border-color)] flex items-center justify-end gap-2.5">
            <button
              type="button"
              onClick={onClose}
              className="glass-btn px-4 py-2 rounded-xl font-bold text-xs text-[var(--text-secondary)] cursor-pointer"
            >
              إلغاء
            </button>
            <button
              type="submit"
              disabled={isSubmitting || (isPhoneCallMethod && !callOutcome)}
              className="glass-btn--primary btn--lens px-5 py-2 rounded-xl font-bold text-xs flex items-center gap-2 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <HeartHandshake className="w-4 h-4 text-[#20c7e8]" />
              <span>{isSubmitting ? 'جاري التسجيل...' : 'تسجيل الافتقاد الآن'}</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
