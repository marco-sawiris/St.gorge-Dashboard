import React, { useEffect, useState, useCallback } from 'react';
import { useApp } from '../../context/AppContext';
import { OfflineMutation } from '../../types/auth';
import { idbGetPendingMutations, idbResetMutationRetry } from '../../services/indexedDbService';
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
  Trash2
} from 'lucide-react';

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
  const [showClearConfirm, setShowClearConfirm] = useState<boolean>(false);
  const [isClearingAll, setIsClearingAll] = useState<boolean>(false);
  const [clearFeedback, setClearFeedback] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const loadMutations = useCallback(async () => {
    setIsLoading(true);
    try {
      const list = await idbGetPendingMutations();
      setMutations(list);
    } catch (err) {
      console.warn('Failed to load pending mutations from IndexedDB:', err);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (isQueueModalOpen) {
      setShowClearConfirm(false);
      setClearFeedback(null);
      loadMutations();
    }
  }, [isQueueModalOpen, loadMutations]);

  if (!isQueueModalOpen) return null;

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

  const handleConfirmClearAll = async () => {
    if (isClearingAll || isFlushing) return;
    setIsClearingAll(true);
    setClearFeedback(null);
    try {
      const { clearedCount, verifiedEmpty } = await clearOfflineQueue();
      const afterList = await idbGetPendingMutations();
      setMutations(afterList);
      setShowClearConfirm(false);

      if (verifiedEmpty && afterList.length === 0) {
        setClearFeedback({
          type: 'success',
          text: `تم مسح جميع العمليات المعلقة (${clearedCount}) من طابور المزامنة بنجاح، مع الإبقاء التام على جميع بيانات المخدومين وسجلات الحضور والافتقاد وGoogle Sheets دون أي تغيير.`
        });
      } else {
        setClearFeedback({
          type: 'error',
          text: 'تعذر التحقق من تفريغ طابور العمليات بالكامل، يرجى التحديث وإعادة المحاولة.'
        });
      }
    } catch (err: any) {
      setShowClearConfirm(false);
      setClearFeedback({
        type: 'error',
        text: err?.message || 'حدث خطأ أثناء مسح العمليات المعلقة.'
      });
    } finally {
      setIsClearingAll(false);
    }
  };

  const formatTimestamp = (ts?: number) => {
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
            ? 'bg-[var(--success-bg)] text-[var(--success-text)] border-[var(--success-border)]'
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
          badgeColor: 'bg-[var(--success-bg)] text-[var(--success-text)] border-[var(--success-border)]',
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

  const getStatusBadge = (mutation: OfflineMutation) => {
    if (mutation.status === 'conflict') {
      return {
        label: 'تعارض في الإصدار',
        badgeClass: 'bg-[var(--danger-bg)] text-[var(--danger-text)] border-[var(--danger-border)]'
      };
    }
    if (mutation.status === 'timeout_unknown') {
      return {
        label: 'نتيجة غير مؤكدة — انتهاء المهلة',
        badgeClass: 'bg-[var(--warning-bg)] text-[var(--warning-text)] border-[var(--warning-border)]'
      };
    }
    if (mutation.status === 'failed') {
      return {
        label: 'تعذر الإرسال',
        badgeClass: 'bg-[var(--danger-bg)] text-[var(--danger-text)] border-[var(--danger-border)]'
      };
    }
    if (mutation.status === 'retrying') {
      return {
        label: 'إعادة محاولة مجدولة',
        badgeClass: 'bg-[var(--info-bg)] text-[var(--info-text)] border-[var(--info-border)]'
      };
    }
    return {
      label: 'قيد الانتظار',
      badgeClass: 'bg-[var(--info-bg)] text-[var(--info-text)] border-[var(--info-border)]'
    };
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-black/60 backdrop-blur-sm animate-fadeIn select-none">
      <div className="w-full max-w-xl glass-strong rounded-3xl border border-[var(--border-color)] shadow-[var(--shadow-lg)] overflow-hidden flex flex-col max-h-[90vh] animate-wordIn">
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
                العمليات المحفوظة محلياً والمجدولة للإرسال إلى Google Sheets
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
              العمليات محفوظة بشكل دائم في قاعدة البيانات المحلية. لن تُحذف أي عملية تلقائياً حتى يؤكد Google Sheets استلامها وحفظها بنجاح.
            </div>
          </div>

          {/* Verified Clear Success / Error Feedback Banner */}
          {clearFeedback && (
            <div
              role="status"
              className={`p-3.5 rounded-2xl border flex items-start gap-2.5 text-xs font-bold leading-relaxed ${
                clearFeedback.type === 'success'
                  ? 'bg-[var(--success-bg)] border-[var(--success-border)] text-[var(--success-text)]'
                  : 'bg-[var(--danger-bg)] border-[var(--danger-border)] text-[var(--danger-text)]'
              }`}
            >
              {clearFeedback.type === 'success' ? (
                <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" />
              ) : (
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
              )}
              <span>{clearFeedback.text}</span>
            </div>
          )}

          {/* Explicit Confirmation Dialog before Clearing All Pending Queue Operations */}
          {showClearConfirm && mutations.length > 0 && (
            <div
              role="alertdialog"
              aria-modal="false"
              aria-labelledby="clear-queue-confirm-title"
              className="p-4 rounded-2xl bg-[var(--danger-bg)] border border-[var(--danger-border)] space-y-3 shadow-md"
            >
              <div className="flex items-start gap-2.5">
                <AlertTriangle className="w-5 h-5 text-[var(--danger-text)] shrink-0 mt-0.5" />
                <div className="space-y-1">
                  <h4 id="clear-queue-confirm-title" className="font-extrabold text-sm text-[var(--text-primary)] m-0">
                    تأكيد مسح جميع العمليات المعلقة؟
                  </h4>
                  <p className="text-xs text-[var(--text-secondary)] m-0 leading-relaxed">
                    سيتم حذف <strong className="text-[var(--danger-text)]">{mutations.length}</strong> عملية معلقة غير متزامنة من طابور الإرسال إلى Google Sheets ولن يتم إرسالها لاحقاً.
                  </p>
                  <p className="text-[11px] text-[var(--accent-secondary)] font-bold m-0">
                    ملاحظة أمان: لن يتم حذف أي بيانات مخدومين أو سجلات حضور وافتقاد محفوظة في قاعدة البيانات أو Google Sheets.
                  </p>
                </div>
              </div>

              <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => setShowClearConfirm(false)}
                  disabled={isClearingAll}
                  className="glass-btn px-3.5 py-2 rounded-xl text-xs font-bold text-[var(--text-primary)] cursor-pointer min-h-[38px]"
                >
                  تراجع
                </button>
                <button
                  type="button"
                  onClick={handleConfirmClearAll}
                  disabled={isClearingAll}
                  className="px-4 py-2 rounded-xl text-xs font-extrabold bg-rose-700 hover:bg-rose-800 text-white border border-rose-600 flex items-center gap-1.5 cursor-pointer min-h-[38px] disabled:opacity-50"
                >
                  <Trash2 className="w-3.5 h-3.5 shrink-0" />
                  <span>{isClearingAll ? 'جاري المسح...' : 'نعم، تأكيد مسح كل العمليات'}</span>
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
              <div className="w-12 h-12 rounded-2xl bg-[var(--success-bg)] border border-[var(--success-border)] flex items-center justify-center text-[var(--success-text)]">
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
                const statusMeta = getStatusBadge(mutation);
                const ActionIcon = actionMeta.icon;
                const isItemRetrying = retryingId === mutation.id || isFlushing;

                return (
                  <div
                    key={mutation.id || idx}
                    className="p-4 rounded-2xl bg-[var(--surface-primary)] border border-[var(--border-color)] shadow-xs space-y-3 transition-all duration-200 hover:border-[var(--primary)]/30"
                  >
                    {/* Header Row: Action Title & Status Badge */}
                    <div className="flex flex-row items-center justify-between gap-2 flex-nowrap">
                      <div className="flex flex-row items-center gap-1.5 min-w-0">
                        <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-xl text-[11px] sm:text-xs font-bold border whitespace-nowrap ${actionMeta.badgeColor}`}>
                          <ActionIcon className="w-3.5 h-3.5 shrink-0" />
                          <span>{actionMeta.title}</span>
                        </span>
                        <span className="text-[11px] font-mono text-[var(--text-muted)] shrink-0">
                          #{idx + 1}
                        </span>
                      </div>

                      <span className={`text-[10.5px] sm:text-[11px] font-bold px-2.5 py-0.5 rounded-full border whitespace-nowrap shrink-0 ${statusMeta.badgeClass}`}>
                        {statusMeta.label}
                      </span>
                    </div>

                    {/* Student Info Row */}
                    <div className="flex flex-row items-center justify-between gap-2 flex-nowrap bg-[var(--surface-inset)] p-2.5 rounded-xl border border-[var(--border-color)]">
                      <div className="flex flex-row items-center gap-1.5 min-w-0 flex-1">
                        <span className="font-extrabold text-xs sm:text-sm text-[var(--text-primary)] truncate">
                          {mutation.studentName || 'مخدوم غير محدد'}
                        </span>
                        {mutation.studentCode && (
                          <span className="text-[10px] font-mono font-bold px-1.5 py-0.5 rounded bg-[var(--surface-primary)] text-[var(--text-muted)] border border-[var(--border-color)] shrink-0">
                            {mutation.studentCode}
                          </span>
                        )}
                      </div>

                      <div className="flex items-center gap-1 text-[10px] font-bold text-[var(--accent-secondary)] whitespace-nowrap shrink-0">
                        <FileSpreadsheet className="w-3 h-3 shrink-0" />
                        <span>فصل {mutation.sourceSheet || 'نشط'}</span>
                      </div>
                    </div>

                    {/* Metadata & Details Grid */}
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
                        {mutation.lastAttemptAt && (
                          <span className="text-[10px] text-[var(--text-muted)]">
                            (آخرها: {formatTimestamp(mutation.lastAttemptAt)})
                          </span>
                        )}
                      </div>

                      {actionMeta.details && (
                        <div className="sm:col-span-2 text-[11px] font-medium text-[var(--text-secondary)] pr-5">
                          {actionMeta.details}
                        </div>
                      )}

                      {mutation.nextRetryAt && mutation.status !== 'conflict' && (
                        <div className="sm:col-span-2 flex items-center gap-1.5 text-[11px] text-[var(--text-secondary)] pr-5">
                          <Clock className="w-3.5 h-3.5 text-[var(--warning-text)] shrink-0" />
                          <span>إعادة المحاولة التلقائية المجدولة:</span>
                          <span className="font-mono font-bold text-[var(--text-primary)]">
                            {formatTimestamp(mutation.nextRetryAt)}
                          </span>
                        </div>
                      )}

                      {mutation.stageTimingsMs && (
                        <div className="sm:col-span-2 flex flex-wrap items-center gap-2 text-[10.5px] text-[var(--text-muted)] font-mono pr-5">
                          <span>الوضع: {mutation.stageTimingsMs.mode === 'batch' ? `مجمع (${mutation.stageTimingsMs.batchSize || ''})` : 'فردي'}</span>
                          {typeof mutation.stageTimingsMs.networkMs === 'number' && (
                            <span>· الشبكة: {mutation.stageTimingsMs.networkMs}ms</span>
                          )}
                          {typeof mutation.stageTimingsMs.verifyMs === 'number' && (
                            <span>· التحقق: {mutation.stageTimingsMs.verifyMs}ms</span>
                          )}
                        </div>
                      )}
                    </div>

                    {/* Error Box (if lastError exists) */}
                    {mutation.lastError && (
                      <div className={`p-3 rounded-xl border space-y-1 ${
                        mutation.status === 'timeout_unknown'
                          ? 'bg-[var(--warning-bg)] border-[var(--warning-border)] text-[var(--warning-text)]'
                          : 'bg-[var(--danger-bg)] border-[var(--danger-border)] text-[var(--danger-text)]'
                      }`}>
                        <div className="flex items-center gap-1.5 font-bold text-[11px]">
                          {mutation.status === 'timeout_unknown' ? (
                            <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                          ) : (
                            <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                          )}
                          <span>
                            {mutation.status === 'timeout_unknown'
                              ? 'حالة المهلة (يتم التحقق بالمعرف الثابت لمنع التكرار):'
                              : 'سبب تعثر الإرسال:'}
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
                        disabled={isItemRetrying || !isOnline || isClearingAll}
                        className="glass-btn min-h-[38px] px-3 py-1.5 rounded-xl text-xs font-bold text-[var(--accent-primary)] hover:border-[var(--info-border)] flex items-center gap-1.5 cursor-pointer disabled:opacity-50 whitespace-nowrap"
                      >
                        <RefreshCw className={`w-3.5 h-3.5 shrink-0 ${isItemRetrying ? 'animate-spin' : ''}`} />
                        <span>{isItemRetrying ? 'جاري الإرسال...' : 'إعادة محاولة هذه العملية'}</span>
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

            {mutations.length > 0 && (
              <button
                type="button"
                onClick={() => {
                  setClearFeedback(null);
                  setShowClearConfirm(true);
                }}
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
