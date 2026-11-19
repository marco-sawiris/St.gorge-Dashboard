import React, { useEffect, useState } from 'react';
import { useApp } from '../../context/AppContext';
import { idbGetPendingMutations } from '../../services/indexedDbService';
import { summarizeQueueMutations, QueueBreakdownSummary } from '../../services/queueRecoveryService';
import {
  X,
  RefreshCw,
  Wifi,
  WifiOff,
  CloudUpload,
  AlertTriangle,
  CheckCircle2,
  Clock,
  Database,
  ShieldCheck,
  ChevronLeft,
  HardDriveDownload
} from 'lucide-react';

export const SyncDetailsModal: React.FC = () => {
  const {
    isSyncModalOpen,
    setIsSyncModalOpen,
    setIsQueueModalOpen,
    setIsBackupModalOpen,
    syncState,
    isSyncing,
    isOnline,
    lastSyncError,
    lastSyncReport,
    partialSyncInfo,
    lastSuccessfulPullTime,
    lastSuccessfulPushTime,
    pendingMutationsCount,
    syncData,
    processOfflineQueue
  } = useApp();

  const [queueSummary, setQueueSummary] = useState<QueueBreakdownSummary | null>(null);

  useEffect(() => {
    if (!isSyncModalOpen) return;
    let active = true;
    idbGetPendingMutations()
      .then((list) => {
        if (active) setQueueSummary(summarizeQueueMutations(list));
      })
      .catch(() => {
        if (active) setQueueSummary(null);
      });
    return () => {
      active = false;
    };
  }, [isSyncModalOpen, pendingMutationsCount, lastSyncReport]);

  if (!isSyncModalOpen) return null;

  const handleSyncNow = async () => {
    await syncData();
  };

  const handleFlushQueue = async () => {
    await processOfflineQueue();
  };

  const statusDescriptions = {
    connected: {
      title: 'متصل وجاهز للمزامنة',
      desc: 'الاتصال بالإنترنت يعمل بصورة طبيعية، ولا توجد عمليات معلقة بانتظار الإرسال.',
      icon: Wifi,
      colorClass: 'text-[var(--accent-secondary)]'
    },
    syncing: {
      title: 'جاري تنفيذ المزامنة...',
      desc: 'يتم حالياً إرسال العمليات المعلقة وسحب البيانات المحدثة من Google Sheets.',
      icon: RefreshCw,
      colorClass: 'text-[var(--accent-primary)]'
    },
    synced: {
      title: 'تم تأكيد المزامنة مع Google Sheets',
      desc: 'تم التحقق من مطابقة البيانات المحلية مع Google Sheets ولا توجد عمليات معلقة أو غير مؤكدة.',
      icon: CheckCircle2,
      colorClass: 'text-[var(--success-text)]'
    },
    partial: {
      title: 'مزامنة جزئية — توجد فصول لم تتحقق',
      desc: 'تم تحديث الفصول المؤكدة فقط مع الاحتفاظ بالبيانات المحلية للفصول غير المؤكدة. لم يُحدَّث وقت آخر مزامنة مكتملة.',
      icon: AlertTriangle,
      colorClass: 'text-[var(--warning-text)]'
    },
    failed: {
      title: 'تعذرت المزامنة الأخيرة — البيانات محفوظة محلياً',
      desc: 'تعذر إتمام المزامنة الحالية. تم الاحتفاظ بجميع بياناتك وعملياتك محلياً في IndexedDB بأمان وبانتظار التأكيد.',
      icon: AlertTriangle,
      colorClass: 'text-[var(--danger-text)]'
    },
    offline: {
      title: 'لا يوجد اتصال بالإنترنت — وضع الحفظ المحلي',
      desc: 'أنت تعمل حالياً بدون اتصال. يتم حفظ جميع التعديلات محلياً في IndexedDB وبانتظار إرسالها وتأكيدها عند عودة الإنترنت.',
      icon: WifiOff,
      colorClass: 'text-[var(--text-muted)]'
    },
    pending: {
      title: 'محفوظة محلياً — بانتظار تأكيد المزامنة',
      desc: `لديك ${pendingMutationsCount} عملية محفوظة محلياً في طابور العمليات ولم يُثبت حفظها على Google Sheets بعد.`,
      icon: CloudUpload,
      colorClass: 'text-[var(--warning-text)]'
    }
  }[syncState];

  const StatusIcon = statusDescriptions.icon;

  const formatDateDisplay = (iso: string | null) => {
    if (!iso) return 'لم تتم مزامنة بعد';
    try {
      const d = new Date(iso);
      return d.toLocaleString('ar-EG', {
        dateStyle: 'medium',
        timeStyle: 'short'
      });
    } catch {
      return iso;
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-black/60 backdrop-blur-sm animate-fadeIn select-none">
      <div className="w-full max-w-lg glass-strong rounded-3xl border border-[var(--border-color)] shadow-[var(--shadow-lg)] overflow-hidden flex flex-col max-h-[90vh] animate-wordIn">
        {/* Modal Header */}
        <div className="px-4 sm:px-5 py-4 border-b border-[var(--border-color)] flex items-center justify-between gap-2 bg-[var(--surface-secondary)] shrink-0">
          <div className="flex items-center gap-2.5 min-w-0 flex-1">
            <div className="w-9 h-9 rounded-xl bg-[var(--surface-primary)] border border-[var(--border-color)] flex items-center justify-center text-[var(--accent-secondary)] shadow-xs shrink-0">
              <StatusIcon className={`w-5 h-5 shrink-0 ${isSyncing ? 'animate-spin' : ''}`} />
            </div>
            <div className="min-w-0">
              <h3 className="font-extrabold text-base text-[var(--text-primary)] m-0 leading-snug">
                حالة وتفاصيل المزامنة
              </h3>
              <p className="text-xs text-[var(--text-muted)] m-0 break-words leading-snug">
                المزامنة المباشرة مع Google Sheets وقاعدة البيانات المحلية
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={() => setIsSyncModalOpen(false)}
            aria-label="إغلاق نافذة حالة المزامنة"
            className="glass-btn min-w-[36px] min-h-[36px] w-9 h-9 rounded-xl text-[var(--text-muted)] hover:text-[var(--text-primary)] flex items-center justify-center cursor-pointer shrink-0"
          >
            <X className="w-4 h-4 shrink-0" />
          </button>
        </div>

        {/* Modal Body */}
        <div className="p-5 overflow-y-auto space-y-4 text-xs sm:text-sm">
          {/* Main Status Banner */}
          <div className="p-4 rounded-2xl bg-[var(--surface-primary)] border border-[var(--border-color)] shadow-xs flex items-start gap-3">
            <StatusIcon className={`w-6 h-6 shrink-0 mt-0.5 ${statusDescriptions.colorClass} ${isSyncing ? 'animate-spin' : ''}`} />
            <div className="space-y-1 flex-1">
              <h4 className="font-extrabold text-sm text-[var(--text-primary)] m-0">
                {statusDescriptions.title}
              </h4>
              <p className="text-xs text-[var(--text-secondary)] m-0 leading-relaxed">
                {statusDescriptions.desc}
              </p>
            </div>
          </div>

          {/* Partial Sync Details Notice */}
          {partialSyncInfo && partialSyncInfo.skippedSheets.length > 0 && (
            <div className="p-3.5 rounded-2xl bg-[var(--warning-bg)] border border-[var(--warning-border)] text-[var(--warning-text)] space-y-1.5">
              <div className="flex items-center gap-2 font-bold text-xs">
                <AlertTriangle className="w-4 h-4 shrink-0" />
                <span>فصول تم تخطيها لحماية البيانات المحلية:</span>
              </div>
              <p className="text-xs m-0 pr-6 leading-relaxed">
                <span className="font-bold">تم تخطيها: </span>
                {partialSyncInfo.skippedSheets.join('، ')}
              </p>
              {partialSyncInfo.appliedSheets.length > 0 && (
                <p className="text-xs m-0 pr-6 leading-relaxed opacity-90">
                  <span className="font-bold">تم تحديثها: </span>
                  {partialSyncInfo.appliedSheets.join('، ')}
                </p>
              )}
            </div>
          )}

          {/* Sync Error Notice if any */}
          {lastSyncError && (
            <div className="p-3.5 rounded-2xl bg-[var(--danger-bg)] border border-[var(--danger-border)] text-[var(--danger-text)] space-y-1">
              <div className="flex items-center gap-2 font-bold text-xs">
                <AlertTriangle className="w-4 h-4 shrink-0" />
                <span>سبب تعذر المزامنة الأخيرة:</span>
              </div>
              <p className="text-xs m-0 font-mono pr-6">
                {lastSyncError}
              </p>
            </div>
          )}

          {/* Queue Breakdown Notice when pending items exist */}
          {queueSummary && queueSummary.total > 0 && (
            <div className="p-3.5 rounded-2xl bg-[var(--surface-primary)] border border-[var(--border-color)] space-y-2">
              <div className="flex items-center justify-between gap-2">
                <span className="font-extrabold text-xs text-[var(--text-primary)]">
                  تفصيل حالات الطابور المحلي ({queueSummary.total})
                </span>
                <span className="text-[10.5px] font-bold text-[var(--warning-text)]">
                  غير مؤكدة على الخادم بعد
                </span>
              </div>
              <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
                {(queueSummary.pending + queueSummary.retrying) > 0 && (
                  <span className="px-2 py-0.5 rounded-full bg-[var(--info-bg)] text-[var(--info-text)] border border-[var(--info-border)] font-bold">
                    قيد الانتظار / مجدولة: {queueSummary.pending + queueSummary.retrying}
                  </span>
                )}
                {queueSummary.permanentFailed > 0 && (
                  <span className="px-2 py-0.5 rounded-full bg-[var(--danger-bg)] text-[var(--danger-text)] border border-[var(--danger-border)] font-bold">
                    فشل دائم: {queueSummary.permanentFailed}
                  </span>
                )}
                {queueSummary.transientFailed > 0 && (
                  <span className="px-2 py-0.5 rounded-full bg-[var(--warning-bg)] text-[var(--warning-text)] border border-[var(--warning-border)] font-bold">
                    فشل مؤقت: {queueSummary.transientFailed}
                  </span>
                )}
                {queueSummary.conflict > 0 && (
                  <span className="px-2 py-0.5 rounded-full bg-[var(--danger-bg)] text-[var(--danger-text)] border border-[var(--danger-border)] font-bold">
                    تعارض (409): {queueSummary.conflict}
                  </span>
                )}
                {queueSummary.timeoutUnknown > 0 && (
                  <span className="px-2 py-0.5 rounded-full bg-[var(--warning-bg)] text-[var(--warning-text)] border border-[var(--warning-border)] font-bold">
                    نتيجة غير مؤكدة: {queueSummary.timeoutUnknown}
                  </span>
                )}
                {queueSummary.verificationUnavailable > 0 && (
                  <span className="px-2 py-0.5 rounded-full bg-[var(--warning-bg)] text-[var(--warning-text)] border border-[var(--warning-border)] font-bold">
                    تعذر التحقق: {queueSummary.verificationUnavailable}
                  </span>
                )}
              </div>
            </div>
          )}

          {/* Last Queue Execution Outcome & Stage Timings */}
          {lastSyncReport && (
            <div className="p-3.5 rounded-2xl bg-[var(--surface-primary)] border border-[var(--border-color)] space-y-2">
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <span className="font-extrabold text-xs text-[var(--text-primary)]">
                  ملخص آخر دورة إرسال للطابور
                </span>
                <span className={`text-[11px] font-extrabold px-2 py-0.5 rounded-full border ${
                  lastSyncReport.outcome === 'success' && lastSyncReport.remainingCount === 0
                    ? 'bg-[var(--success-bg)] text-[var(--success-text)] border-[var(--success-border)]'
                    : lastSyncReport.outcome === 'timeout_unknown'
                    ? 'bg-[var(--warning-bg)] text-[var(--warning-text)] border-[var(--warning-border)]'
                    : lastSyncReport.outcome === 'conflict' || lastSyncReport.outcome === 'failed'
                    ? 'bg-[var(--danger-bg)] text-[var(--danger-text)] border-[var(--danger-border)]'
                    : 'bg-[var(--info-bg)] text-[var(--info-text)] border-[var(--info-border)]'
                }`}>
                  {lastSyncReport.outcome === 'success' && lastSyncReport.remainingCount === 0
                    ? 'تم تأكيد الحفظ على Google Sheets'
                    : lastSyncReport.outcome === 'timeout_unknown'
                    ? 'نتيجة غير مؤكدة — انتهاء المهلة'
                    : lastSyncReport.outcome === 'conflict'
                    ? 'تعارض إصدار (409)'
                    : lastSyncReport.outcome === 'failed'
                    ? 'تعذر الإرسال — محفوظ محلياً'
                    : 'قيد الانتظار — بانتظار المزامنة'}
                </span>
              </div>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] font-mono text-[var(--text-secondary)]">
                <span>مؤكد عن بُعد: {lastSyncReport.sentCount}</span>
                <span>متبقي: {lastSyncReport.remainingCount}</span>
                {lastSyncReport.verifiedPostTimeoutCount > 0 && (
                  <span className="text-[var(--success-text)] font-bold">تحقق بعد Timeout: {lastSyncReport.verifiedPostTimeoutCount}</span>
                )}
                <span>الوضع: {lastSyncReport.mode === 'batch' ? 'دفعة مجمعة' : lastSyncReport.mode === 'mixed' ? 'مختلط' : 'فردي'}</span>
                <span>الزمن الكلي: {lastSyncReport.totalDurationMs}ms</span>
                {lastSyncReport.stageSummary && (
                  <span>
                    (تحضير {lastSyncReport.stageSummary.prepMs}ms · شبكة {lastSyncReport.stageSummary.networkMs}ms
                    {lastSyncReport.stageSummary.verifyMs > 0 ? ` · تحقق ${lastSyncReport.stageSummary.verifyMs}ms` : ''}
                    {lastSyncReport.stageSummary.serverMs > 0 ? ` · خادم ${lastSyncReport.stageSummary.serverMs}ms` : ''})
                  </span>
                )}
              </div>
            </div>
          )}

          {/* Metrics Grid */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {/* Online Status */}
            <div className="p-3.5 rounded-2xl bg-[var(--surface-primary)] border border-[var(--border-color)] flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2 min-w-0">
                {isOnline ? (
                  <Wifi className="w-4 h-4 text-[var(--accent-secondary)] shrink-0" />
                ) : (
                  <WifiOff className="w-4 h-4 text-[var(--text-muted)] shrink-0" />
                )}
                <span className="font-bold text-xs text-[var(--text-secondary)]">اتصال الشبكة</span>
              </div>
              <span className={`text-xs font-extrabold px-2 py-0.5 rounded-full border shrink-0 ${
                isOnline
                  ? 'bg-[var(--info-bg)] text-[var(--info-text)] border-[var(--info-border)]'
                  : 'bg-[var(--surface-inset)] text-[var(--text-muted)] border-[var(--border-color)]'
              }`}>
                {isOnline ? 'متصل' : 'غير متصل'}
              </span>
            </div>

            {/* Offline Pending Queue */}
            <button
              type="button"
              onClick={() => {
                setIsQueueModalOpen(true);
              }}
              className="p-3.5 rounded-2xl bg-[var(--surface-primary)] border border-[var(--border-color)] hover:border-[var(--warning-border)] flex flex-wrap items-center justify-between gap-2 text-right cursor-pointer transition-all duration-200 group active:scale-[0.99]"
              title="اضغط لعرض تفاصيل العمليات المعلقة"
              aria-label="عرض تفاصيل طابور العمليات المعلقة"
            >
              <div className="flex items-center gap-2 min-w-0">
                <Database className="w-4 h-4 text-[var(--warning-text)] shrink-0 group-hover:scale-110 transition-transform" />
                <div className="flex flex-col text-right min-w-0">
                  <span className="font-bold text-xs text-[var(--text-secondary)]">طابور العمليات</span>
                  <span className="text-[10px] text-[var(--text-muted)] group-hover:text-[var(--warning-text)] transition-colors">
                    اضغط لعرض التفاصيل
                  </span>
                </div>
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                <span className={`text-xs font-extrabold px-2.5 py-0.5 rounded-full font-mono border ${
                  pendingMutationsCount > 0
                    ? 'bg-[var(--warning-bg)] text-[var(--warning-text)] border-[var(--warning-border)]'
                    : 'bg-[var(--info-bg)] text-[var(--info-text)] border-[var(--info-border)]'
                }`}>
                  {pendingMutationsCount} معلق
                </span>
                <ChevronLeft className="w-4 h-4 text-[var(--text-muted)] shrink-0 group-hover:text-[var(--text-primary)] transition-colors" />
              </div>
            </button>

            {/* Last Successful Pull */}
            <div className="p-3.5 rounded-2xl bg-[var(--surface-primary)] border border-[var(--border-color)] space-y-1">
              <div className="flex items-center gap-2 text-xs font-bold text-[var(--text-muted)]">
                <Clock className="w-3.5 h-3.5 text-[var(--accent-secondary)] shrink-0" />
                <span>آخر سحب من الشيت (Pull)</span>
              </div>
              <p className="font-mono text-xs font-bold text-[var(--text-primary)] m-0 break-words">
                {formatDateDisplay(lastSuccessfulPullTime)}
              </p>
            </div>

            {/* Last Successful Push */}
            <div className="p-3.5 rounded-2xl bg-[var(--surface-primary)] border border-[var(--border-color)] space-y-1">
              <div className="flex items-center gap-2 text-xs font-bold text-[var(--text-muted)]">
                <Clock className="w-3.5 h-3.5 text-[var(--accent-primary)] shrink-0" />
                <span>آخر إرسال للشيت (Push)</span>
              </div>
              <p className="font-mono text-xs font-bold text-[var(--text-primary)] m-0 break-words">
                {formatDateDisplay(lastSuccessfulPushTime)}
              </p>
            </div>
          </div>

          {/* Sync & Security Guarantee Notice */}
          <div className="p-3.5 rounded-2xl bg-[var(--surface-inset)] border border-[var(--border-color)] text-xs text-[var(--text-secondary)] leading-relaxed flex items-start gap-2.5">
            <ShieldCheck className="w-4 h-4 text-[var(--accent-secondary)] shrink-0 mt-0.5" />
            <div>
              <span className="font-bold text-[var(--text-primary)]">حماية الاتصال وعدم فقد البيانات: </span>
              إعدادات الربط مع Google Sheets محمية ومضبوطة داخلياً، وتعتمد المنظومة آلية التخزين المحلي أولاً مع طابور العمليات التلقائي لضمان حفظ كافة السجلات.
            </div>
          </div>
        </div>

        {/* Modal Footer Actions */}
        <div className="px-4 sm:px-5 py-3.5 border-t border-[var(--border-color)] flex flex-wrap items-center justify-between gap-2.5 bg-[var(--surface-secondary)] shrink-0">
          <div className="flex flex-wrap items-center gap-2">
            {pendingMutationsCount > 0 && (
              <button
                type="button"
                onClick={handleFlushQueue}
                disabled={isSyncing || !isOnline}
                className="glass-btn min-h-[40px] px-3.5 py-2 rounded-xl border-[var(--warning-border)] text-[var(--warning-text)] text-xs font-bold flex items-center gap-1.5 cursor-pointer"
              >
                <CloudUpload className="w-3.5 h-3.5 shrink-0" />
                <span>إرسال المعلق ({pendingMutationsCount})</span>
              </button>
            )}

            <button
              type="button"
              onClick={handleSyncNow}
              disabled={isSyncing}
              className="glass-btn--primary btn--lens min-h-[40px] px-4 py-2 rounded-xl text-xs font-bold text-white flex items-center gap-2 cursor-pointer"
            >
              <RefreshCw className={`w-3.5 h-3.5 shrink-0 ${isSyncing ? 'animate-spin' : ''}`} />
              <span>{isSyncing ? 'جاري المزامنة...' : 'مزامنة فورية الآن'}</span>
            </button>

            <button
              type="button"
              onClick={() => {
                setIsSyncModalOpen(false);
                setIsBackupModalOpen?.(true);
              }}
              className="glass-btn min-h-[40px] px-3.5 py-2 rounded-xl text-xs font-bold text-[var(--accent-secondary)] flex items-center gap-1.5 cursor-pointer"
            >
              <HardDriveDownload className="w-3.5 h-3.5 shrink-0" />
              <span>النسخ الاحتياطي والاستعادة</span>
            </button>
          </div>

          <button
            type="button"
            onClick={() => setIsSyncModalOpen(false)}
            className="glass-btn min-h-[40px] px-4 py-2 rounded-xl font-bold text-xs text-[var(--text-secondary)] cursor-pointer"
          >
            إغلاق
          </button>
        </div>
      </div>
    </div>
  );
};
