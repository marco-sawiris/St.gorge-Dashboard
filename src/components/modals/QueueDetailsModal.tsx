import React, { useEffect, useState, useCallback, useMemo } from 'react';
import { useApp } from '../../context/AppContext';
import { OfflineMutation } from '../../types/auth';
import { idbGetPendingMutations, idbResetMutationRetry } from '../../services/indexedDbService';
import {
  classifyMutationDisplayState,
  summarizeQueueMutations,
  QueueBadgeTone
} from '../../services/queueRecoveryService';
import {
  X,
  RefreshCw,
  Database,
  CheckCircle2,
  XCircle,
  Clock,
  AlertTriangle,
  PhoneCall,
  UserCheck,
  UserPlus,
  Edit3,
  ShieldCheck,
  AlertCircle,
  FileSpreadsheet,
  Trash2,
  Download,
  Lock,
  Info
} from 'lucide-react';

function getToneClasses(tone: QueueBadgeTone): string {
  switch (tone) {
    case 'success':
      return 'bg-[var(--success-bg)] text-[var(--success-text)] border-[var(--success-border)]';
    case 'danger':
      return 'bg-[var(--danger-bg)] text-[var(--danger-text)] border-[var(--danger-border)]';
    case 'warning':
      return 'bg-[var(--warning-bg)] text-[var(--warning-text)] border-[var(--warning-border)]';
    case 'info':
    default:
      return 'bg-[var(--info-bg)] text-[var(--info-text)] border-[var(--info-border)]';
  }
}

export const QueueDetailsModal: React.FC = () => {
  const {
    isQueueModalOpen,
    setIsQueueModalOpen,
    processOfflineQueue,
    clearOfflineQueue,
    isOnline
  } = useApp();

  const [mutations, setMutations] = useState<OfflineMutation[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [isFlushing, setIsFlushing] = useState<boolean>(false);
  const [retryingId, setRetryingId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [clearScope, setClearScope] = useState<'all' | 'selected'>('all');
  const [showClearConfirm, setShowClearConfirm] = useState<boolean>(false);
  const [clearConfirmChecked, setClearConfirmChecked] = useState<boolean>(false);
  const [isClearingAll, setIsClearingAll] = useState<boolean>(false);
  const [clearFeedback, setClearFeedback] = useState<{
    type: 'info' | 'error' | 'warn';
    text: string;
  } | null>(null);

  const loadMutations = useCallback(async () => {
    setIsLoading(true);
    try {
      const list = await idbGetPendingMutations();
      setMutations(list);
      setSelectedIds((prev) => prev.filter((id) => list.some((m) => m.id === id)));
    } catch (err) {
      console.warn('Failed to load pending mutations from IndexedDB:', err);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (isQueueModalOpen) {
      setShowClearConfirm(false);
      setClearConfirmChecked(false);
      setSelectedIds([]);
      setClearFeedback(null);
      loadMutations();
    }
  }, [isQueueModalOpen, loadMutations]);

  const queueSummary = useMemo(() => summarizeQueueMutations(mutations), [mutations]);

  const targetClearMutations = useMemo(() => {
    if (clearScope === 'selected' && selectedIds.length > 0) {
      const selSet = new Set(selectedIds);
      return mutations.filter((m) => selSet.has(m.id));
    }
    return mutations;
  }, [clearScope, selectedIds, mutations]);

  const targetClearSummary = useMemo(
    () => summarizeQueueMutations(targetClearMutations),
    [targetClearMutations]
  );

  if (!isQueueModalOpen) return null;

  const toggleMutationSelection = (mutationId: string) => {
    setSelectedIds((prev) =>
      prev.includes(mutationId) ? prev.filter((id) => id !== mutationId) : [...prev, mutationId]
    );
  };

  const handleRetryAll = async () => {
    if (isFlushing || isClearingAll) return;
    setClearFeedback(null);
    setIsFlushing(true);
    try {
      await processOfflineQueue();
      await loadMutations();
    } finally {
      setIsFlushing(false);
    }
  };

  const handleRetrySingle = async (mutationId: string) => {
    if (retryingId || isClearingAll) return;
    const target = mutations.find((m) => m.id === mutationId);
    if (!target) return;

    const stateInfo = classifyMutationDisplayState(target, mutations);
    if (!stateInfo.canManualRetry) {
      setClearFeedback({
        type: 'warn',
        text:
          stateInfo.manualRetryBlockedReason ||
          'لا يمكن إعادة محاولة هذه العملية قبل معالجة العملية الأقدم لنفس المخدوم.'
      });
      return;
    }

    setClearFeedback(null);
    setRetryingId(mutationId);
    try {
      await idbResetMutationRetry(mutationId);
      await processOfflineQueue();
      await loadMutations();
    } finally {
      setRetryingId(null);
    }
  };

  const openSafeClearDialog = (scope: 'all' | 'selected') => {
    setClearFeedback(null);
    setClearScope(scope);
    setClearConfirmChecked(false);
    setShowClearConfirm(true);
  };

  const handleConfirmClearAll = async () => {
    if (isClearingAll || isFlushing || !clearConfirmChecked) return;
    setIsClearingAll(true);
    setClearFeedback(null);
    try {
      const targetIds =
        clearScope === 'selected' && selectedIds.length > 0 ? selectedIds : undefined;
      const result = await clearOfflineQueue({
        confirmed: true,
        targetMutationIds: targetIds
      });
      const afterList = await idbGetPendingMutations();
      setMutations(afterList);
      setSelectedIds([]);
      setShowClearConfirm(false);
      setClearConfirmChecked(false);

      if (result.ok && (clearScope === 'selected' || (result.verifiedEmpty && afterList.length === 0))) {
        const backupNote = result.backupFileName
          ? ` (تم حفظ النسخة الاحتياطية: ${result.backupFileName})`
          : '';
        setClearFeedback({
          type: 'info',
          text: `تم إزالة ${result.clearedCount} عملية من الطابور بعد التحقق من النسخة الاحتياطية${backupNote}. لم يتم وسم هذه العمليات كمزامنة عن بُعد على Google Sheets، وتم تحديث حالة حماية بيانات المخدومين تلقائياً.`
        });
      } else {
        setClearFeedback({
          type: 'error',
          text:
            result.error ||
            'تعذر التحقق من تفريغ العمليات المحددة بالكامل أو تعذر التحقق من النسخة الاحتياطية — يرجى التحديث والمراجعة.'
        });
      }
    } catch (err: any) {
      setShowClearConfirm(false);
      setClearConfirmChecked(false);
      setClearFeedback({
        type: 'error',
        text: err?.message || 'حدث خطأ أثناء تفريغ العمليات المحددة — لم يتم إكمال الإزالة.'
      });
    } finally {
      setIsClearingAll(false);
    }
  };

  const formatTimestamp = (ts?: number | string) => {
    if (!ts) return 'غير محدد';
    try {
      return new Date(ts).toLocaleString('ar-EG', {
        dateStyle: 'medium',
        timeStyle: 'short'
      });
    } catch {
      return String(ts);
    }
  };

  const getActionDetails = (mutation: OfflineMutation) => {
    switch (mutation.action) {
      case 'attendance': {
        const isPresent = mutation.payload?.isPresent === true;
        return {
          title: isPresent ? 'تسجيل حضور' : 'تسجيل غياب',
          icon: isPresent ? CheckCircle2 : XCircle,
          badgeColor: isPresent
            ? 'bg-[var(--info-bg)] text-[var(--info-text)] border-[var(--info-border)]'
            : 'bg-[var(--danger-bg)] text-[var(--danger-text)] border-[var(--danger-border)]',
          details: `تاريخ الجمعة: ${mutation.payload?.friday || '-'}`
        };
      }
      case 'followup':
        return {
          title: 'تسجيل افتقاد',
          icon: PhoneCall,
          badgeColor: 'bg-[var(--info-bg)] text-[var(--info-text)] border-[var(--info-border)]',
          details: `الوسيلة: ${mutation.payload?.method || 'تم تليفونياً'} ${
            mutation.payload?.friday ? `(${mutation.payload.friday})` : ''
          }`
        };
      case 'update':
        return {
          title: 'تعديل بيانات مخدوم',
          icon: Edit3,
          badgeColor: 'bg-[var(--info-bg)] text-[var(--accent-primary)] border-[var(--info-border)]',
          details: 'تحديث بيانات السجل والاتصال'
        };
      case 'add':
        return {
          title: 'إضافة مخدوم جديد',
          icon: UserPlus,
          badgeColor: 'bg-[var(--info-bg)] text-[var(--info-text)] border-[var(--info-border)]',
          details: `الفصل المستهدف: ${mutation.sourceSheet || 'نشط'}`
        };
      default:
        return {
          title: mutation.action || 'عملية غير معروفة',
          icon: UserCheck,
          badgeColor: 'bg-[var(--surface-inset)] text-[var(--text-secondary)] border-[var(--border-color)]',
          details: '-'
        };
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-black/60 backdrop-blur-sm animate-fadeIn select-none">
      <div className="w-full max-w-2xl glass-strong rounded-3xl border border-[var(--border-color)] shadow-[var(--shadow-lg)] overflow-hidden flex flex-col max-h-[90vh] animate-wordIn">
        {/* Header */}
        <div className="px-4 sm:px-5 py-4 border-b border-[var(--border-color)] flex items-center justify-between gap-2 bg-[var(--surface-secondary)] shrink-0">
          <div className="flex items-center gap-2.5 min-w-0 flex-1">
            <div className="w-9 h-9 rounded-xl bg-[var(--warning-bg)] border border-[var(--warning-border)] flex items-center justify-center text-[var(--warning-text)] shadow-xs shrink-0">
              <Database className="w-5 h-5 shrink-0" />
            </div>
            <div className="min-w-0">
              <div className="flex flex-row items-center gap-2 flex-nowrap">
                <h3 className="font-extrabold text-sm sm:text-base text-[var(--text-primary)] m-0 leading-snug truncate">
                  طابور العمليات المعلقة
                </h3>
                <span className="text-xs font-mono font-black px-2 py-0.5 rounded-full bg-[var(--warning-bg)] text-[var(--warning-text)] border border-[var(--warning-border)] shrink-0">
                  {mutations.length}
                </span>
              </div>
              <p className="text-xs text-[var(--text-muted)] m-0 break-words leading-snug">
                العمليات المحفوظة محلياً في IndexedDB وبانتظار إثبات حفظها على Google Sheets
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={() => setIsQueueModalOpen(false)}
            aria-label="إغلاق تفاصيل طابور العمليات"
            className="glass-btn min-w-[36px] min-h-[36px] w-9 h-9 rounded-xl text-[var(--text-muted)] hover:text-[var(--text-primary)] flex items-center justify-center cursor-pointer shrink-0"
          >
            <X className="w-4 h-4 shrink-0" />
          </button>
        </div>

        {/* Body */}
        <div className="p-4 sm:p-5 overflow-y-auto space-y-3.5 text-xs sm:text-sm flex-1">
          {/* Zero Data Loss Guarantee Banner */}
          <div className="p-3.5 rounded-2xl bg-[var(--surface-inset)] border border-[var(--border-color)] flex items-start gap-2.5 text-xs text-[var(--text-secondary)] leading-relaxed">
            <ShieldCheck className="w-4 h-4 text-[var(--accent-secondary)] shrink-0 mt-0.5" />
            <div>
              <span className="font-bold text-[var(--text-primary)]">ضمان عدم فقد البيانات: </span>
              العمليات محفوظة محلياً بأمان ولن تُعتبر متزامنة ولن تُزال تلقائياً إلا بعد استلام إثبات حفظ فعلي من Google Sheets.
            </div>
          </div>

          {/* Queue Breakdown Summary Strip */}
          {mutations.length > 0 && (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-[11px]">
              <div className="p-2.5 rounded-xl bg-[var(--info-bg)] border border-[var(--info-border)] text-[var(--info-text)] flex flex-col">
                <span className="font-bold">قيد الانتظار / مجدولة</span>
                <span className="font-mono font-black text-sm mt-0.5">
                  {queueSummary.pending + queueSummary.retrying}
                </span>
              </div>
              <div className="p-2.5 rounded-xl bg-[var(--danger-bg)] border border-[var(--danger-border)] text-[var(--danger-text)] flex flex-col">
                <span className="font-bold">فشل دائم / مؤقت</span>
                <span className="font-mono font-black text-sm mt-0.5">
                  {queueSummary.failed}
                </span>
              </div>
              <div className="p-2.5 rounded-xl bg-[var(--danger-bg)] border border-[var(--danger-border)] text-[var(--danger-text)] flex flex-col">
                <span className="font-bold">تعارض إصدار (409)</span>
                <span className="font-mono font-black text-sm mt-0.5">
                  {queueSummary.conflict}
                </span>
              </div>
              <div className="p-2.5 rounded-xl bg-[var(--warning-bg)] border border-[var(--warning-border)] text-[var(--warning-text)] flex flex-col">
                <span className="font-bold">نتيجة غير مؤكدة / تحقق</span>
                <span className="font-mono font-black text-sm mt-0.5">
                  {queueSummary.timeoutUnknown}
                </span>
              </div>
            </div>
          )}

          {/* Feedback Banner */}
          {clearFeedback && (
            <div
              role="status"
              className={`p-3.5 rounded-2xl border flex items-start gap-2.5 text-xs font-bold leading-relaxed ${
                clearFeedback.type === 'info'
                  ? 'bg-[var(--info-bg)] border-[var(--info-border)] text-[var(--info-text)]'
                  : clearFeedback.type === 'warn'
                  ? 'bg-[var(--warning-bg)] border-[var(--warning-border)] text-[var(--warning-text)]'
                  : 'bg-[var(--danger-bg)] border-[var(--danger-border)] text-[var(--danger-text)]'
              }`}
            >
              {clearFeedback.type === 'info' ? (
                <Info className="w-4 h-4 shrink-0 mt-0.5" />
              ) : clearFeedback.type === 'warn' ? (
                <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
              ) : (
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
              )}
              <span>{clearFeedback.text}</span>
            </div>
          )}

          {/* Safe Clear Confirmation Workflow with Mandatory Fresh Backup */}
          {showClearConfirm && targetClearMutations.length > 0 && (
            <div
              role="alertdialog"
              aria-modal="false"
              aria-labelledby="clear-queue-confirm-title"
              className="p-4 rounded-2xl bg-[var(--danger-bg)] border border-[var(--danger-border)] space-y-3 shadow-md"
            >
              <div className="flex items-start gap-2.5">
                <AlertTriangle className="w-5 h-5 text-[var(--danger-text)] shrink-0 mt-0.5" />
                <div className="space-y-1.5 flex-1">
                  <h4 id="clear-queue-confirm-title" className="font-extrabold text-sm text-[var(--text-primary)] m-0">
                    {clearScope === 'selected'
                      ? `تأكيد تفريغ العمليات المحددة (${targetClearMutations.length})؟`
                      : `تأكيد مسح كل العمليات المعلقة (${targetClearMutations.length})؟`}
                  </h4>
                  <p className="text-xs text-[var(--text-secondary)] m-0 leading-relaxed">
                    تحذير هام: هذه العمليات لم يُثبت حفظها على Google Sheets بعد. إزالتها قد تؤدي إلى فقدان نهائي لهذه التعديلات غير المتزامنة ولن يتم إرسالها لاحقاً.
                  </p>

                  {/* Exact Breakdown Counts */}
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5 pt-1 text-[11px]">
                    <div className="px-2 py-1.5 rounded-lg bg-[var(--surface-primary)] border border-[var(--border-color)]">
                      <span className="text-[var(--text-muted)] block">قيد الانتظار</span>
                      <span className="font-mono font-extrabold text-[var(--text-primary)]">
                        {targetClearSummary.pending + targetClearSummary.retrying}
                      </span>
                    </div>
                    <div className="px-2 py-1.5 rounded-lg bg-[var(--surface-primary)] border border-[var(--border-color)]">
                      <span className="text-[var(--text-muted)] block">فاشلة</span>
                      <span className="font-mono font-extrabold text-[var(--danger-text)]">
                        {targetClearSummary.failed}
                      </span>
                    </div>
                    <div className="px-2 py-1.5 rounded-lg bg-[var(--surface-primary)] border border-[var(--border-color)]">
                      <span className="text-[var(--text-muted)] block">تعارض (409)</span>
                      <span className="font-mono font-extrabold text-[var(--danger-text)]">
                        {targetClearSummary.conflict}
                      </span>
                    </div>
                    <div className="px-2 py-1.5 rounded-lg bg-[var(--surface-primary)] border border-[var(--border-color)]">
                      <span className="text-[var(--text-muted)] block">نتيجة غير مؤكدة</span>
                      <span className="font-mono font-extrabold text-[var(--warning-text)]">
                        {targetClearSummary.timeoutUnknown}
                      </span>
                    </div>
                  </div>

                  {(targetClearSummary.conflict > 0 || targetClearSummary.timeoutUnknown > 0) && (
                    <p className="text-[11px] font-bold text-[var(--warning-text)] bg-[var(--warning-bg)] border border-[var(--warning-border)] rounded-lg px-2.5 py-1.5 m-0">
                      تنبيه إضافي: تشمل هذه المجموعة عمليات تعارض (409) أو عمليات بنتيجة غير مؤكدة (Timeout). تأكد من مراجعتها قبل المتابعة.
                    </p>
                  )}

                  <div className="flex items-start gap-2 text-[11px] text-[var(--accent-secondary)] font-bold pt-0.5">
                    <Download className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                    <span>
                      حماية إلزامية: سيتم إنشاء نسخة احتياطية حديثة والتحقق من مطابقة جميع المعرّفات والحمولات وتنزيلها كملف JSON قبل الإزالة. إذا تعذر حفظ أو التحقق من النسخة الاحتياطية فستُلغى العملية تلقائياً دون إزالة أي سجل.
                    </span>
                  </div>

                  <label className="flex items-start gap-2 pt-1.5 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={clearConfirmChecked}
                      onChange={(e) => setClearConfirmChecked(e.target.checked)}
                      disabled={isClearingAll}
                      className="mt-0.5 accent-rose-600 cursor-pointer"
                    />
                    <span className="text-xs font-extrabold text-[var(--text-primary)] leading-snug">
                      أؤكد فهمي أن هذه العمليات غير متزامنة وأنني أوافق على حفظ النسخة الاحتياطية أولاً ثم إزالتها من الطابور.
                    </span>
                  </label>
                </div>
              </div>

              <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => {
                    setShowClearConfirm(false);
                    setClearConfirmChecked(false);
                  }}
                  disabled={isClearingAll}
                  className="glass-btn px-3.5 py-2 rounded-xl text-xs font-bold text-[var(--text-primary)] cursor-pointer min-h-[38px]"
                >
                  تراجع
                </button>
                <button
                  type="button"
                  onClick={handleConfirmClearAll}
                  disabled={isClearingAll || !clearConfirmChecked}
                  className="px-4 py-2 rounded-xl text-xs font-extrabold bg-rose-700 hover:bg-rose-800 text-white border border-rose-600 flex items-center gap-1.5 cursor-pointer min-h-[38px] disabled:opacity-50"
                >
                  <Download className="w-3.5 h-3.5 shrink-0" />
                  <span>
                    {isClearingAll
                      ? 'جاري النسخ الاحتياطي والتحقق...'
                      : 'حفظ نسخة احتياطية موثّقة وتأكيد المسح'}
                  </span>
                </button>
              </div>
            </div>
          )}

          {isLoading ? (
            <div className="py-12 flex flex-col items-center justify-center gap-2 text-[var(--text-muted)]">
              <RefreshCw className="w-6 h-6 animate-spin text-[var(--accent-primary)]" />
              <p className="text-xs font-bold m-0">جاري تحميل العمليات من قاعدة البيانات المحلية...</p>
            </div>
          ) : mutations.length === 0 ? (
            <div className="py-12 flex flex-col items-center justify-center gap-2.5 text-center">
              <div className="w-12 h-12 rounded-2xl bg-[var(--info-bg)] border border-[var(--info-border)] flex items-center justify-center text-[var(--info-text)]">
                <CheckCircle2 className="w-6 h-6" />
              </div>
              <h4 className="font-extrabold text-sm text-[var(--text-primary)] m-0">
                طابور العمليات فارغ
              </h4>
              <p className="text-xs text-[var(--text-muted)] max-w-xs m-0">
                لا توجد أي عمليات معلقة حالياً في طابور الإرسال إلى Google Sheets.
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {mutations.map((mutation, idx) => {
                const actionMeta = getActionDetails(mutation);
                const displayState = classifyMutationDisplayState(mutation, mutations);
                const ActionIcon = actionMeta.icon;
                const isItemRetrying = retryingId === mutation.id || isFlushing;
                const isSelected = selectedIds.includes(mutation.id);

                return (
                  <div
                    key={mutation.id || idx}
                    className={`p-4 rounded-2xl bg-[var(--surface-primary)] border shadow-xs space-y-3 transition-all duration-200 ${
                      isSelected
                        ? 'border-[var(--danger-border)] ring-1 ring-[var(--danger-border)]'
                        : 'border-[var(--border-color)] hover:border-[var(--primary)]/30'
                    }`}
                  >
                    {/* Header Row: Checkbox, Action Title & Verified/Queue Status Badge */}
                    <div className="flex flex-row items-center justify-between gap-2 flex-wrap">
                      <div className="flex flex-row items-center gap-2 min-w-0">
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={() => toggleMutationSelection(mutation.id)}
                          aria-label={`تحديد عملية ${mutation.studentName || mutation.studentId}`}
                          className="accent-rose-600 cursor-pointer shrink-0"
                        />
                        <span
                          className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-xl text-[11px] sm:text-xs font-bold border whitespace-nowrap ${actionMeta.badgeColor}`}
                        >
                          <ActionIcon className="w-3.5 h-3.5 shrink-0" />
                          <span>{actionMeta.title}</span>
                        </span>
                        <span className="text-[11px] font-mono text-[var(--text-muted)] shrink-0">
                          #{idx + 1}
                        </span>
                      </div>

                      <span
                        className={`text-[10.5px] sm:text-[11px] font-bold px-2.5 py-0.5 rounded-full border whitespace-nowrap shrink-0 ${getToneClasses(
                          displayState.badgeTone
                        )}`}
                      >
                        {displayState.arabicLabel}
                      </span>
                    </div>

                    {/* Student Info Row: Name + Code + Student ID + Sheet */}
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-1.5 bg-[var(--surface-inset)] p-2.5 rounded-xl border border-[var(--border-color)]">
                      <div className="flex flex-wrap items-center gap-1.5 min-w-0 flex-1">
                        <span className="font-extrabold text-xs sm:text-sm text-[var(--text-primary)] truncate">
                          {mutation.studentName || 'مخدوم غير محدد'}
                        </span>
                        {mutation.studentCode && (
                          <span className="text-[10px] font-mono font-bold px-1.5 py-0.5 rounded bg-[var(--surface-primary)] text-[var(--text-muted)] border border-[var(--border-color)] shrink-0">
                            كود: {mutation.studentCode}
                          </span>
                        )}
                        {mutation.studentId && (
                          <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-[var(--surface-primary)] text-[var(--text-muted)] border border-[var(--border-color)] shrink-0">
                            ID: {mutation.studentId}
                          </span>
                        )}
                      </div>

                      <div className="flex items-center gap-1 text-[10px] font-bold text-[var(--accent-secondary)] whitespace-nowrap shrink-0">
                        <FileSpreadsheet className="w-3 h-3 shrink-0" />
                        <span>فصل {mutation.sourceSheet || 'نشط'}</span>
                      </div>
                    </div>

                    {/* Metadata & Verification Details Grid */}
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-[11px] text-[var(--text-secondary)]">
                      <div className="flex items-center gap-1.5">
                        <Clock className="w-3.5 h-3.5 text-[var(--text-muted)] shrink-0" />
                        <span>وقت الإنشاء: </span>
                        <span className="font-mono font-semibold text-[var(--text-primary)]">
                          {formatTimestamp(mutation.timestamp)}
                        </span>
                      </div>

                      <div className="flex items-center gap-1.5">
                        <RefreshCw className="w-3.5 h-3.5 text-[var(--text-muted)] shrink-0" />
                        <span>عدد المحاولات: </span>
                        <span className="font-mono font-bold text-[var(--text-primary)]">
                          {mutation.retryCount || 0}
                        </span>
                      </div>

                      <div className="flex items-center gap-1.5">
                        <Clock className="w-3.5 h-3.5 text-[var(--text-muted)] shrink-0" />
                        <span>آخر محاولة: </span>
                        <span className="font-mono font-semibold text-[var(--text-primary)]">
                          {mutation.lastAttemptAt ? formatTimestamp(mutation.lastAttemptAt) : 'لم تبدأ بعد'}
                        </span>
                      </div>

                      <div className="flex items-center gap-1.5">
                        <AlertCircle className="w-3.5 h-3.5 text-[var(--text-muted)] shrink-0" />
                        <span>تصنيف الخطأ: </span>
                        <span className="font-bold text-[var(--text-primary)]">
                          {displayState.errorCategoryLabel}
                        </span>
                      </div>

                      <div className="sm:col-span-2 flex items-center gap-1.5">
                        <ShieldCheck className="w-3.5 h-3.5 text-[var(--accent-secondary)] shrink-0" />
                        <span>نتيجة التحقق من الخادم: </span>
                        <span className="font-bold text-[var(--text-primary)]">
                          {displayState.verificationOutcomeLabel}
                        </span>
                        {displayState.isVerifiedRemotely && mutation.verifiedAt && (
                          <span className="text-[10px] font-mono text-[var(--success-text)]">
                            ({formatTimestamp(mutation.verifiedAt)})
                          </span>
                        )}
                      </div>

                      {actionMeta.details && (
                        <div className="sm:col-span-2 text-[11px] font-medium text-[var(--text-secondary)] pr-5">
                          {actionMeta.details}
                        </div>
                      )}

                      {mutation.nextRetryAt && !displayState.isConflict && !displayState.isPermanentFailure && (
                        <div className="sm:col-span-2 flex items-center gap-1.5 text-[11px] text-[var(--text-secondary)] pr-5">
                          <Clock className="w-3.5 h-3.5 text-[var(--warning-text)] shrink-0" />
                          <span>وقت إعادة المحاولة المجدول:</span>
                          <span className="font-mono font-bold text-[var(--text-primary)]">
                            {formatTimestamp(mutation.nextRetryAt)}
                          </span>
                        </div>
                      )}

                      {mutation.stageTimingsMs && (
                        <div className="sm:col-span-2 flex flex-wrap items-center gap-2 text-[10.5px] text-[var(--text-muted)] font-mono pr-5">
                          <span>
                            الوضع: {mutation.stageTimingsMs.mode === 'batch' ? `مجمع (${mutation.stageTimingsMs.batchSize || ''})` : 'فردي'}
                          </span>
                          {typeof mutation.stageTimingsMs.networkMs === 'number' && (
                            <span>· الشبكة: {mutation.stageTimingsMs.networkMs}ms</span>
                          )}
                          {typeof mutation.stageTimingsMs.verifyMs === 'number' && (
                            <span>· التحقق: {mutation.stageTimingsMs.verifyMs}ms</span>
                          )}
                        </div>
                      )}
                    </div>

                    {/* Clear Arabic Explanation for Permanent vs Temporary vs Conflict vs Timeout */}
                    {displayState.autoRetryExplanation && (
                      <div className="p-2.5 rounded-xl bg-[var(--surface-inset)] border border-[var(--border-color)] text-[11px] text-[var(--text-secondary)] leading-relaxed flex items-start gap-2">
                        <Info className="w-3.5 h-3.5 text-[var(--accent-primary)] shrink-0 mt-0.5" />
                        <span>{displayState.autoRetryExplanation}</span>
                      </div>
                    )}

                    {/* Ordering Guard Notice when blocked by an earlier same-student operation */}
                    {displayState.isBlockedByEarlierSameStudent && displayState.manualRetryBlockedReason && (
                      <div className="p-2.5 rounded-xl bg-[var(--warning-bg)] border border-[var(--warning-border)] text-[var(--warning-text)] text-[11px] font-bold flex items-start gap-2">
                        <Lock className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                        <span>{displayState.manualRetryBlockedReason}</span>
                      </div>
                    )}

                    {/* Error Box (if lastError exists) */}
                    {mutation.lastError && (
                      <div
                        className={`p-3 rounded-xl border space-y-1 ${
                          displayState.isTimeoutUnknown || displayState.isVerificationUnavailable
                            ? 'bg-[var(--warning-bg)] border-[var(--warning-border)] text-[var(--warning-text)]'
                            : 'bg-[var(--danger-bg)] border-[var(--danger-border)] text-[var(--danger-text)]'
                        }`}
                      >
                        <div className="flex items-center gap-1.5 font-bold text-[11px]">
                          {displayState.isTimeoutUnknown || displayState.isVerificationUnavailable ? (
                            <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                          ) : (
                            <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                          )}
                          <span>
                            {displayState.isVerificationUnavailable
                              ? 'حالة التحقق من الخادم (محفوظ محلياً بأمان):'
                              : displayState.isTimeoutUnknown
                              ? 'حالة المهلة (يتم التحقق بالمعرّف الثابت لمنع التكرار):'
                              : displayState.isConflict
                              ? 'تفاصيل تعارض الإصدار (409):'
                              : displayState.isPermanentFailure
                              ? 'تفاصيل الخطأ الدائم (توقفت المحاولة التلقائية):'
                              : 'سبب تعثر الإرسال المؤقت:'}
                          </span>
                        </div>
                        <p className="text-[11px] font-mono m-0 pr-5 leading-relaxed">
                          {mutation.lastError}
                        </p>
                      </div>
                    )}

                    {/* Action Row */}
                    <div className="flex flex-row items-center justify-end gap-2 flex-nowrap pt-1">
                      <button
                        type="button"
                        onClick={() => handleRetrySingle(mutation.id)}
                        disabled={
                          isItemRetrying ||
                          !isOnline ||
                          isClearingAll ||
                          !displayState.canManualRetry
                        }
                        title={
                          displayState.manualRetryBlockedReason ||
                          'إعادة محاولة هذه العملية فقط دون تعديل العمليات الأخرى'
                        }
                        className="glass-btn min-h-[38px] px-3 py-1.5 rounded-xl text-xs font-bold text-[var(--accent-primary)] hover:border-[var(--info-border)] flex items-center gap-1.5 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap"
                      >
                        {displayState.isBlockedByEarlierSameStudent ? (
                          <Lock className="w-3.5 h-3.5 shrink-0" />
                        ) : (
                          <RefreshCw className={`w-3.5 h-3.5 shrink-0 ${isItemRetrying ? 'animate-spin' : ''}`} />
                        )}
                        <span>
                          {displayState.isBlockedByEarlierSameStudent
                            ? 'بانتظار العملية الأقدم'
                            : isItemRetrying
                            ? 'جاري الإرسال...'
                            : 'إعادة محاولة هذه العملية'}
                        </span>
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-3 sm:px-5 py-3 border-t border-[var(--border-color)] flex flex-row items-center justify-between gap-1.5 sm:gap-2 flex-nowrap overflow-x-auto no-scrollbar bg-[var(--surface-secondary)] shrink-0">
          <div className="flex flex-row items-center gap-1.5 sm:gap-2 flex-nowrap shrink-0">
            {mutations.length > 0 && (
              <button
                type="button"
                onClick={handleRetryAll}
                disabled={isFlushing || !isOnline || isClearingAll}
                className="glass-btn--primary btn--lens px-2.5 sm:px-3.5 py-2 rounded-xl text-[11px] sm:text-xs font-bold text-white flex items-center gap-1.5 cursor-pointer disabled:opacity-50 min-h-[38px] whitespace-nowrap shrink-0"
              >
                <RefreshCw className={`w-3.5 h-3.5 shrink-0 ${isFlushing ? 'animate-spin' : ''}`} />
                <span>{isFlushing ? 'جاري الإرسال...' : `إعادة إرسال الكل (${mutations.length})`}</span>
              </button>
            )}

            {selectedIds.length > 0 && (
              <button
                type="button"
                onClick={() => openSafeClearDialog('selected')}
                disabled={isFlushing || isClearingAll}
                className="glass-btn px-2.5 sm:px-3.5 py-2 rounded-xl text-[11px] sm:text-xs font-extrabold text-[var(--danger-text)] border-[var(--danger-border)] hover:bg-[var(--danger-bg)] flex items-center gap-1.5 cursor-pointer disabled:opacity-50 min-h-[38px] whitespace-nowrap shrink-0"
              >
                <Trash2 className="w-3.5 h-3.5 shrink-0" />
                <span>تفريغ المحدد ({selectedIds.length})</span>
              </button>
            )}

            {mutations.length > 0 && (
              <button
                type="button"
                onClick={() => openSafeClearDialog('all')}
                disabled={isFlushing || isClearingAll}
                className="glass-btn px-2.5 sm:px-3.5 py-2 rounded-xl text-[11px] sm:text-xs font-extrabold text-[var(--danger-text)] border-[var(--danger-border)] hover:bg-[var(--danger-bg)] flex items-center gap-1.5 cursor-pointer disabled:opacity-50 min-h-[38px] whitespace-nowrap shrink-0"
              >
                <Trash2 className="w-3.5 h-3.5 shrink-0" />
                <span>مسح كل العمليات</span>
              </button>
            )}

            <button
              type="button"
              onClick={loadMutations}
              disabled={isLoading || isFlushing || isClearingAll}
              className="glass-btn px-2.5 sm:px-3 py-2 rounded-xl text-[11px] sm:text-xs font-bold text-[var(--text-secondary)] flex items-center gap-1.5 cursor-pointer min-h-[38px] whitespace-nowrap shrink-0"
              title="تحديث قائمة الطابور"
            >
              <RefreshCw className={`w-3.5 h-3.5 shrink-0 ${isLoading ? 'animate-spin' : ''}`} />
              <span className="hidden sm:inline">تحديث</span>
            </button>
          </div>

          <button
            type="button"
            onClick={() => setIsQueueModalOpen(false)}
            className="glass-btn px-3 sm:px-4 py-2 rounded-xl font-bold text-[11px] sm:text-xs text-[var(--text-secondary)] cursor-pointer min-h-[38px] whitespace-nowrap shrink-0"
          >
            إغلاق
          </button>
        </div>
      </div>
    </div>
  );
};
