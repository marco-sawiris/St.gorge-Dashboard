import React from 'react';
import { useApp } from '../../context/AppContext';
import { Menu, Bell } from 'lucide-react';
import { SyncStatusIndicator } from '../glass/SyncStatusIndicator';

const appHeaderIcon = new URL('../../../Aset/Icon-2.png', import.meta.url).href;

export const TopBar: React.FC = () => {
  const {
    notifications,
    setIsSidebarOpen,
    isSidebarCollapsed,
    setIsSidebarCollapsed,
    setIsNotificationsOpen,
    setNotificationsActiveTab
  } = useApp();

  const unreadCount = notifications.filter((n) => n.unread).length;

  return (
    <header className="pointer-events-auto w-full max-w-6xl mx-auto h-16 glass-strong px-2.5 sm:px-4 flex items-center justify-between gap-2 shadow-[var(--shadow-lg)] transition-all duration-300">
      {/* Brand & Menu Trigger (Start / Right side in RTL) */}
      <div className="flex items-center gap-2 sm:gap-3 shrink-0 min-w-0">
        {/* Mobile RTL Drawer Trigger */}
        <button
          type="button"
          onClick={() => setIsSidebarOpen(true)}
          className="glass-btn lg:hidden w-9 h-9 sm:w-10 sm:h-10 rounded-xl flex items-center justify-center cursor-pointer shrink-0"
          aria-label="فتح القائمة"
          title="القائمة الجانبية"
        >
          <Menu className="w-5 h-5 text-[var(--text-primary)]" />
        </button>

        {/* Desktop Sidebar Collapse/Expand Trigger */}
        <button
          type="button"
          onClick={() => setIsSidebarCollapsed((prev) => !prev)}
          className="glass-btn hidden lg:flex w-9 h-9 sm:w-10 sm:h-10 rounded-xl items-center justify-center cursor-pointer shrink-0"
          aria-label={isSidebarCollapsed ? 'توسيع القائمة الجانبية' : 'طي القائمة الجانبية'}
          title={isSidebarCollapsed ? 'توسيع القائمة الجانبية' : 'طي القائمة الجانبية'}
        >
          <Menu className="w-5 h-5 text-[var(--text-primary)]" />
        </button>

        <div className="flex items-center gap-2 sm:gap-2.5 select-none shrink-0">
          <img
            src={appHeaderIcon}
            alt="StGeorge Dashboard Icon"
            width={331}
            height={331}
            className="w-9 h-9 sm:w-10 sm:h-10 object-contain shrink-0 drop-shadow-[0_2px_8px_rgba(3,7,17,0.38)]"
          />
          <div className="flex flex-col justify-center leading-none">
            <h1 className="font-extrabold text-[15px] sm:text-[17px] leading-[1.08] tracking-tight text-[var(--text-primary)] m-0 whitespace-nowrap">
              StGeorge
            </h1>
            <span className="text-[10px] sm:text-[11px] font-medium leading-[1.1] tracking-wide text-[var(--accent-secondary)] mt-0.5 whitespace-nowrap">
              Dashboard
            </span>
          </div>
        </div>
      </div>

      {/* Action Items Group: 1. Compact Sync Status, 2. Notification Bell */}
      <div className="flex items-center gap-1.5 sm:gap-2 min-w-0 shrink">
        {/* 1. Sync Status Indicator (Compact pill so it never crowds StGeorge branding) */}
        <SyncStatusIndicator />

        {/* 2. Notification Bell with Internal Numeric Badge */}
        <button
          type="button"
          onClick={() => {
            setNotificationsActiveTab('feed');
            setIsNotificationsOpen(true);
          }}
          className="glass-btn relative w-9 h-9 sm:w-10 sm:h-10 rounded-xl flex items-center justify-center cursor-pointer shrink-0"
          aria-label="التنبيهات"
          title={unreadCount > 0 ? `التنبيهات (${unreadCount} غير مقروء)` : 'التنبيهات'}
        >
          <Bell className="w-4 h-4 sm:w-[18px] sm:h-[18px] text-[var(--text-primary)]" />
          {unreadCount > 0 && (
            <span
              className="absolute top-0.5 end-0.5 min-w-[16px] h-4 px-1 rounded-full bg-[var(--accent-secondary)] text-[var(--badge-on-accent)] font-mono text-[9px] sm:text-[10px] font-black flex items-center justify-center shadow-xs ring-1.5 ring-[var(--surface-primary)] select-none pointer-events-none"
            >
              {unreadCount > 9 ? '9+' : unreadCount}
            </span>
          )}
        </button>
      </div>
    </header>
  );
};
