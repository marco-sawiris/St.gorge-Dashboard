import React, { useState } from 'react';
import { getAppsScriptUrl, getRelayKey, setAppsScriptUrl, setRelayKey } from '../../services/apiConfig';
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
  Database,
  ShieldCheck
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
    pendingMutationsCount,
    syncData,
    processOfflineQueue
  } = useApp();

  const [appsScriptUrl, setAppsScriptUrlInput] = useState(() => getAppsScriptUrl());
  const [relayKey, setRelayKeyInput] = useState(() => getRelayKey());
  const [configMessage, setConfigMessage] = useState('');
  const [configSaved, setConfigSaved] = useState(false);

  if (!isSyncModalOpen) return null;

  const handleSaveConnection = () => {
    const cleanedUrl = appsScriptUrl.trim();
    if (!/^https:\\/\\/script\\.google\\.com\\/macros\\/s\\/[^\\s]+\\/exec(?:\\?.*)?$/i.test(cleanedUrl)) {
      setConfigSaved(false);
      setConfigMessage('رابط Apps Script لازم يكون رابط Web App وينتهي بـ /exec.');
      return;
    }
    if (relayKey.trim().length < 32) {
      setConfigSaved(false);
      setConfigMessage('مفتاح RELAY_KEY غير صالح. لازم يكون 32 حرفًا على الأقل ويطابق القيمة الموجودة في Script Properties.');
      return;
    }
    if (!setAppsScriptUrl(cleanedUrl)) {
      setConfigSaved(false);
      setConfigMessage('تعذر حفظ رابط Apps Script. راجع الرابط وحاول مرة تانية.');
      return;
    }
    setRelayKey(relayKey.trim());
    setConfigSaved(true);
    setConfigMessage('تم حفظ إعدادات الاتصال على هذا الجهاز. اضغط «مزامنة فورية الآن» لاختبار القراءة والكتابة.');
  };

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
      colorClass: 'text-[var(--primary)]'
    },
    synced: {
      title: 'تمت المزامنة بنجاح',
      desc: 'تم تحديث البيانات المحلية والتأكد من مطابقتها مع Google Sheets دون تعارض.',
      icon: CheckCircle2,
      colorClass: 'text-[var(--accent-secondary)]'
    },
    failed: {
      title: 'فشلت المزامنة الأخيرة',
      desc: 'تعذر إتمام المزامنة الحالية. تم الاحتفاظ بجميع بياناتك وعملياتك محلياً في IndexedDB بأمان.',
      icon: AlertTriangle,
      colorClass: 'text-[var(--danger)]'
    },
    offline: {
      title: 'لا يوجد اتصال بالإنترنت (Offline Mode)',
      desc: 'أنت تعمل حالياً بدون اتصال. يمكنك تسجيل الحضور والافتقاد وتعديل البيانات، وسيتم حفظ كل شيء محلياً ومزامنته عند عودة الإنترنت.',
      icon: WifiOff,
      colorClass: 'text-[var(--text-muted)]'
    },
    pending: {
      title: 'توجد عمليات معلقة بانتظار المزامنة',
      desc: `لديك ${pendingMutationsCount} عملية محفوظة محلياً في طابور العمليات، وستُرسل إلى Google Sheets عند المزامنة.`,
      icon: CloudUpload,
      colorClass: 'text-amber-500'
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
                المزامنة المباشرة مع Google Sheets وقاعدة البيانات المحلية
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={() => setIsSyncModalOpen(false)}
            aria-label="إغلاق نافذة حالة المزامنة"
            className="glass-btn w-8 h-8 rounded-xl text-[var(--text-muted)] hover:text-[var(--text-primary)] flex items-center justify-center cursor-pointer"
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
                <span>سبب تعذر المزامنة الأخيرة:</span>
              </div>
              <p className="text-xs m-0 font-mono pr-6">
                {lastSyncError}
              </p>
            </div>
          )}

          {/* Google Apps Script connection settings */}
          <section className="p-4 rounded-2xl bg-[var(--surface-primary)] border border-[var(--border-color)] space-y-3">
            <div className="space-y-1">
              <h4 className="font-extrabold text-sm text-[var(--text-primary)] m-0">إعداد اتصال Google Apps Script</h4>
              <p className="text-xs text-[var(--text-muted)] m-0 leading-relaxed">أدخل رابط Web App المنشور ومفتاح RELAY_KEY المطابق لقيم Script Properties.</p>
            </div>
            <label className="block space-y-1.5">
              <span className="text-xs font-bold text-[var(--text-secondary)]">Web App URL</span>
              <input dir="ltr" type="url" value={appsScriptUrl} onChange={(event) => { setAppsScriptUrlInput(event.target.value); setConfigSaved(false); }} placeholder="https://script.google.com/macros/s/.../exec" autoComplete="url" className="w-full min-w-0 box-border rounded-xl border border-[var(--border-color)] bg-[var(--surface-secondary)] px-3 py-2.5 text-xs text-[var(--text-primary)] outline-none focus:border-[var(--accent-secondary)]" />
            </label>
            <label className="block space-y-1.5">
              <span className="text-xs font-bold text-[var(--text-secondary)]">RELAY_KEY</span>
              <input dir="ltr" type="password" value={relayKey} onChange={(event) => { setRelayKeyInput(event.target.value); setConfigSaved(false); }} placeholder="أدخل المفتاح السري (32 حرفًا على الأقل)" autoComplete="new-password" className="w-full min-w-0 box-border rounded-xl border border-[var(--border-color)] bg-[var(--surface-secondary)] px-3 py-2.5 text-xs text-[var(--text-primary)] outline-none focus:border-[var(--accent-secondary)]" />
            </label>
            <div className="flex flex-wrap items-center gap-2">
              <button type="button" onClick={handleSaveConnection} className="glass-btn--primary px-4 py-2 rounded-xl text-xs font-bold">حفظ إعدادات الاتصال</button>
              {configSaved && <span className="text-xs font-bold text-[var(--accent-secondary)]">تم الحفظ</span>}
            </div>
            {configMessage && <p role="status" className={`text-xs m-0 leading-relaxed ${configSaved ? 'text-[var(--accent-secondary)]' : 'text-[var(--danger)]'}`}>{configMessage}</p>}
            <p className="text-[11px] text-amber-500 m-0 leading-relaxed">تنبيه أمني: المفتاح يُحفظ محليًا داخل التطبيق، ويمكن استخراجه من جهاز أو APK؛ لذلك لا تعتبره سرًا غير قابل للاستخراج. استخدم مفتاحًا مخصصًا لهذا التطبيق وغيّره فور الاشتباه في تسريبه.</p>
          </section>

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

          {/* Sync & Security Guarantee Notice */}
          <div className="p-3.5 rounded-2xl bg-[var(--surface-primary)]/50 border border-[var(--border-color)] text-xs text-[var(--text-secondary)] leading-relaxed flex items-start gap-2.5">
            <ShieldCheck className="w-4 h-4 text-[var(--accent-secondary)] shrink-0 mt-0.5" />
            <div>
              <span className="font-bold text-[var(--text-primary)]">حماية الاتصال وعدم فقد البيانات: </span>
              إعدادات الربط مع Google Sheets محمية ومضبوطة داخلياً، وتعتمد المنظومة آلية التخزين المحلي أولاً (Offline-First) مع طابور العمليات التلقائي لضمان حفظ كافة السجلات.
            </div>
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
                className="glass-btn px-3.5 py-2 rounded-xl border-amber-500/35 text-amber-400 text-xs font-bold flex items-center gap-1.5 cursor-pointer"
              >
                <CloudUpload className="w-3.5 h-3.5" />
                <span>إرسال المعلق ({pendingMutationsCount})</span>
              </button>
            )}

            <button
              type="button"
              onClick={handleSyncNow}
              disabled={isSyncing}
              className="glass-btn--primary btn--lens px-4 py-2 rounded-xl text-xs font-bold flex items-center gap-2 cursor-pointer"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${isSyncing ? 'animate-spin' : ''}`} />
              <span>{isSyncing ? 'جاري المزامنة...' : 'مزامنة فورية الآن'}</span>
            </button>
          </div>

          <button
            type="button"
            onClick={() => setIsSyncModalOpen(false)}
            className="glass-btn px-4 py-2 rounded-xl font-bold text-xs text-[var(--text-secondary)] cursor-pointer"
          >
            إغلاق
          </button>
        </div>
      </div>
    </div>
  );
};
