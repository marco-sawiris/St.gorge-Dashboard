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
  FileSpreadsheet
} from 'lucide-react';

export const QueueDetailsModal: React.FC = () => {
  const {
    isQueueModalOpen,
    setIsQueueModalOpen,
    processOfflineQueue,
    isOnline
  } = useApp();

  const [mutations, setMutations] = useState<OfflineMutation[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [isFlushing, setIsFlushing] = useState<boolean>(false);
  const [retryingId, setRetryingId] = useState<string | null>(null);

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
      loadMutations();
    }
  }, [isQueueModalOpen, loadMutations]);

  if (!isQueueModalOpen) return null;

  const handleRetryAll = async () => {
    if (isFlushing) return;
    setIsFlushing(true);
    try {
      await processOfflineQueue();
      await loadMutations();
    } finally {
      setIsFlushing(false);
    }
  };

  const handleRetrySingle = async (mutationId: string) => {
    if (retryingId) return;
    setRetryingId(mutationId);
    try {
      await idbResetMutationRetry(mutationId);
      await processOfflineQueue();
      await loadMutations();
    } finally {
      setRetryingId(null);
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
            ? 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30'
            : 'bg-rose-500/15 text-rose-400 border-rose-500/30',
          details: `تاريخ الجمعة: ${mutation.payload?.friday || '-'}`
        };
      }
      case 'followup':
        return {
          title: 'تسجيل افتقاد',
          icon: PhoneCall,
          badgeColor: 'bg-blue-500/15 text-blue-400 border-blue-500/30',
          details: `الوسيلة: ${mutation.payload?.method || 'تم تليفونياً'} ${
            mutation.payload?.friday ? `(${mutation.payload.friday})` : ''
          }`
        };
      case 'update':
        return {
          title: 'تعديل بيانات مخدوم',
          icon: Edit3,
          badgeColor: 'bg-indigo-500/15 text-indigo-400 border-indigo-500/30',
          details: 'تحديث بيانات السجل والاتصال'
        };
      case 'add':
        return {
          title: 'إضافة مخدوم جديد',
          icon: UserPlus,
          badgeColor: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30',
          details: `الفصل المستهدف: ${mutation.sourceSheet || 'نشط'}`
        };
      default:
        return {
          title: mutation.action || 'عملية غير معروفة',
          icon: UserCheck,
          badgeColor: 'bg-slate-500/15 text-slate-400 border-slate-500/30',
          details: '-'
        };
    }
  };

  const getStatusBadge = (mutation: OfflineMutation) => {
    if (mutation.status === 'conflict') {
      return {
        label: 'تعارض في الإصدار',
        badgeClass: 'bg-rose-500/20 text-rose-400 border-rose-500/40'
      };
    }
    if (mutation.status === 'failed') {
      return {
        label: 'تعذر الإرسال',
        badgeClass: 'bg-amber-500/20 text-amber-400 border-amber-500/40'
      };
    }
    return {
      label: 'قيد الانتظار',
      badgeClass: 'bg-blue-500/15 text-blue-400 border-blue-500/30'
    };
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-black/60 backdrop-blur-sm animate-fadeIn select-none">
      <div className="w-full max-w-xl glass-strong rounded-3xl border border-[var(--border-color)] shadow-[var(--shadow-lg)] overflow-hidden flex flex-col max-h-[90vh] animate-wordIn">
        {/* Header */}
        <div className="px-5 py-4 border-b border-[var(--border-color)] flex items-center justify-between bg-[var(--surface-primary)]/40">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-xl bg-amber-500/15 border border-amber-500/30 flex items-center justify-center text-amber-500 shadow-xs">
              <Database className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="font-extrabold text-base text-[var(--text-primary)] m-0">
                  طابور العمليات المعلقة
                </h3>
                <span className="text-xs font-mono font-black px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-500 border border-amber-500/30">
                  {mutations.length}
                </span>
              </div>
              <p className="text-xs text-[var(--text-muted)] m-0">
                العمليات المحفوظة محلياً والمجدولة للإرسال إلى Google Sheets
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={() => setIsQueueModalOpen(false)}
            aria-label="إغلاق تفاصيل طابور العمليات"
            className="glass-btn w-8 h-8 rounded-xl text-[var(--text-muted)] hover:text-[var(--text-primary)] flex items-center justify-center cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="p-4 sm:p-5 overflow-y-auto space-y-3.5 text-xs sm:text-sm flex-1">
          {/* Zero Data Loss Guarantee Banner */}
          <div className="p-3.5 rounded-2xl bg-[var(--surface-primary)]/60 border border-[var(--border-color)] flex items-start gap-2.5 text-xs text-[var(--text-secondary)] leading-relaxed">
            <ShieldCheck className="w-4 h-4 text-[var(--accent-secondary)] shrink-0 mt-0.5" />
            <div>
              <span className="font-bold text-[var(--text-primary)]">ضمان عدم فقد البيانات (Zero Data Loss): </span>
              العمليات محفوظة بشكل دائم في متصفحك (IndexedDB). لن تُحذف أي عملية حتى يؤكد Google Sheets استلامها وحفظها بنجاح.
            </div>
          </div>

          {isLoading ? (
            <div className="py-12 flex flex-col items-center justify-center gap-2 text-[var(--text-muted)]">
              <RefreshCw className="w-6 h-6 animate-spin text-[var(--primary)]" />
              <p className="text-xs font-bold m-0">جاري تحميل العمليات من قاعدة البيانات المحلية...</p>
            </div>
          ) : mutations.length === 0 ? (
            <div className="py-12 flex flex-col items-center justify-center gap-2.5 text-center">
              <div className="w-12 h-12 rounded-2xl bg-emerald-500/15 border border-emerald-500/30 flex items-center justify-center text-emerald-400">
                <CheckCircle2 className="w-6 h-6" />
              </div>
              <h4 className="font-extrabold text-sm text-[var(--text-primary)] m-0">
                طابور العمليات فارغ
              </h4>
              <p className="text-xs text-[var(--text-muted)] max-w-xs m-0">
                تم إرسال كافة التعديلات وتسجيلات الحضور بنجاح إلى Google Sheets، ولا توجد أي عمليات معلقة محلياً.
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
                    <div className="flex items-center justify-between gap-2 flex-wrap">
                      <div className="flex items-center gap-2">
                        <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-xl text-xs font-bold border ${actionMeta.badgeColor}`}>
                          <ActionIcon className="w-3.5 h-3.5" />
                          <span>{actionMeta.title}</span>
                        </span>
                        <span className="text-[11px] font-mono text-[var(--text-muted)]">
                          #{idx + 1}
                        </span>
                      </div>

                      <span className={`text-[11px] font-bold px-2.5 py-0.5 rounded-full border ${statusMeta.badgeClass}`}>
                        {statusMeta.label}
                      </span>
                    </div>

                    {/* Student Info Row */}
                    <div className="flex items-center justify-between gap-2 bg-[var(--app-bg)]/40 p-2.5 rounded-xl border border-[var(--border-color)]/60">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="font-extrabold text-xs sm:text-sm text-[var(--text-primary)] truncate">
                          {mutation.studentName || 'مخدوم غير محدد'}
                        </span>
                        {mutation.studentCode && (
                          <span className="text-[10px] font-mono font-bold px-1.5 py-0.5 rounded bg-[var(--surface-primary)] text-[var(--text-muted)] border border-[var(--border-color)]">
                            {mutation.studentCode}
                          </span>
                        )}
                      </div>

                      <div className="flex items-center gap-1 text-[10px] font-bold text-[var(--accent-secondary)] shrink-0">
                        <FileSpreadsheet className="w-3 h-3" />
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
                    </div>

                    {/* Error Box (if lastError exists) */}
                    {mutation.lastError && (
                      <div className="p-3 rounded-xl bg-rose-500/10 border border-rose-500/25 text-rose-500 dark:text-rose-400 space-y-1">
                        <div className="flex items-center gap-1.5 font-bold text-[11px]">
                          <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                          <span>سبب تعثر الإرسال:</span>
                        </div>
                        <p className="text-[11px] font-mono m-0 pr-5 leading-relaxed">
                          {mutation.lastError}
                        </p>
                      </div>
                    )}

                    {/* Action Row */}
                    <div className="flex items-center justify-end gap-2 pt-1">
                      <button
                        type="button"
                        onClick={() => handleRetrySingle(mutation.id)}
                        disabled={isItemRetrying || !isOnline}
                        className="glass-btn px-3 py-1.5 rounded-xl text-xs font-bold text-[var(--primary)] hover:border-[var(--primary)]/50 flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
                      >
                        <RefreshCw className={`w-3 h-3 ${isItemRetrying ? 'animate-spin' : ''}`} />
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
        <div className="px-5 py-3.5 border-t border-[var(--border-color)] flex flex-wrap items-center justify-between gap-2.5 bg-[var(--surface-primary)]/40">
          <div className="flex items-center gap-2">
            {mutations.length > 0 && (
              <button
                type="button"
                onClick={handleRetryAll}
                disabled={isFlushing || !isOnline}
                className="glass-btn--primary btn--lens px-4 py-2 rounded-xl text-xs font-bold flex items-center gap-2 cursor-pointer disabled:opacity-50"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${isFlushing ? 'animate-spin' : ''}`} />
                <span>{isFlushing ? 'جاري إرسال العمليات...' : `إعادة إرسال الكل (${mutations.length})`}</span>
              </button>
            )}

            <button
              type="button"
              onClick={loadMutations}
              disabled={isLoading || isFlushing}
              className="glass-btn px-3 py-2 rounded-xl text-xs font-bold text-[var(--text-secondary)] flex items-center gap-1.5 cursor-pointer"
              title="تحديث قائمة الطابور"
            >
              <RefreshCw className={`w-3 h-3 ${isLoading ? 'animate-spin' : ''}`} />
              <span className="hidden sm:inline">تحديث</span>
            </button>
          </div>

          <button
            type="button"
            onClick={() => setIsQueueModalOpen(false)}
            className="glass-btn px-4 py-2 rounded-xl font-bold text-xs text-[var(--text-secondary)] cursor-pointer"
          >
            إغلاق
          </button>
        </div>
      </div>
    </div>
  );
};
