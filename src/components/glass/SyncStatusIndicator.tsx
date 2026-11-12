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
    setIsSyncModalOpen
  } = useApp();

  // Configuration for each of the 6 real states
  const config = {
    connected: {
      label: 'متصل وجاهز',
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
      label: lastSuccessfulSyncTime ? `متزامن (${lastSuccessfulSyncTime})` : 'تمت المزامنة',
      mobileLabel: lastSuccessfulSyncTime || 'متزامن',
      icon: CheckCircle2,
      colorClass: 'text-[var(--accent-secondary)]',
      bgClass: 'bg-[var(--accent-secondary)]/10 border-[var(--accent-secondary)]/30',
      dotClass: 'bg-[var(--accent-secondary)]'
    },
    failed: {
      label: 'فشلت المزامنة',
      mobileLabel: 'فشل',
      icon: AlertCircle,
      colorClass: 'text-[var(--danger)]',
      bgClass: 'bg-red-500/15 border-red-500/30',
      dotClass: 'bg-red-500 animate-pulse'
    },
    offline: {
      label: 'لا يوجد اتصال',
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
      className={`relative inline-flex items-center gap-1.5 px-2.5 sm:px-3 h-9 sm:h-10 rounded-xl text-xs font-bold transition-all duration-200 cursor-pointer select-none active:scale-95 shadow-xs border shrink-0 ${config.bgClass} ${config.colorClass} ${className}`}
      title="اضغط لعرض تفاصيل المزامنة وطابور العمليات"
      aria-label={`حالة المزامنة: ${config.label}`}
    >
      <IconComponent
        className={`w-3.5 h-3.5 shrink-0 ${isSyncing ? 'animate-spin' : ''}`}
      />

      {/* Text Label: full on desktop, compact on mobile */}
      <span className="hidden sm:inline whitespace-nowrap">{config.label}</span>
      <span className="inline sm:hidden whitespace-nowrap text-[11px]">{config.mobileLabel}</span>

      {/* Indicator status light dot */}
      <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${config.dotClass}`} />
    </button>
  );
};
