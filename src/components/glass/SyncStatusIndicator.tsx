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
      colorClass: 'text-[var(--accent-secondary)]',
      bgClass: 'bg-[var(--accent-secondary)]/10 border-[var(--accent-secondary)]/30',
      dotClass: 'bg-[var(--accent-secondary)]'
    },
    syncing: {
      label: 'جاري المزامنة...',
      mobileLabel: 'مزامنة...',
      icon: RefreshCw,
      colorClass: 'text-[var(--primary)]',
      bgClass: 'bg-[var(--primary)]/15 border-[var(--primary)]/40',
      dotClass: 'bg-[var(--primary)] animate-ping'
    },
    synced: {
      label: lastSuccessfulSyncTime ? `متصل • ${lastSuccessfulSyncTime}` : 'متصل • تمت المزامنة',
      mobileLabel: 'متصل',
      icon: CheckCircle2,
      colorClass: 'text-[var(--accent-secondary)]',
      bgClass: 'bg-[var(--accent-secondary)]/10 border-[var(--accent-secondary)]/30',
      dotClass: 'bg-[var(--accent-secondary)]'
    },
    failed: {
      label: lastSuccessfulSyncCompact ? `فشلت المزامنة • آخر نجاح ${lastSuccessfulSyncCompact}` : 'فشلت المزامنة',
      mobileLabel: 'فشل',
      icon: AlertCircle,
      colorClass: 'text-[var(--danger)]',
      bgClass: 'bg-red-500/15 border-red-500/30',
      dotClass: 'bg-red-500 animate-pulse'
    },
    offline: {
      label: lastSuccessfulSyncCompact ? `أوفلاين • آخر نجاح ${lastSuccessfulSyncCompact}` : 'غير متصل',
      mobileLabel: 'أوفلاين',
      icon: WifiOff,
      colorClass: 'text-[var(--text-muted)]',
      bgClass: 'bg-[var(--glass-bg)] border-[var(--border-color)]',
      dotClass: 'bg-[var(--text-muted)]'
    },
    pending: {
      label: `${pendingMutationsCount} تغيير معلق`,
      mobileLabel: `${pendingMutationsCount} معلق`,
      icon: CloudUpload,
      colorClass: 'text-amber-500 dark:text-amber-400',
      bgClass: 'bg-amber-500/15 border-amber-500/30',
      dotClass: 'bg-amber-500 animate-pulse'
    }
  }[syncState];

  const IconComponent = config.icon;

  return (
    <button
      type="button"
      onClick={() => setIsSyncModalOpen(true)}
      className={`relative inline-flex items-center gap-1 sm:gap-1.5 px-2 sm:px-2.5 h-7 sm:h-8 rounded-lg sm:rounded-xl text-[10px] sm:text-[11px] font-semibold transition-all duration-200 cursor-pointer select-none active:scale-95 shadow-xs border min-w-0 max-w-[116px] sm:max-w-[230px] md:max-w-none overflow-hidden ${config.bgClass} ${config.colorClass} ${className}`}
      title={
        lastSuccessfulSyncTime
          ? `آخر مزامنة ناجحة: ${lastSuccessfulSyncTime} — اضغط للتفاصيل`
          : 'لم تتم أي مزامنة ناجحة بعد — اضغط للتفاصيل'
      }
      aria-label={`حالة المزامنة: ${config.label}`}
    >
      <IconComponent
        className={`w-3 h-3 sm:w-3.5 sm:h-3.5 shrink-0 ${isSyncing || syncState === 'syncing' ? 'animate-spin' : ''}`}
      />

      {/* Text Label: compact 1-word status on small screens, full status on >= sm */}
      <span className="hidden sm:inline whitespace-nowrap truncate leading-none">{config.label}</span>
      <span className="inline sm:hidden whitespace-nowrap text-[10px] font-semibold leading-none truncate">{config.mobileLabel}</span>

      {/* Indicator status light dot */}
      <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${config.dotClass}`} />
    </button>
  );
};
