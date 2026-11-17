import React from 'react';
import { useApp } from '../../context/AppContext';
import { Menu, Bell } from 'lucide-react';
import { SyncStatusIndicator } from '../glass/SyncStatusIndicator';

const stGeorgeIcon = new URL('../../assets/images/st_george_icon_1794405195493.jpg', import.meta.url).href;

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
    <header className="pointer-events-auto w-full max-w-6xl mx-auto h-[4.25rem] sm:h-[4.75rem] glass-strong px-2.5 sm:px-4 flex items-center justify-between gap-2 sm:gap-3 shadow-[var(--shadow-lg)] transition-all duration-300">
      {/* Brand & Menu Trigger (Start / Right side in RTL) */}
      <div className="flex items-center gap-2 sm:gap-3 min-w-0 flex-1">
        {/* Mobile RTL Drawer Trigger */}
        <button
          type="button"
          onClick={() => setIsSidebarOpen(true)}
          className="glass-btn lg:hidden min-w-[40px] min-h-[40px] w-10 h-10 sm:w-11 sm:h-11 rounded-xl flex items-center justify-center cursor-pointer shrink-0"
          aria-label="فتح القائمة"
          title="القائمة الجانبية"
        >
          <Menu className="w-5 h-5 shrink-0 text-[var(--text-primary)]" />
        </button>

        {/* Desktop Sidebar Collapse/Expand Trigger */}
        <button
          type="button"
          onClick={() => setIsSidebarCollapsed((prev) => !prev)}
          className="glass-btn hidden lg:flex min-w-[40px] min-h-[40px] w-10 h-10 sm:w-11 sm:h-11 rounded-xl items-center justify-center cursor-pointer shrink-0"
          aria-label={isSidebarCollapsed ? 'توسيع القائمة الجانبية' : 'طي القائمة الجانبية'}
          title={isSidebarCollapsed ? 'توسيع القائمة الجانبية' : 'طي القائمة الجانبية'}
        >
          <Menu className="w-5 h-5 shrink-0 text-[var(--text-primary)]" />
        </button>

        {/* St. George Branding Lockup (Same icon source as AboutModal, sole header icon) */}
        <div className="flex items-center gap-2 sm:gap-3 select-none min-w-0">
          <div className="w-11 h-11 sm:w-12 sm:h-12 rounded-2xl bg-gradient-to-br from-[#123fce]/30 to-[#20c7e8]/30 p-0.5 border border-[#20c7e8]/40 shadow-[0_0_15px_rgba(32,199,232,0.25)] shrink-0">
            <img
              src={stGeorgeIcon}
              alt="St. George Dashboard"
              width={1024}
              height={1024}
              className="w-full h-full aspect-square object-contain rounded-xl block"
            />
          </div>
          <div className="flex flex-col justify-center min-w-0">
            <h1 className="m-0 flex flex-col sm:flex-row sm:items-baseline sm:gap-1.5 font-extrabold text-[14px] sm:text-[17.5px] leading-[1.15] tracking-tight text-[var(--text-primary)] min-w-0">
              <span className="truncate">St. George</span>
              <span className="text-[11px] sm:text-[14px] font-bold tracking-wide text-[var(--accent-secondary)] truncate">
                Dashboard
              </span>
            </h1>
          </div>
        </div>
      </div>

      {/* Action Items Group: 1. Compact Sync Status, 2. Notification Bell */}
      <div className="flex items-center gap-1.5 sm:gap-2 shrink-0">
        {/* 1. Sync Status Indicator (Adaptive pill so it never crowds branding or clips text) */}
        <SyncStatusIndicator />

        {/* 2. Notification Bell with Internal Numeric Badge */}
        <button
          type="button"
          onClick={() => {
            setNotificationsActiveTab('feed');
            setIsNotificationsOpen(true);
          }}
          className="glass-btn relative min-w-[40px] min-h-[40px] w-10 h-10 sm:w-11 sm:h-11 rounded-xl flex items-center justify-center cursor-pointer shrink-0"
          aria-label="التنبيهات"
          title={unreadCount > 0 ? `التنبيهات (${unreadCount} غير مقروء)` : 'التنبيهات'}
        >
          <Bell className="w-4 h-4 sm:w-[18px] sm:h-[18px] shrink-0 text-[var(--text-primary)]" />
          {unreadCount > 0 && (
            <span
              className="absolute top-0.5 end-0.5 min-w-[17px] h-[17px] px-1 rounded-full bg-[var(--accent-secondary)] text-[var(--badge-on-accent)] font-mono text-[9.5px] leading-none font-black flex items-center justify-center shadow-xs ring-1.5 ring-[var(--surface-primary)] select-none pointer-events-none"
            >
              {unreadCount > 9 ? '9+' : unreadCount}
            </span>
          )}
        </button>
      </div>
    </header>
  );
};
