import React from 'react';
import { useApp } from '../../context/AppContext';
import {
  Wifi,
  WifiOff,
  RefreshCw,
  CheckCircle2,
  AlertCircle,
  CloudUpload
} from 'lucide-react';

export const SyncStatusIndicator: React.FC<{ className?: string }> = ({ className = '' }) => {
  const {
    syncState,
    isSyncing,
    pendingMutationsCount,
    lastSuccessfulSyncTime,
    lastSuccessfulSyncCompact,
    setIsSyncModalOpen
  } = useApp();

  // Configuration for each of the 6 real states
  // Note: Always displays last successful sync date & time next to "متصل", or clear "لم تتم مزامنة بعد" if none
  const config = {
    connected: {
      label: 'متصل • لم تتم مزامنة بعد',
      mobileLabel: 'متصل',
      icon: Wifi,
      colorClass: 'text-[var(--info-text)]',
      bgClass: 'bg-[var(--info-bg)] border-[var(--info-border)]',
      dotClass: 'bg-[var(--info-text)]'
    },
    syncing: {
      label: 'جاري المزامنة...',
      mobileLabel: 'مزامنة...',
      icon: RefreshCw,
      colorClass: 'text-[var(--accent-primary)]',
      bgClass: 'bg-[var(--info-bg)] border-[var(--info-border)]',
      dotClass: 'bg-[var(--accent-primary)] animate-ping'
    },
    synced: {
      label: lastSuccessfulSyncTime ? `متصل • ${lastSuccessfulSyncTime}` : 'متصل • تمت المزامنة',
      mobileLabel: 'متصل',
      icon: CheckCircle2,
      colorClass: 'text-[var(--success-text)]',
      bgClass: 'bg-[var(--success-bg)] border-[var(--success-border)]',
      dotClass: 'bg-[var(--success-text)]'
    },
    failed: {
      label: lastSuccessfulSyncCompact ? `فشلت المزامنة • آخر نجاح ${lastSuccessfulSyncCompact}` : 'فشلت المزامنة',
      mobileLabel: 'فشل',
      icon: AlertCircle,
      colorClass: 'text-[var(--danger-text)]',
      bgClass: 'bg-[var(--danger-bg)] border-[var(--danger-border)]',
      dotClass: 'bg-[var(--danger-text)] animate-pulse'
    },
    offline: {
      label: lastSuccessfulSyncCompact ? `أوفلاين • آخر نجاح ${lastSuccessfulSyncCompact}` : 'غير متصل',
      mobileLabel: 'أوفلاين',
      icon: WifiOff,
      colorClass: 'text-[var(--text-secondary)]',
      bgClass: 'bg-[var(--surface-inset)] border-[var(--border-color)]',
      dotClass: 'bg-[var(--text-muted)]'
    },
    pending: {
      label: `${pendingMutationsCount} تغيير معلق`,
      mobileLabel: `${pendingMutationsCount} معلق`,
      icon: CloudUpload,
      colorClass: 'text-[var(--warning-text)]',
      bgClass: 'bg-[var(--warning-bg)] border-[var(--warning-border)]',
      dotClass: 'bg-[var(--warning-text)] animate-pulse'
    }
  }[syncState];

  const IconComponent = config.icon;

  return (
    <button
      type="button"
      onClick={() => setIsSyncModalOpen(true)}
      className={`relative inline-flex items-center gap-1.5 px-2.5 py-1.5 min-h-[36px] sm:min-h-[38px] h-auto rounded-xl text-[10.5px] sm:text-[11.5px] font-semibold transition-all duration-200 cursor-pointer select-none active:scale-95 shadow-xs border min-w-0 max-w-[132px] sm:max-w-[240px] md:max-w-none shrink-0 overflow-hidden ${config.bgClass} ${config.colorClass} ${className}`}
      title={
        lastSuccessfulSyncTime
          ? `آخر مزامنة ناجحة: ${lastSuccessfulSyncTime} — اضغط للتفاصيل`
          : 'لم تتم أي مزامنة ناجحة بعد — اضغط للتفاصيل'
      }
      aria-label={`حالة المزامنة: ${config.label}`}
    >
      <IconComponent
        className={`w-3.5 h-3.5 shrink-0 ${isSyncing || syncState === 'syncing' ? 'animate-spin' : ''}`}
      />

      {/* Text Label: compact status on small screens, full status on >= sm */}
      <span className="hidden sm:inline whitespace-nowrap truncate leading-snug">{config.label}</span>
      <span className="inline sm:hidden whitespace-nowrap font-semibold leading-snug truncate">{config.mobileLabel}</span>

      {/* Indicator status light dot */}
      <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${config.dotClass}`} />
    </button>
  );
};
