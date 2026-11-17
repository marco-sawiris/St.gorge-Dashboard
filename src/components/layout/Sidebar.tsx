import React, { useEffect, useState } from 'react';
import { motion } from 'motion/react';
import { useApp } from '../../context/AppContext';

const stGeorgeIcon = new URL('../../assets/images/st_george_icon_1794405195493.jpg', import.meta.url).href;
import {
  X,
  CreditCard,
  Table as TableIcon,
  PieChart,
  PhoneCall,
  MapPin,
  ExternalLink,
  Info,
  ShieldAlert,
  ShieldCheck,
  RefreshCw,
  PanelRightClose,
  PanelRightOpen,
  Bot,
  Palette,
  FileUp
} from 'lucide-react';

export const Sidebar: React.FC = () => {
  const {
    isSidebarOpen,
    setIsSidebarOpen,
    isSidebarCollapsed,
    setIsSidebarCollapsed,
    activeView,
    setActiveView,
    setIsAboutModalOpen,
    setIsAppearanceModalOpen,
    setIsPdfImportModalOpen,
    setIsAreaModalOpen,
    setIsSyncModalOpen,
    setIsAssistantOpen,
    students,
    filters,
    setFilters,
    syncState
  } = useApp();

  const [showAllServants, setShowAllServants] = useState(false);
  const [drawerOpenKey, setDrawerOpenKey] = useState(0);
  const [dragOffsetX, setDragOffsetX] = useState(0);
  const [isDraggingDrawer, setIsDraggingDrawer] = useState(false);
  const touchStartRef = React.useRef<{ x: number; y: number } | null>(null);

  // Re-trigger staggered wordIn item choreography every time mobile drawer opens
  useEffect(() => {
    if (isSidebarOpen) {
      setDrawerOpenKey((k) => k + 1);
      setDragOffsetX(0);
    }
  }, [isSidebarOpen]);

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

  const visibleServants = showAllServants ? uniqueServants : uniqueServants.slice(0, 6);

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

  const handleDrawerTouchStart = (e: React.TouchEvent) => {
    if (!isSidebarOpen || e.touches.length !== 1) return;
    touchStartRef.current = {
      x: e.touches[0].clientX,
      y: e.touches[0].clientY
    };
    setDragOffsetX(0);
  };

  const handleDrawerTouchMove = (e: React.TouchEvent) => {
    if (!isSidebarOpen || !touchStartRef.current || e.touches.length !== 1) return;
    const dx = e.touches[0].clientX - touchStartRef.current.x;
    const dy = e.touches[0].clientY - touchStartRef.current.y;
    if (dx > 8 && Math.abs(dx) > Math.abs(dy) * 1.15) {
      setIsDraggingDrawer(true);
      setDragOffsetX(Math.min(dx, 280));
    }
  };

  const handleDrawerTouchEnd = (e: React.TouchEvent) => {
    if (!isSidebarOpen || !touchStartRef.current || e.changedTouches.length === 0) return;
    const dx = e.changedTouches[0].clientX - touchStartRef.current.x;
    const dy = e.changedTouches[0].clientY - touchStartRef.current.y;
    touchStartRef.current = null;
    setIsDraggingDrawer(false);
    setDragOffsetX(0);
    // RTL right-docked drawer closes smoothly when swiped rightward without blocking vertical scroll
    if (dx > 56 && Math.abs(dx) > Math.abs(dy) * 1.25) {
      setIsSidebarOpen(false);
    }
  };

  const navLinkClass = (isActive: boolean) =>
    `sidebar-nav-item relative flex items-center w-full min-w-0 h-auto min-h-[36px] ${
      isSidebarCollapsed ? 'lg:justify-center lg:px-0' : 'justify-start gap-2.5 ps-3 pe-2.5'
    } py-1.5 rounded-lg text-[12.5px] leading-snug font-bold text-right cursor-pointer ${
      isActive ? 'text-[var(--text-primary)] font-extrabold' : ''
    }`;

  const renderActiveBar = (isActive: boolean) =>
    isActive ? (
      <motion.span
        layoutId="sidebarActiveIndicator"
        transition={{ type: 'spring', stiffness: 420, damping: 32 }}
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 rounded-xl bg-gradient-to-l from-[#20C7E8]/20 via-[#267AFF]/12 to-transparent border border-[#20C7E8]/35"
      >
        <span className="absolute top-[18%] bottom-[18%] right-0 w-[3px] rounded-full bg-gradient-to-b from-[#20C7E8] to-[#267AFF] shadow-[0_0_10px_rgba(32,199,232,0.8)]" />
      </motion.span>
    ) : null;

  return (
    <>
      {/* Mobile Drawer Backdrop Overlay (< 1024px) — Original Dashboard Fade + Blur */}
      <div
        onClick={() => setIsSidebarOpen(false)}
        aria-hidden={!isSidebarOpen}
        className={`sidebar-overlay-transition fixed inset-0 z-50 lg:hidden ${
          isSidebarOpen
            ? 'opacity-100 visible pointer-events-auto'
            : 'opacity-0 invisible pointer-events-none'
        }`}
      />

      {/* Premium Animated Liquid Glass Sidebar + Original Spring Slide, Live Drag & Stagger */}
      <aside
        aria-label="القائمة الجانبية الرئيسية"
        onTouchStart={handleDrawerTouchStart}
        onTouchMove={handleDrawerTouchMove}
        onTouchEnd={handleDrawerTouchEnd}
        onTouchCancel={handleDrawerTouchEnd}
        style={
          isDraggingDrawer && dragOffsetX > 0
            ? { transform: `translate3d(${dragOffsetX}px, 0, 0)`, transition: 'none' }
            : undefined
        }
        className={`sidebar-glass-panel sidebar-drawer-spring fixed top-0 right-0 bottom-0 z-50 flex flex-col overflow-hidden select-none ${
          isSidebarOpen ? 'sidebar-drawer-open translate-x-0' : 'translate-x-full lg:translate-x-0'
        } w-[74vw] max-w-[244px] ${
          isSidebarCollapsed ? 'lg:w-[76px]' : 'lg:w-[232px]'
        }`}
      >
        {/* Organic Animated Morphing Liquid Blobs & Moving Glowing Light Orb Behind Glass Surface */}
        <div className="sidebar-blob" aria-hidden="true" />
        <div className="sidebar-blob-secondary" aria-hidden="true" />
        <div className="sidebar-light-orb" aria-hidden="true" />

        {/* Subtle Inner Light Rim Highlight */}
        <div
          className="absolute inset-0 pointer-events-none"
          style={{ background: 'var(--sidebar-sheen)' }}
          aria-hidden="true"
        />

        {/* Scrollable Foreground Layer (shrink-0 children guarantee zero overlap at any height) */}
        <div className="relative z-10 flex flex-col flex-1 min-h-0 p-2.5 pb-[max(0.85rem,env(safe-area-inset-bottom))] overflow-y-auto overflow-x-hidden justify-start gap-1.5">
          {/* Brand Header & Collapse / Close Controls */}
          <div
            className={`flex items-center gap-2 ${
              isSidebarCollapsed ? 'lg:flex-col lg:gap-2 lg:justify-center' : 'justify-between'
            } pb-2 border-b border-[var(--border-color)] shrink-0`}
          >
            <div className={`flex items-center gap-2 min-w-0 flex-1 ${isSidebarCollapsed ? 'lg:flex-none lg:justify-center' : ''}`}>
              <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-[#123fce]/30 to-[#20c7e8]/30 p-0.5 border border-[#20c7e8]/40 shadow-[0_0_12px_rgba(32,199,232,0.2)] shrink-0">
                <img
                  src={stGeorgeIcon}
                  alt="St. George Dashboard"
                  width={1024}
                  height={1024}
                  className="w-full h-full aspect-square object-contain rounded-[10px] block"
                />
              </div>
              <div className={`min-w-0 flex-1 ${isSidebarCollapsed ? 'lg:hidden' : ''}`}>
                <h2 className="font-extrabold text-[13px] leading-tight text-[var(--text-primary)] m-0 break-words">
                  St. George Dashboard
                </h2>
                <p className="text-[10px] leading-tight text-[var(--accent-secondary)] m-0 mt-0.5 font-bold break-words">
                  فصل الشهيد مارجرجس
                </p>
              </div>
            </div>

            {/* Mobile Close Drawer Button */}
            <button
              type="button"
              onClick={() => setIsSidebarOpen(false)}
              className="glass-btn lg:hidden min-w-[34px] min-h-[34px] w-8 h-8 rounded-xl flex items-center justify-center cursor-pointer shrink-0"
              aria-label="إغلاق القائمة"
            >
              <X className="w-4 h-4 shrink-0" />
            </button>

            {/* Desktop Collapse / Expand Toggle Button */}
            <button
              type="button"
              onClick={() => setIsSidebarCollapsed((prev) => !prev)}
              className="glass-btn hidden lg:flex min-w-[34px] min-h-[34px] w-8 h-8 rounded-xl text-[var(--accent-secondary)] items-center justify-center cursor-pointer shrink-0"
              aria-label={isSidebarCollapsed ? 'توسيع القائمة الجانبية' : 'طي القائمة الجانبية'}
              title={isSidebarCollapsed ? 'توسيع القائمة' : 'طي القائمة'}
            >
              {isSidebarCollapsed ? (
                <PanelRightOpen className="w-4 h-4 shrink-0" />
              ) : (
                <PanelRightClose className="w-4 h-4 shrink-0" />
              )}
            </button>
          </div>

          {/* Direct Service Mode Indicator */}
          <div
            className={`px-2.5 py-1.5 rounded-xl bg-[var(--surface-primary)]/55 backdrop-blur-md border border-[var(--border-color)]/70 flex items-center shrink-0 ${
              isSidebarCollapsed ? 'lg:justify-center lg:p-1.5' : 'gap-2'
            }`}
            title="وضع الخدمة المباشر — مزامنة Google Sheets ودعم الأوفلاين"
          >
            <div className="w-7 h-7 rounded-lg bg-[var(--info-bg)] border border-[var(--info-border)] flex items-center justify-center text-[var(--accent-secondary)] shrink-0">
              <ShieldCheck className="w-3.5 h-3.5 shrink-0" />
            </div>
            <div className={`min-w-0 flex-1 ${isSidebarCollapsed ? 'lg:hidden' : ''}`}>
              <p className="text-[11px] font-extrabold text-[var(--text-primary)] m-0 leading-tight break-words">
                وضع الخدمة المباشر
              </p>
              <p className="text-[9.5px] font-bold text-[var(--accent-secondary)] m-0 mt-0.5 leading-tight break-words">
                Google Sheets + العمل دون اتصال
              </p>
            </div>
          </div>

          {/* Clean Sleek Flat Navigation List with Compact Spacing & Gliding Active Bar */}
          <nav key={drawerOpenKey} className="flex flex-col gap-1 shrink-0" aria-label="أقسام التطبيق">
            <button
              type="button"
              onClick={() => handleNav('cards')}
              title="كروت المخدومين"
              aria-current={activeView === 'cards' ? 'page' : undefined}
              style={{ '--i': 0 } as React.CSSProperties}
              className={navLinkClass(activeView === 'cards')}
            >
              {renderActiveBar(activeView === 'cards')}
              <CreditCard className={`relative z-10 w-4 h-4 shrink-0 transition-transform duration-200 ${activeView === 'cards' ? 'text-[var(--accent-secondary)] scale-105' : 'text-[var(--text-secondary)]'}`} />
              <span className={`relative z-10 min-w-0 flex-1 whitespace-normal break-words leading-snug text-right ${isSidebarCollapsed ? 'lg:hidden' : ''}`}>
                كروت المخدومين
              </span>
            </button>

            <button
              type="button"
              onClick={() => handleNav('table')}
              title="جدول الحضور"
              aria-current={activeView === 'table' ? 'page' : undefined}
              style={{ '--i': 1 } as React.CSSProperties}
              className={navLinkClass(activeView === 'table')}
            >
              {renderActiveBar(activeView === 'table')}
              <TableIcon className={`relative z-10 w-4 h-4 shrink-0 transition-transform duration-200 ${activeView === 'table' ? 'text-[var(--accent-secondary)] scale-105' : 'text-[var(--text-secondary)]'}`} />
              <span className={`relative z-10 min-w-0 flex-1 whitespace-normal break-words leading-snug text-right ${isSidebarCollapsed ? 'lg:hidden' : ''}`}>
                جدول الحضور
              </span>
            </button>

            <button
              type="button"
              onClick={() => handleNav('charts')}
              title="الإحصائيات الذكية"
              aria-current={activeView === 'charts' ? 'page' : undefined}
              style={{ '--i': 2 } as React.CSSProperties}
              className={navLinkClass(activeView === 'charts')}
            >
              {renderActiveBar(activeView === 'charts')}
              <PieChart className={`relative z-10 w-4 h-4 shrink-0 transition-transform duration-200 ${activeView === 'charts' ? 'text-[var(--accent-secondary)] scale-105' : 'text-[var(--text-secondary)]'}`} />
              <span className={`relative z-10 min-w-0 flex-1 whitespace-normal break-words leading-snug text-right ${isSidebarCollapsed ? 'lg:hidden' : ''}`}>
                الإحصائيات الذكية
              </span>
            </button>

            <button
              type="button"
              onClick={() => handleNav('followup')}
              title="سجل الافتقاد"
              aria-current={activeView === 'followup' ? 'page' : undefined}
              style={{ '--i': 3 } as React.CSSProperties}
              className={navLinkClass(activeView === 'followup')}
            >
              {renderActiveBar(activeView === 'followup')}
              <PhoneCall className={`relative z-10 w-4 h-4 shrink-0 transition-transform duration-200 ${activeView === 'followup' ? 'text-[var(--accent-secondary)] scale-105' : 'text-[var(--text-secondary)]'}`} />
              <span className={`relative z-10 min-w-0 flex-1 whitespace-normal break-words leading-snug text-right ${isSidebarCollapsed ? 'lg:hidden' : ''}`}>
                سجل الافتقاد
              </span>
            </button>

            <div className="my-1 border-t border-[var(--border-color)]/60 shrink-0" />

            <button
              type="button"
              onClick={() => {
                setIsSidebarOpen(false);
                setIsAreaModalOpen(true);
              }}
              title="المناطق السكنية"
              style={{ '--i': 4 } as React.CSSProperties}
              className={navLinkClass(false)}
            >
              <MapPin className="w-4 h-4 shrink-0 text-[var(--accent-secondary)]" />
              <span className={`min-w-0 flex-1 whitespace-normal break-words leading-snug text-right ${isSidebarCollapsed ? 'lg:hidden' : ''}`}>
                المناطق السكنية
              </span>
            </button>

            <button
              type="button"
              onClick={() => {
                setIsSidebarOpen(false);
                setIsSyncModalOpen(true);
              }}
              title="حالة وتفاصيل المزامنة"
              style={{ '--i': 5 } as React.CSSProperties}
              className={navLinkClass(false)}
            >
              <RefreshCw
                className={`w-4 h-4 shrink-0 text-[var(--accent-secondary)] ${syncState === 'syncing' ? 'animate-spin' : ''}`}
              />
              <span className={`min-w-0 flex-1 whitespace-normal break-words leading-snug text-right ${isSidebarCollapsed ? 'lg:hidden' : ''}`}>
                حالة المزامنة
              </span>
            </button>

            <a
              href="https://docs.google.com/spreadsheets/d/15Nda4pGb3WdAfOuRTwRS9Fx822_EORgumOmhZcjTVt0/edit"
              target="_blank"
              rel="noopener noreferrer"
              title="فتح ملف الشيت"
              style={{ '--i': 6 } as React.CSSProperties}
              className={navLinkClass(false)}
            >
              <ExternalLink className="w-4 h-4 shrink-0 text-[var(--accent-secondary)]" />
              <span className={`min-w-0 flex-1 whitespace-normal break-words leading-snug text-right ${isSidebarCollapsed ? 'lg:hidden' : ''}`}>
                فتح ملف الشيت
              </span>
            </a>

            <button
              type="button"
              onClick={() => {
                setIsSidebarOpen(false);
                setIsAssistantOpen(true);
              }}
              title="المساعد الذكي"
              style={{ '--i': 7 } as React.CSSProperties}
              className={navLinkClass(false)}
            >
              <Bot className="w-4 h-4 shrink-0 text-[var(--accent-secondary)]" />
              <span className={`min-w-0 flex-1 whitespace-normal break-words leading-snug text-right ${isSidebarCollapsed ? 'lg:hidden' : ''}`}>
                المساعد الذكي
              </span>
            </button>

            <button
              type="button"
              onClick={() => {
                setIsSidebarOpen(false);
                setIsPdfImportModalOpen(true);
              }}
              title="استيراد كشف PDF"
              style={{ '--i': 8 } as React.CSSProperties}
              className={navLinkClass(false)}
            >
              <FileUp className="w-4 h-4 shrink-0 text-[var(--accent-secondary)]" />
              <span className={`min-w-0 flex-1 whitespace-normal break-words leading-snug text-right ${isSidebarCollapsed ? 'lg:hidden' : ''}`}>
                استيراد كشف PDF
              </span>
            </button>

            <button
              type="button"
              onClick={() => {
                setIsSidebarOpen(false);
                setIsAppearanceModalOpen(true);
              }}
              title="مظهر وسمة التطبيق"
              style={{ '--i': 9 } as React.CSSProperties}
              className={navLinkClass(false)}
            >
              <Palette className="w-4 h-4 shrink-0 text-[var(--accent-secondary)]" />
              <span className={`min-w-0 flex-1 whitespace-normal break-words leading-snug text-right ${isSidebarCollapsed ? 'lg:hidden' : ''}`}>
                مظهر وسمة التطبيق
              </span>
            </button>

            <button
              type="button"
              onClick={() => {
                setIsSidebarOpen(false);
                setIsAboutModalOpen(true);
              }}
              title="عن التطبيق"
              style={{ '--i': 10 } as React.CSSProperties}
              className={navLinkClass(false)}
            >
              <Info className="w-4 h-4 shrink-0 text-[var(--accent-secondary)]" />
              <span className={`min-w-0 flex-1 whitespace-normal break-words leading-snug text-right ${isSidebarCollapsed ? 'lg:hidden' : ''}`}>
                عن التطبيق
              </span>
            </button>
          </nav>

          {/* Compact Servants Filter Section */}
          <div className={`pt-2 border-t border-[var(--border-color)]/70 shrink-0 ${isSidebarCollapsed ? 'lg:hidden' : ''}`}>
            <div className="flex flex-wrap items-center justify-between gap-1.5 mb-1">
              <p className="text-[10.5px] font-bold text-[var(--text-secondary)] flex items-center gap-1.5 m-0 min-w-0">
                <ShieldAlert className="w-3.5 h-3.5 text-[var(--accent-secondary)] shrink-0" />
                <span>أشابين وخدام الفصل</span>
              </p>
              <div className="flex items-center gap-1.5 shrink-0">
                {uniqueServants.length > 6 && (
                  <button
                    type="button"
                    onClick={() => setShowAllServants((v) => !v)}
                    className="text-[10px] font-bold text-[var(--accent-secondary)] hover:underline cursor-pointer"
                  >
                    {showAllServants ? 'أقل' : `+${uniqueServants.length - 6}`}
                  </button>
                )}

              </div>
            </div>

            <div className="flex flex-wrap gap-1">
              {uniqueServants.length === 0 ? (
                <span className="text-[10.5px] text-[var(--text-muted)] italic">لا يوجد خدام محملون</span>
              ) : (
                visibleServants.map((servantName) => {
                  const isActive = filters.servant === servantName;
                  return (
                    <button
                      key={servantName}
                      type="button"
                      aria-pressed={isActive}
                      onClick={() => handleToggleServant(servantName)}
                      className={`min-h-[28px] px-2 py-0.5 rounded-lg text-[10.5px] font-bold leading-snug max-w-full break-words text-right cursor-pointer select-none border transition-all duration-200 active:scale-95 ${
                        isActive
                          ? 'bg-gradient-to-r from-[#123FCE] to-[#0369A1] text-white border-[#38BDF8]/65 shadow-[0_2px_10px_rgba(18,63,206,0.35)]'
                          : 'bg-[var(--surface-primary)] border-[var(--border-color)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:border-[var(--accent-secondary)]'
                      }`}
                    >
                      {servantName}
                    </button>
                  );
                })
              )}
            </div>
            {filters.servant && (
              <button
                type="button"
                onClick={() => setFilters((p) => ({ ...p, servant: '' }))}
                className="mt-1.5 w-full px-2.5 py-1.5 rounded-lg text-[10.5px] font-bold text-[var(--accent-secondary)] bg-[var(--surface-primary)]/60 border border-[var(--border-color)] hover:border-[var(--accent-secondary)]/50 transition-colors cursor-pointer"
                aria-label="مسح فلتر الأشبين وعرض كل المخدومين"
              >
                اعرض الكل
              </button>
            )}
          </div>
        </div>
      </aside>
    </>
  );
};
