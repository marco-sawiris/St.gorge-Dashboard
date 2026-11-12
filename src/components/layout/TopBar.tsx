import React from 'react';
import { useApp } from '../../context/AppContext';
import { Menu, Bell } from 'lucide-react';
import { SyncStatusIndicator } from '../glass/SyncStatusIndicator';
import stGeorgeIcon from '../../assets/images/st_george_icon_1794405195493.jpg';

export const TopBar: React.FC = () => {
  const {
    notifications,
    setIsSidebarOpen,
    isSidebarCollapsed,
    setIsSidebarCollapsed,
    setIsNotificationsOpen
  } = useApp();

  const unreadCount = notifications.filter((n) => n.unread).length;

  return (
    <header className="pointer-events-auto w-full max-w-6xl mx-auto h-16 glass-strong px-2.5 sm:px-4 flex items-center justify-between shadow-[var(--shadow-lg)] transition-all duration-300">
      {/* Brand & Menu Trigger (Start / Right side in RTL) */}
      <div className="flex items-center gap-2 sm:gap-3 shrink-0">
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

        <div className="flex items-center gap-2 select-none">
          <div className="relative w-8 h-8 sm:w-9 sm:h-9 rounded-full p-0.5 bg-gradient-to-tr from-[var(--primary)] to-[var(--accent-secondary)] shadow-xs shrink-0">
            <img
              src={stGeorgeIcon}
              alt="St.Gorge Icon"
              className="w-full h-full rounded-full object-cover"
            />
          </div>
          <div>
            <h1 className="font-extrabold text-sm sm:text-base leading-tight text-[var(--text-primary)] m-0 whitespace-nowrap">
              St.Gorge
            </h1>
            <p className="text-[10px] text-[var(--accent-secondary)] font-bold m-0 hidden md:block whitespace-nowrap">
              فصل الشهيد مارجرجس بالزيتون
            </p>
          </div>
        </div>
      </div>

      {/* Action Items Group: 1. Last Successful Sync Status, 2. Notification Bell */}
      <div className="flex items-center gap-1.5 sm:gap-2 shrink-0">
        {/* 1. Sync Status Indicator (Shows connection + last successful sync date & time, or لم تتم مزامنة بعد) */}
        <SyncStatusIndicator />

        {/* 2. Notification Bell with Internal Numeric Badge */}
        <button
          type="button"
          onClick={() => setIsNotificationsOpen(true)}
          className="glass-btn relative w-9 h-9 sm:w-10 sm:h-10 rounded-xl flex items-center justify-center cursor-pointer shrink-0"
          aria-label="التنبيهات"
          title={unreadCount > 0 ? `التنبيهات (${unreadCount} غير مقروء)` : 'التنبيهات'}
        >
          <Bell className="w-4 h-4 sm:w-[18px] sm:h-[18px] text-[var(--text-primary)]" />
          {unreadCount > 0 && (
            <span
              className="absolute top-0.5 end-0.5 min-w-[16px] h-4 px-1 rounded-full bg-[var(--accent-secondary)] text-[#030711] font-mono text-[9px] sm:text-[10px] font-black flex items-center justify-center shadow-xs ring-1.5 ring-[var(--surface-primary)] select-none pointer-events-none"
            >
              {unreadCount > 9 ? '9+' : unreadCount}
            </span>
          )}
        </button>
      </div>
    </header>
  );
};
