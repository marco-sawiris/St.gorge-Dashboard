import React, { useState, useEffect } from 'react';
import { useApp } from '../../context/AppContext';
import { Menu, Bell, Clock } from 'lucide-react';
import { SyncStatusIndicator } from '../glass/SyncStatusIndicator';

// Explicit Gregorian Arabic month names for standard Egyptian/Christian calendar display
const ARABIC_MONTHS = [
  'يناير',
  'فبراير',
  'مارس',
  'أبريل',
  'مايو',
  'يونيو',
  'يوليو',
  'أغسطس',
  'سبتمبر',
  'أكتوبر',
  'نوفمبر',
  'ديسمبر'
];

/**
 * CompactDateTime sub-component:
 * Real-time clock updating every 10 seconds.
 * On Desktop: displays "12 نوفمبر • 12:58 م"
 * On Mobile: displays "12:58 م" with compact clock icon
 */
const CompactDateTime: React.FC = () => {
  const [now, setNow] = useState<Date>(() => new Date());

  useEffect(() => {
    // 10s tick guarantees minute updates without page reload
    const timer = setInterval(() => {
      setNow(new Date());
    }, 10000);
    return () => clearInterval(timer);
  }, []);

  const day = now.getDate();
  const monthName = ARABIC_MONTHS[now.getMonth()];
  const dateFormatted = `${day} ${monthName}`;

  let hours = now.getHours();
  const minutes = now.getMinutes().toString().padStart(2, '0');
  const period = hours >= 12 ? 'م' : 'ص';
  hours = hours % 12;
  if (hours === 0) hours = 12;
  const timeFormatted = `${hours}:${minutes} ${period}`;

  return (
    <div
      className="flex items-center gap-1 sm:gap-1.5 px-2 sm:px-2.5 h-9 sm:h-10 rounded-xl bg-[var(--surface-primary)] border border-[var(--border-color)] text-[var(--text-secondary)] text-xs font-bold shrink-0 select-none shadow-xs"
      title={`التاريخ والوقت: ${dateFormatted} - ${timeFormatted}`}
    >
      <Clock className="w-3.5 h-3.5 text-[var(--accent-secondary)] shrink-0" />
      {/* Date shown on screens >= 640px */}
      <span className="hidden sm:inline text-[var(--text-primary)] whitespace-nowrap text-xs">
        {dateFormatted}
      </span>
      <span className="hidden sm:inline text-[var(--border-color)]">•</span>
      {/* Time shown on all screens in Arabic format with standard numerals */}
      <span className="font-mono text-[var(--accent-secondary)] font-extrabold text-[11px] sm:text-xs whitespace-nowrap">
        {timeFormatted}
      </span>
    </div>
  );
};

export const TopBar: React.FC = () => {
  const {
    notifications,
    setIsSidebarOpen,
    setIsNotificationsOpen
  } = useApp();

  const unreadCount = notifications.filter((n) => n.unread).length;

  return (
    <header className="fixed top-2.5 inset-x-2 sm:inset-x-4 max-w-6xl mx-auto h-16 z-40 glass-strong px-2.5 sm:px-4 flex items-center justify-between shadow-[var(--shadow-lg)] transition-all duration-300">
      {/* Brand & Menu Trigger (Start / Right side in RTL) */}
      <div className="flex items-center gap-2 sm:gap-3 shrink-0">
        <button
          type="button"
          onClick={() => setIsSidebarOpen(true)}
          className="w-9 h-9 sm:w-10 sm:h-10 rounded-xl bg-[var(--surface-primary)] border border-[var(--border-color)] text-[var(--text-primary)] flex items-center justify-center cursor-pointer hover:border-[var(--accent-secondary)] hover:shadow-xs transition-all active:scale-95 shrink-0"
          aria-label="فتح القائمة"
          title="القائمة الجانبية"
        >
          <Menu className="w-5 h-5 text-[var(--text-primary)]" />
        </button>

        <div className="flex items-center gap-2 select-none">
          <div className="relative w-8 h-8 sm:w-9 sm:h-9 rounded-full p-0.5 bg-gradient-to-tr from-[var(--primary)] to-[var(--accent-secondary)] shadow-xs shrink-0">
            <img
              src="/src/assets/images/st_george_icon_1794405195493.jpg"
              alt="St.Gorge Icon"
              className="w-full h-full rounded-full object-cover"
              onError={(e) => {
                (e.currentTarget as HTMLImageElement).src =
                  'https://raw.githubusercontent.com/marco-sawiris/St.gorge-Dashboard/main/Aset/Icon.png';
              }}
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

      {/* Action Items Group: 1. Sync Status, 2. Notification Bell, 3. Compact Date & Time */}
      <div className="flex items-center gap-1.5 sm:gap-2 shrink-0">
        {/* 1. Sync Status Indicator (6 real states + details modal trigger) */}
        <SyncStatusIndicator />

        {/* 2. Notification Bell with Internal Numeric Badge (Safely contained inside button & TopBar) */}
        <button
          type="button"
          onClick={() => setIsNotificationsOpen(true)}
          className="relative w-9 h-9 sm:w-10 sm:h-10 rounded-xl bg-[var(--surface-primary)] border border-[var(--border-color)] text-[var(--text-primary)] flex items-center justify-center cursor-pointer hover:border-[var(--accent-secondary)] transition-all active:scale-95 shrink-0"
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

        {/* 3. Compact Date & Time (Real-time auto-updating, responsive layout) */}
        <CompactDateTime />
      </div>
    </header>
  );
};
