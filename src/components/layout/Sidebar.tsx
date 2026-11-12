import React from 'react';
import { useApp } from '../../context/AppContext';
import { useTheme } from '../../context/ThemeContext';
import {
  X,
  CreditCard,
  Table as TableIcon,
  PieChart,
  PhoneCall,
  MapPin,
  ExternalLink,
  Info,
  Sun,
  Moon,
  CloudMoon,
  ShieldAlert
} from 'lucide-react';

export const Sidebar: React.FC = () => {
  const {
    isSidebarOpen,
    setIsSidebarOpen,
    activeView,
    setActiveView,
    setIsAboutModalOpen,
    setIsAreaModalOpen,
    students,
    filters,
    setFilters
  } = useApp();

  const { theme, setTheme } = useTheme();

  // Extract unique servant names sorted alphabetically
  const uniqueServants = React.useMemo(() => {
    const set = new Set<string>();
    students.forEach((s) => {
      const name = s.servant?.trim();
      if (name && name !== 'غير محدد') {
        set.add(name);
      }
    });
    return Array.from(set).sort((a, b) => a.localeCompare(b, 'ar'));
  }, [students]);

  const handleNav = (view: 'cards' | 'table' | 'charts' | 'followup') => {
    setActiveView(view);
    setIsSidebarOpen(false);
  };

  const handleToggleServant = (servantName: string) => {
    setFilters((prev) => ({
      ...prev,
      servant: prev.servant === servantName ? '' : servantName
    }));
    setIsSidebarOpen(false);
  };

  if (!isSidebarOpen) return null;

  return (
    <>
      {/* Backdrop */}
      <div
        onClick={() => setIsSidebarOpen(false)}
        className="fixed inset-0 z-50 bg-black/70 backdrop-blur-md transition-opacity animate-fadeIn"
      />

      {/* Sidebar Drawer */}
      <aside className="fixed top-0 right-0 bottom-0 w-[85vw] max-w-xs z-50 bg-[var(--surface-glass-strong)] backdrop-blur-2xl border-l border-[var(--border-color)] shadow-[0_0_60px_rgba(0,0,0,0.8),inset_1px_0_0_rgba(32,199,232,0.2)] flex flex-col p-4 overflow-y-auto animate-wordIn select-none">
        {/* Header */}
        <div className="flex items-center justify-between pb-3.5 border-b border-[var(--border-color)] mb-4">
          <div className="flex items-center gap-2.5">
            <div className="w-10 h-10 rounded-2xl bg-gradient-to-br from-[#123fce]/30 to-[#20c7e8]/30 p-0.5 border border-[#20c7e8]/40 shadow-[0_0_12px_rgba(32,199,232,0.25)]">
              <img
                src="https://raw.githubusercontent.com/marco-sawiris/St.gorge-Dashboard/main/Aset/Icon.png"
                alt="St.Gorge"
                className="w-full h-full object-contain"
              />
            </div>
            <div>
              <h2 className="font-extrabold text-base text-[var(--text-primary)] m-0">
                St. George Dashboard
              </h2>
              <p className="text-xs text-[var(--accent-secondary)] m-0 font-medium">فصل الشهيد مارجرجس</p>
            </div>
          </div>

          <button
            type="button"
            onClick={() => setIsSidebarOpen(false)}
            className="w-8 h-8 rounded-xl bg-[var(--surface-primary)] border border-[var(--border-color)] text-[var(--text-secondary)] flex items-center justify-center cursor-pointer hover:text-[var(--text-primary)] transition-colors"
            aria-label="إغلاق القائمة"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Navigation Items */}
        <nav className="flex flex-col gap-1.5 mb-5">
          <button
            type="button"
            onClick={() => handleNav('cards')}
            className={`flex items-center gap-3 px-3.5 py-2.5 rounded-xl text-sm font-bold transition-all text-right cursor-pointer ${
              activeView === 'cards'
                ? 'bg-gradient-to-r from-[#123fce] to-[#267aff] text-white shadow-[0_4px_16px_rgba(38,122,255,0.4)] border border-[#20c7e8]/40'
                : 'text-[var(--text-primary)] hover:bg-[var(--surface-secondary)]'
            }`}
          >
            <CreditCard className={`w-4 h-4 ${activeView === 'cards' ? 'text-[#20c7e8]' : 'text-[var(--text-secondary)]'}`} />
            <span>كروت المخدومين</span>
          </button>

          <button
            type="button"
            onClick={() => handleNav('table')}
            className={`flex items-center gap-3 px-3.5 py-2.5 rounded-xl text-sm font-bold transition-all text-right cursor-pointer ${
              activeView === 'table'
                ? 'bg-gradient-to-r from-[#123fce] to-[#267aff] text-white shadow-[0_4px_16px_rgba(38,122,255,0.4)] border border-[#20c7e8]/40'
                : 'text-[var(--text-primary)] hover:bg-[var(--surface-secondary)]'
            }`}
          >
            <TableIcon className={`w-4 h-4 ${activeView === 'table' ? 'text-[#20c7e8]' : 'text-[var(--text-secondary)]'}`} />
            <span>جدول الحضور</span>
          </button>

          <button
            type="button"
            onClick={() => handleNav('charts')}
            className={`flex items-center gap-3 px-3.5 py-2.5 rounded-xl text-sm font-bold transition-all text-right cursor-pointer ${
              activeView === 'charts'
                ? 'bg-gradient-to-r from-[#123fce] to-[#267aff] text-white shadow-[0_4px_16px_rgba(38,122,255,0.4)] border border-[#20c7e8]/40'
                : 'text-[var(--text-primary)] hover:bg-[var(--surface-secondary)]'
            }`}
          >
            <PieChart className={`w-4 h-4 ${activeView === 'charts' ? 'text-[#20c7e8]' : 'text-[var(--text-secondary)]'}`} />
            <span>الإحصائيات الذكية</span>
          </button>

          <button
            type="button"
            onClick={() => handleNav('followup')}
            className={`flex items-center gap-3 px-3.5 py-2.5 rounded-xl text-sm font-bold transition-all text-right cursor-pointer ${
              activeView === 'followup'
                ? 'bg-gradient-to-r from-[#123fce] to-[#267aff] text-white shadow-[0_4px_16px_rgba(38,122,255,0.4)] border border-[#20c7e8]/40'
                : 'text-[var(--text-primary)] hover:bg-[var(--surface-secondary)]'
            }`}
          >
            <PhoneCall className={`w-4 h-4 ${activeView === 'followup' ? 'text-[#20c7e8]' : 'text-[var(--text-secondary)]'}`} />
            <span>سجل الافتقاد</span>
          </button>

          <button
            type="button"
            onClick={() => {
              setIsSidebarOpen(false);
              setIsAreaModalOpen(true);
            }}
            className="flex items-center gap-3 px-3.5 py-2.5 rounded-xl text-sm font-bold text-[var(--text-primary)] hover:bg-[var(--surface-secondary)] transition-colors text-right cursor-pointer"
          >
            <MapPin className="w-4 h-4 text-[#20c7e8]" />
            <span>المناطق السكنية</span>
          </button>

          {/* Zero green: Blue & Cyan */}
          <a
            href="https://docs.google.com/spreadsheets/d/15Nda4pGb3WdAfOuRTwRS9Fx822_EORgumOmhZcjTVt0/edit"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-3 px-3.5 py-2.5 rounded-xl text-sm font-bold text-[var(--text-primary)] hover:bg-[var(--surface-secondary)] transition-colors text-right cursor-pointer"
          >
            <ExternalLink className="w-4 h-4 text-[#20c7e8]" />
            <span>فتح ملف الشيت</span>
          </a>

          <button
            type="button"
            onClick={() => {
              setIsSidebarOpen(false);
              setIsAboutModalOpen(true);
            }}
            className="flex items-center gap-3 px-3.5 py-2.5 rounded-xl text-sm font-bold text-[var(--text-primary)] hover:bg-[var(--surface-secondary)] transition-colors text-right cursor-pointer"
          >
            <Info className="w-4 h-4 text-[#8ecfff]" />
            <span>عن التطبيق</span>
          </button>
        </nav>

        {/* 3-State Theme Selector */}
        <div className="pt-3 border-t border-[var(--border-color)] mb-5">
          <p className="text-xs font-bold text-[var(--text-secondary)] mb-2 flex items-center justify-between">
            <span>السمة ومظهر التطبيق</span>
            <span className="text-[10px] text-[#20c7e8] font-mono capitalize">{theme}</span>
          </p>
          <div className="flex gap-1.5 p-1 bg-[var(--surface-primary)] rounded-xl border border-[var(--border-color)]">
            <button
              type="button"
              onClick={() => setTheme('dark')}
              className={`flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded-lg text-xs font-bold transition-all cursor-pointer ${
                theme === 'dark'
                  ? 'bg-gradient-to-r from-[#123fce] to-[#267aff] text-white shadow-[0_2px_10px_rgba(38,122,255,0.4)] border border-[#20c7e8]/40'
                  : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
              }`}
            >
              <Moon className="w-3.5 h-3.5 text-[#20c7e8]" />
              <span>داكن</span>
            </button>
            <button
              type="button"
              onClick={() => setTheme('dim')}
              className={`flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded-lg text-xs font-bold transition-all cursor-pointer ${
                theme === 'dim'
                  ? 'bg-gradient-to-r from-[#123fce] to-[#267aff] text-white shadow-[0_2px_10px_rgba(38,122,255,0.4)] border border-[#20c7e8]/40'
                  : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
              }`}
            >
              <CloudMoon className="w-3.5 h-3.5 text-[#8ecfff]" />
              <span>خافت</span>
            </button>
            <button
              type="button"
              onClick={() => setTheme('light')}
              className={`flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded-lg text-xs font-bold transition-all cursor-pointer ${
                theme === 'light'
                  ? 'bg-gradient-to-r from-[#123fce] to-[#267aff] text-white shadow-[0_2px_10px_rgba(38,122,255,0.4)] border border-[#20c7e8]/40'
                  : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
              }`}
            >
              <Sun className="w-3.5 h-3.5 text-amber-300" />
              <span>فاتح</span>
            </button>
          </div>
        </div>

        {/* Servants Filter Section */}
        <div className="pt-3 border-t border-[var(--border-color)] flex-1">
          <div className="flex items-center justify-between mb-2">
            <p className="text-xs font-bold text-[var(--text-secondary)] flex items-center gap-1.5 m-0">
              <ShieldAlert className="w-3.5 h-3.5 text-[#20c7e8]" />
              <span>أشابين وخدام الفصل</span>
            </p>
            {filters.servant && (
              <button
                type="button"
                onClick={() => setFilters((p) => ({ ...p, servant: '' }))}
                className="text-[11px] text-rose-400 font-bold hover:underline cursor-pointer"
              >
                إلغاء الفلتر
              </button>
            )}
          </div>

          <div className="flex flex-wrap gap-1.5 max-h-56 overflow-y-auto pt-1">
            {uniqueServants.length === 0 ? (
              <span className="text-xs text-[var(--text-muted)] italic">لا يوجد خدام محملون</span>
            ) : (
              uniqueServants.map((servantName) => {
                const isActive = filters.servant === servantName;
                return (
                  <button
                    key={servantName}
                    type="button"
                    onClick={() => handleToggleServant(servantName)}
                    className={`px-3 py-1.5 rounded-full text-xs font-bold transition-all cursor-pointer select-none ${
                      isActive
                        ? 'bg-gradient-to-r from-[#123fce] to-[#267aff] text-white shadow-[0_2px_10px_rgba(38,122,255,0.4)] border border-[#20c7e8]/40'
                        : 'bg-[var(--surface-primary)] border border-[var(--border-color)] text-[var(--text-primary)] hover:border-[#20c7e8]/40'
                    }`}
                  >
                    {servantName}
                  </button>
                );
              })
            )}
          </div>
        </div>
      </aside>
    </>
  );
};
