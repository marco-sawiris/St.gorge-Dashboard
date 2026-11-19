import React, { useEffect, useMemo, useState } from 'react';
import { Student } from '../../types/student';
import { CallOutcome } from '../../types/followup';
import { useApp } from '../../context/AppContext';
import { useAuth } from '../../context/AuthContext';
import {
  X,
  HeartHandshake,
  Phone,
  MessageSquare,
  Home,
  Mail,
  AlertCircle,
  CheckCircle2,
  PhoneCall,
  PhoneOff,
  Copy,
  Check,
  ExternalLink,
  AlertTriangle
} from 'lucide-react';
import { formatTelHref, formatWhatsAppUrl } from '../../utils/arabicUtils';
import {
  FOLLOWUP_MESSAGE_TEMPLATES,
  FollowupMessageAudience,
  buildWhatsAppFollowupDeepLink,
  renderFollowupMessageTemplate,
  resolveFollowupClassName,
  resolveFollowupPhoneTarget
} from '../../data/followupMessageTemplates';

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

  // WhatsApp Follow-up Message State (independent from followup saving; NEVER auto-sends)
  const [audienceFilter, setAudienceFilter] = useState<'all' | FollowupMessageAudience>('all');
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>(FOLLOWUP_MESSAGE_TEMPLATES[0].id);
  const [messageDraft, setMessageDraft] = useState<string>('');
  const [copiedMessage, setCopiedMessage] = useState(false);
  const [whatsappFeedback, setWhatsappFeedback] = useState<string>('');

  const filteredTemplates = useMemo(() => {
    if (audienceFilter === 'all') return FOLLOWUP_MESSAGE_TEMPLATES;
    return FOLLOWUP_MESSAGE_TEMPLATES.filter((tpl) => tpl.audience === audienceFilter);
  }, [audienceFilter]);

  const phoneTarget = useMemo(() => resolveFollowupPhoneTarget(student), [student]);

  useEffect(() => {
    if (isOpen && student) {
      setCallOutcome(null);
      setErrorMsg('');
      setWhatsappFeedback('');
      setCopiedMessage(false);
      const defaultTpl =
        phoneTarget.isFallbackToStudent
          ? FOLLOWUP_MESSAGE_TEMPLATES.find((t) => t.audience === 'student') || FOLLOWUP_MESSAGE_TEMPLATES[0]
          : FOLLOWUP_MESSAGE_TEMPLATES[0];
      setAudienceFilter('all');
      setSelectedTemplateId(defaultTpl.id);
      setMessageDraft(
        renderFollowupMessageTemplate(defaultTpl, {
          studentName: student.name,
          className: resolveFollowupClassName(student.sourceSheet)
        })
      );
    }
  }, [isOpen, student?.id]);

  if (!isOpen || !student) return null;

  const methodsList = [
    { id: 'تم تليفونياً', label: 'اتصال تليفوني', icon: Phone, color: 'text-[var(--info-text)]' },
    { id: 'تم بزيارة', label: 'افتقاد منزلي (زيارة)', icon: Home, color: 'text-[var(--warning-text)]' },
    { id: 'واتساب', label: 'رسالة واتساب', icon: MessageSquare, color: 'text-[var(--accent-primary)]' },
    { id: 'رسالة نصية', label: 'رسالة SMS', icon: Mail, color: 'text-[var(--violet)]' },
    { id: 'اعتذار', label: 'اعتذار عن الحضور', icon: CheckCircle2, color: 'text-[var(--danger-text)]' }
  ] as const;

  const isPhoneCallMethod = method === 'تم تليفونياً';

  const handleSelectMethod = (nextMethod: typeof method) => {
    setMethod(nextMethod);
    setErrorMsg('');
    if (nextMethod !== 'تم تليفونياً') {
      setCallOutcome(null);
    }
  };

  const handleAudienceChange = (nextAudience: 'all' | FollowupMessageAudience) => {
    setAudienceFilter(nextAudience);
    setWhatsappFeedback('');
    const pool =
      nextAudience === 'all'
        ? FOLLOWUP_MESSAGE_TEMPLATES
        : FOLLOWUP_MESSAGE_TEMPLATES.filter((t) => t.audience === nextAudience);
    if (pool.length > 0 && !pool.some((t) => t.id === selectedTemplateId)) {
      const nextTpl = pool[0];
      setSelectedTemplateId(nextTpl.id);
      setMessageDraft(
        renderFollowupMessageTemplate(nextTpl, {
          studentName: student.name,
          className: resolveFollowupClassName(student.sourceSheet)
        })
      );
    }
  };

  const handleTemplateSelect = (nextId: string) => {
    setSelectedTemplateId(nextId);
    setWhatsappFeedback('');
    const tpl = FOLLOWUP_MESSAGE_TEMPLATES.find((t) => t.id === nextId) || FOLLOWUP_MESSAGE_TEMPLATES[0];
    setMessageDraft(
      renderFollowupMessageTemplate(tpl, {
        studentName: student.name,
        className: resolveFollowupClassName(student.sourceSheet)
      })
    );
  };

  const handleCopyDraft = async () => {
    const textToCopy = messageDraft.trim();
    if (!textToCopy) return;
    try {
      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(textToCopy);
        setCopiedMessage(true);
        setWhatsappFeedback('تم نسخ نص الرسالة بنجاح، يمكنك لصقها وإرسالها يدوياً.');
        setTimeout(() => setCopiedMessage(false), 2200);
      } else {
        setWhatsappFeedback('النسخ التلقائي غير مدعوم على هذا الجهاز؛ يمكنك تحديد النص ونسخه يدوياً.');
      }
    } catch {
      setWhatsappFeedback('تعذر النسخ التلقائي؛ يمكنك تحديد نص الرسالة ونسخه يدوياً دون أي تأثير على حفظ الافتقاد.');
    }
  };

  const activeMessageText =
    messageDraft ||
    renderFollowupMessageTemplate(selectedTemplateId, {
      studentName: student.name,
      className: resolveFollowupClassName(student.sourceSheet)
    });

  const whatsappDeepLink = phoneTarget.hasValidPhone
    ? buildWhatsAppFollowupDeepLink(phoneTarget.rawPhone, activeMessageText)
    : null;

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
      <div className="w-full max-w-lg glass-strong border border-[var(--border-color)] rounded-3xl shadow-[var(--shadow)] overflow-hidden flex flex-col max-h-[92vh] animate-wordIn">
        {/* Header */}
        <div className="px-4 sm:px-5 py-4 border-b border-[var(--border-color)] flex items-center justify-between gap-2 bg-[var(--surface-secondary)] shrink-0">
          <div className="flex items-center gap-2.5 min-w-0 flex-1">
            <div className="w-9 h-9 rounded-xl bg-[var(--info-bg)] border border-[var(--info-border)] flex items-center justify-center text-[var(--info-text)] shadow-xs shrink-0">
              <HeartHandshake className="w-5 h-5" />
            </div>
            <div className="min-w-0">
              <h3 className="font-extrabold text-base text-[var(--text-primary)] m-0 leading-snug">
                تسجيل افتقاد
              </h3>
              <p className="text-xs text-[var(--text-secondary)] font-semibold m-0 break-words leading-snug">
                للمخدوم: <strong className="text-[var(--text-primary)]">{student.name}</strong> ({student.code})
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="إغلاق النافذة"
            className="glass-btn min-w-[36px] min-h-[36px] w-9 h-9 rounded-xl text-[var(--text-secondary)] hover:text-[var(--text-primary)] flex items-center justify-center cursor-pointer shrink-0"
          >
            <X className="w-4 h-4 shrink-0" />
          </button>
        </div>

        {/* Body */}
        <form onSubmit={handleSubmit} className="p-4 sm:p-5 space-y-4 overflow-y-auto flex-1">
          {errorMsg && (
            <div className="p-3 rounded-xl bg-[var(--danger-bg)] border border-[var(--danger-border)] text-[var(--danger-text)] flex items-center gap-2 text-xs font-bold">
              <AlertCircle className="w-4 h-4 shrink-0" />
              <span>{errorMsg}</span>
            </div>
          )}

          <div>
            <label className="block text-xs font-bold text-[var(--text-secondary)] mb-2">طريقة الافتقاد المنفذة</label>
            <div className="grid grid-cols-2 gap-2">
              {methodsList.map((m) => {
                const IconComponent = m.icon;
                const isSelected = method === m.id;
                return (
                  <button
                    key={m.id}
                    type="button"
                    onClick={() => handleSelectMethod(m.id)}
                    aria-pressed={isSelected}
                    className={`glass-btn min-h-[44px] h-auto p-2.5 rounded-xl text-xs font-bold flex items-center gap-2.5 text-right cursor-pointer ${
                      isSelected ? 'glass-btn--active' : 'text-[var(--text-primary)]'
                    }`}
                  >
                    <IconComponent className={`w-4 h-4 shrink-0 ${isSelected ? 'text-white' : m.color}`} />
                    <span className="min-w-0 leading-snug">{m.label}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {isPhoneCallMethod && (
            <div className="p-3 rounded-2xl bg-[var(--surface-inset)] border border-[var(--info-border)] space-y-2">
              <label className="block text-xs font-extrabold text-[var(--text-primary)]">
                نتيجة الاتصال <span className="text-[var(--danger-text)]">*</span>
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
                      ? 'bg-[var(--info-bg)] border-[var(--info-text)] text-[var(--info-text)] shadow-sm'
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
                      ? 'bg-[var(--danger-bg)] border-[var(--danger-border)] text-[var(--danger-text)] shadow-sm'
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

          {/* WhatsApp Follow-up Message Composer (Manual Send Only — Independent of Follow-up Sync) */}
          <div
            data-testid="whatsapp-followup-section"
            className="p-3.5 rounded-2xl bg-[var(--surface-primary)] border border-[var(--border-color)] space-y-3"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2 min-w-0">
                <MessageSquare className="w-4 h-4 text-[var(--accent-primary)] shrink-0" />
                <span className="text-xs font-extrabold text-[var(--text-primary)]">
                  إرسال رسالة افتقاد عبر واتساب (اختياري)
                </span>
              </div>
              <span className="text-[10.5px] font-bold text-[var(--text-muted)]">
                20 رسالة جاهزة
              </span>
            </div>

            {/* Audience Filter Buttons */}
            <div className="grid grid-cols-4 gap-1.5" role="group" aria-label="تصنيف رسائل الافتقاد">
              {(
                [
                  { id: 'all', label: 'الكل (20)' },
                  { id: 'parent', label: 'لولي الأمر' },
                  { id: 'student', label: 'للطالب' },
                  { id: 'general', label: 'عامة' }
                ] as const
              ).map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => handleAudienceChange(tab.id)}
                  className={`min-h-[32px] px-2 py-1 rounded-lg border text-[11px] font-bold transition-colors cursor-pointer ${
                    audienceFilter === tab.id
                      ? 'bg-[var(--info-bg)] border-[var(--info-border)] text-[var(--info-text)]'
                      : 'bg-[var(--surface-secondary)] border-[var(--border-color)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
                  }`}
                >
                  {tab.label}
                </button>
              ))}
            </div>

            {/* Template Selector */}
            <div className="space-y-1">
              <label
                htmlFor="followup-whatsapp-template-select"
                className="block text-[11px] font-bold text-[var(--text-secondary)]"
              >
                اختر نص الرسالة المناسبة
              </label>
              <select
                id="followup-whatsapp-template-select"
                value={selectedTemplateId}
                onChange={(e) => handleTemplateSelect(e.target.value)}
                className="w-full min-h-[38px] px-3 py-2 rounded-xl bg-[var(--input-bg)] border border-[var(--border-color)] text-xs font-bold text-[var(--text-primary)] focus:outline-none focus:border-[var(--border-focus)]"
              >
                {filteredTemplates.map((tpl) => (
                  <option key={tpl.id} value={tpl.id}>
                    {tpl.index}. {tpl.title}
                  </option>
                ))}
              </select>
            </div>

            {/* Editable Message Preview */}
            <div className="space-y-1">
              <label
                htmlFor="followup-whatsapp-message-editor"
                className="block text-[11px] font-bold text-[var(--text-secondary)]"
              >
                معاينة وتعديل الرسالة قبل الإرسال اليدوي
              </label>
              <textarea
                id="followup-whatsapp-message-editor"
                rows={4}
                value={activeMessageText}
                onChange={(e) => {
                  setMessageDraft(e.target.value);
                  setWhatsappFeedback('');
                }}
                dir="rtl"
                className="w-full p-2.5 rounded-xl bg-[var(--input-bg)] border border-[var(--border-color)] text-xs font-semibold leading-relaxed text-[var(--text-primary)] focus:outline-none focus:border-[var(--border-focus)] resize-y select-text"
              />
            </div>

            {/* Target Phone Resolution Status (Parent Phone Priority) */}
            {phoneTarget.hasValidPhone ? (
              <div className="px-3 py-2 rounded-xl bg-[var(--surface-secondary)] border border-[var(--border-color)] flex flex-wrap items-center justify-between gap-2 text-[11px]">
                <span className="font-bold text-[var(--text-secondary)]">
                  سيتم فتح واتساب على: <strong className="text-[var(--text-primary)]">{phoneTarget.sourceLabel}</strong>
                </span>
                <span className="font-mono font-bold text-[var(--info-text)]" dir="ltr">
                  {phoneTarget.rawPhone}
                </span>
              </div>
            ) : (
              <div
                role="alert"
                className="p-2.5 rounded-xl bg-[var(--warning-bg)] border border-[var(--warning-border)] text-[var(--warning-text)] flex items-start gap-2 text-[11px] font-bold"
              >
                <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                <span>{phoneTarget.warningMessage}</span>
              </div>
            )}

            {whatsappFeedback && (
              <p className="text-[11px] font-bold text-[var(--info-text)] m-0">{whatsappFeedback}</p>
            )}

            {/* Manual WhatsApp Open + Copy Actions */}
            <div className="flex flex-wrap items-center gap-2">
              {whatsappDeepLink && (
                <a
                  href={whatsappDeepLink}
                  target="_blank"
                  rel="noopener noreferrer"
                  data-testid="whatsapp-followup-send-link"
                  className="flex-1 min-h-[38px] px-3 py-2 rounded-xl bg-emerald-700 hover:bg-emerald-800 text-white text-xs font-extrabold inline-flex items-center justify-center gap-1.5 transition-colors"
                >
                  <ExternalLink className="w-3.5 h-3.5 shrink-0" />
                  <span>إرسال عبر واتساب</span>
                </a>
              )}
              <button
                type="button"
                onClick={() => void handleCopyDraft()}
                data-testid="whatsapp-followup-copy-btn"
                className="min-h-[38px] px-3 py-2 rounded-xl bg-[var(--surface-secondary)] hover:border-[var(--info-border)] border border-[var(--border-color)] text-xs font-bold text-[var(--text-primary)] inline-flex items-center justify-center gap-1.5 cursor-pointer transition-colors"
              >
                {copiedMessage ? (
                  <>
                    <Check className="w-3.5 h-3.5 text-[var(--info-text)] shrink-0" />
                    <span>تم النسخ</span>
                  </>
                ) : (
                  <>
                    <Copy className="w-3.5 h-3.5 text-[var(--info-text)] shrink-0" />
                    <span>نسخ الرسالة</span>
                  </>
                )}
              </button>
            </div>
            <p className="text-[10.5px] font-medium text-[var(--text-muted)] m-0">
              يتم فتح واتساب فقط لمراجعة الرسالة وإرسالها يدوياً، ولا يؤثر ذلك على حفظ سجل الافتقاد أو المزامنة.
            </p>
          </div>

          {/* Quick Direct Link helpers */}
          {(() => {
            const telHref = formatTelHref(student.phoneStudent);
            const waHref = formatWhatsAppUrl(student.phoneStudent);
            if (!student.phoneStudent || (!telHref && !waHref)) return null;
            return (
              <div className="p-3 rounded-xl bg-[var(--surface-primary)] border border-[var(--border-color)] flex flex-wrap items-center justify-between gap-2 text-xs">
                <span className="text-[var(--text-secondary)] font-medium min-w-0 break-words">رقم المخدوم: {student.phoneStudent}</span>
                <div className="flex flex-wrap items-center gap-2 shrink-0">
                  {telHref && (
                    <a
                      href={telHref}
                      className="min-h-[34px] inline-flex items-center px-2.5 py-1 rounded-lg bg-[var(--surface-secondary)] border border-[var(--border-color)] text-[var(--info-text)] font-bold hover:brightness-110 transition-colors"
                    >
                      اتصال الآن
                    </a>
                  )}
                  {waHref && (
                    <a
                      href={waHref}
                      target="_blank"
                      rel="noreferrer"
                      className="min-h-[34px] inline-flex items-center px-2.5 py-1 rounded-lg bg-[var(--info-bg)] border border-[var(--info-border)] text-[var(--info-text)] font-bold hover:bg-[#123FCE] hover:text-white transition-all"
                    >
                      فتح واتساب
                    </a>
                  )}
                </div>
              </div>
            );
          })()}

          {/* Actions */}
          <div className="pt-2 border-t border-[var(--border-color)] flex flex-wrap items-center justify-end gap-2.5">
            <button
              type="button"
              onClick={onClose}
              className="glass-btn min-h-[40px] px-4 py-2 rounded-xl font-bold text-xs text-[var(--text-secondary)] cursor-pointer"
            >
              إلغاء
            </button>
            <button
              type="submit"
              disabled={isSubmitting || (isPhoneCallMethod && !callOutcome)}
              className="glass-btn--primary btn--lens min-h-[40px] px-5 py-2 rounded-xl font-bold text-xs text-white flex items-center gap-2 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <HeartHandshake className="w-4 h-4 text-white shrink-0" />
              <span>{isSubmitting ? 'جاري التسجيل...' : 'تسجيل الافتقاد الآن'}</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
