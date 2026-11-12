import React from 'react';
import { useApp } from '../../context/AppContext';
import {
  X,
  RefreshCw,
  Wifi,
  WifiOff,
  CloudUpload,
  AlertTriangle,
  CheckCircle2,
  Clock,
  Database
} from 'lucide-react';

export const SyncDetailsModal: React.FC = () => {
  const {
    isSyncModalOpen,
    setIsSyncModalOpen,
    syncState,
    isSyncing,
    isOnline,
    lastSyncError,
    lastSuccessfulPullTime,
    lastSuccessfulPushTime,
    lastSuccessfulSyncTime,
    pendingMutationsCount,
    syncData,
    processOfflineQueue
  } = useApp();

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
      desc: 'الاتصال بالإنترنت وبالخادم يعمل بصورة طبيعية، ولا توجد عمليات معلقة بانتظار الإرسال.',
      icon: Wifi,
      colorClass: 'text-[var(--accent-secondary)]'
    },
    syncing: {
      title: 'جاري تنفيذ المزامنة...',
      desc: 'يتم حالياً فحص الخادم، إرسال العمليات المعلقة، وسحب البيانات المحدثة.',
      icon: RefreshCw,
      colorClass: 'text-[var(--primary)]'
    },
    synced: {
      title: 'تمت المزامنة بنجاح',
      desc: 'تم تحديث البيانات المحلية والتأكد من مطابقتها مع الخادم دون تعارض.',
      icon: CheckCircle2,
      colorClass: 'text-[var(--accent-secondary)]'
    },
    failed: {
      title: 'فشلت المزامنة الأخيرة',
      desc: 'حدث خطأ أثناء محاولة الاتصال بالخادم. تم الاحتفاظ بجميع بياناتك وعملياتك محلياً بأمان.',
      icon: AlertTriangle,
      colorClass: 'text-[var(--danger)]'
    },
    offline: {
      title: 'لا يوجد اتصال بالإنترنت (Offline Mode)',
      desc: 'أنت تعمل حالياً بدون اتصال. يمكنك تسجيل الحضور والافتقاد وإضافة البيانات، وسيتم حفظ كل شيء في قاعدة البيانات المحلية (IndexedDB).',
      icon: WifiOff,
      colorClass: 'text-[var(--text-muted)]'
    },
    pending: {
      title: 'توجد عمليات معلقة بانتظار الاتصال',
      desc: `لديك ${pendingMutationsCount} عملية محفوظة محلياً في طابور العمليات، وستُرسل إلى الخادم بمجرد المزامنة.`,
      icon: CloudUpload,
      colorClass: 'text-amber-500'
    }
  }[syncState];

  const StatusIcon = statusDescriptions.icon;

  const formatDateDisplay = (iso: string | null) => {
    if (!iso) return 'لم تتم بعد';
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
        <div className="px-5 py-4 border-b border-[var(--border-color)] flex items-center justify-between bg-[var(--surface-primary)]/40">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-xl bg-[var(--surface-primary)] border border-[var(--border-color)] flex items-center justify-center text-[var(--accent-secondary)] shadow-xs">
              <StatusIcon className={`w-5 h-5 ${isSyncing ? 'animate-spin' : ''}`} />
            </div>
            <div>
              <h3 className="font-extrabold text-base text-[var(--text-primary)] m-0">
                حالة وتفاصيل المزامنة
              </h3>
              <p className="text-xs text-[var(--text-muted)] m-0">
                متابعة الاتصال بالخادم وقاعدة البيانات المحلية
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={() => setIsSyncModalOpen(false)}
            className="w-8 h-8 rounded-xl bg-[var(--surface-primary)] border border-[var(--border-color)] text-[var(--text-muted)] hover:text-[var(--text-primary)] flex items-center justify-center cursor-pointer transition-colors"
          >
            <X className="w-4 h-4" />
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

          {/* Sync Error Notice if any */}
          {lastSyncError && (
            <div className="p-3.5 rounded-2xl bg-red-500/10 border border-red-500/30 text-red-600 dark:text-red-400 space-y-1">
              <div className="flex items-center gap-2 font-bold text-xs">
                <AlertTriangle className="w-4 h-4 shrink-0" />
                <span>سبب فشل المزامنة الأخير:</span>
              </div>
              <p className="text-xs m-0 font-mono pr-6">
                {lastSyncError}
              </p>
            </div>
          )}

          {/* Metrics Grid */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {/* Online Status */}
            <div className="p-3.5 rounded-2xl bg-[var(--surface-primary)] border border-[var(--border-color)] flex items-center justify-between">
              <div className="flex items-center gap-2">
                {isOnline ? (
                  <Wifi className="w-4 h-4 text-[var(--accent-secondary)]" />
                ) : (
                  <WifiOff className="w-4 h-4 text-[var(--text-muted)]" />
                )}
                <span className="font-bold text-xs text-[var(--text-secondary)]">اتصال الشبكة</span>
              </div>
              <span className={`text-xs font-extrabold px-2 py-0.5 rounded-full ${
                isOnline ? 'bg-[var(--accent-secondary)]/15 text-[var(--accent-secondary)]' : 'bg-slate-500/15 text-[var(--text-muted)]'
              }`}>
                {isOnline ? 'متصل' : 'غير متصل'}
              </span>
            </div>

            {/* Offline Pending Queue */}
            <div className="p-3.5 rounded-2xl bg-[var(--surface-primary)] border border-[var(--border-color)] flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Database className="w-4 h-4 text-amber-500" />
                <span className="font-bold text-xs text-[var(--text-secondary)]">طابور العمليات</span>
              </div>
              <span className={`text-xs font-extrabold px-2.5 py-0.5 rounded-full font-mono ${
                pendingMutationsCount > 0 ? 'bg-amber-500/15 text-amber-500 border border-amber-500/30' : 'bg-[var(--accent-secondary)]/10 text-[var(--accent-secondary)]'
              }`}>
                {pendingMutationsCount} معلق
              </span>
            </div>

            {/* Last Successful Pull */}
            <div className="p-3.5 rounded-2xl bg-[var(--surface-primary)] border border-[var(--border-color)] space-y-1">
              <div className="flex items-center gap-2 text-xs font-bold text-[var(--text-muted)]">
                <Clock className="w-3.5 h-3.5 text-[var(--accent-secondary)]" />
                <span>آخر سحب من الشيت (Pull)</span>
              </div>
              <p className="font-mono text-xs font-bold text-[var(--text-primary)] m-0">
                {formatDateDisplay(lastSuccessfulPullTime)}
              </p>
            </div>

            {/* Last Successful Push */}
            <div className="p-3.5 rounded-2xl bg-[var(--surface-primary)] border border-[var(--border-color)] space-y-1">
              <div className="flex items-center gap-2 text-xs font-bold text-[var(--text-muted)]">
                <Clock className="w-3.5 h-3.5 text-[var(--primary)]" />
                <span>آخر إرسال للشيت (Push)</span>
              </div>
              <p className="font-mono text-xs font-bold text-[var(--text-primary)] m-0">
                {formatDateDisplay(lastSuccessfulPushTime)}
              </p>
            </div>
          </div>

          {/* Sync Guarantee Notice */}
          <div className="p-3.5 rounded-2xl bg-[var(--surface-primary)]/50 border border-[var(--border-color)] text-xs text-[var(--text-secondary)] leading-relaxed">
            <span className="font-bold text-[var(--text-primary)]">ضمان الأمان وعدم فقد البيانات: </span>
            تعتمد المنظومة آلية التخزين المحلي أولاً (Offline-First) مع طابور العمليات التلقائي. لن يتم حذف أي بيانات محلية أو استبدالها إلا بعد التأكد من اكتمال استجابة السيرفر للفصل المحدد.
          </div>
        </div>

        {/* Modal Footer Actions */}
        <div className="px-5 py-3.5 border-t border-[var(--border-color)] flex flex-wrap items-center justify-between gap-2.5 bg-[var(--surface-primary)]/40">
          <div className="flex items-center gap-2">
            {pendingMutationsCount > 0 && (
              <button
                type="button"
                onClick={handleFlushQueue}
                disabled={isSyncing || !isOnline}
                className="px-3.5 py-2 rounded-xl bg-amber-500/15 border border-amber-500/30 text-amber-600 dark:text-amber-400 text-xs font-bold flex items-center gap-1.5 hover:bg-amber-500/25 transition-all cursor-pointer disabled:opacity-50"
              >
                <CloudUpload className="w-3.5 h-3.5" />
                <span>إرسال المعلق ({pendingMutationsCount})</span>
              </button>
            )}

            <button
              type="button"
              onClick={handleSyncNow}
              disabled={isSyncing}
              className="btn--lens px-4 py-2 rounded-xl bg-gradient-to-r from-[var(--primary)] to-[var(--accent-secondary)] text-white text-xs font-bold flex items-center gap-2 transition-all cursor-pointer shadow-xs disabled:opacity-50"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${isSyncing ? 'animate-spin' : ''}`} />
              <span>{isSyncing ? 'جاري المزامنة...' : 'مزامنة فورية الآن'}</span>
            </button>
          </div>

          <button
            type="button"
            onClick={() => setIsSyncModalOpen(false)}
            className="px-4 py-2 rounded-xl bg-[var(--surface-primary)] border border-[var(--border-color)] font-bold text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)] cursor-pointer transition-colors"
          >
            إغلاق
          </button>
        </div>
      </div>
    </div>
  );
};
