import React from 'react';
import { motion } from 'motion/react';
import { useApp } from '../../context/AppContext';
import { CreditCard, Table as TableIcon, PieChart, PhoneCall } from 'lucide-react';

const TAB_ORDER = ['cards', 'table', 'charts', 'followup'] as const;

export const NavigationTabs: React.FC = () => {
  const { activeView, setActiveView, filteredStudents } = useApp();

  const tabs = [
    { id: 'cards', label: `كروت المخدومين (${filteredStudents.length})`, shortLabel: 'الكروت', icon: CreditCard },
    { id: 'table', label: 'جدول الحضور', shortLabel: 'الجدول', icon: TableIcon },
    { id: 'charts', label: 'الإحصائيات الذكية', shortLabel: 'الإحصاءات', icon: PieChart },
    { id: 'followup', label: 'سجل الافتقاد', shortLabel: 'الافتقاد', icon: PhoneCall }
  ] as const;

  const handleKeyDown = (e: React.KeyboardEvent, idx: number) => {
    // RTL-aware left/right keyboard navigation between tabs
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      const nextIdx = (idx + 1) % TAB_ORDER.length;
      setActiveView(TAB_ORDER[nextIdx]);
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      const prevIdx = (idx - 1 + TAB_ORDER.length) % TAB_ORDER.length;
      setActiveView(TAB_ORDER[prevIdx]);
    }
  };

  return (
    <nav
      role="tablist"
      aria-label="التنقل الرئيسي بين أقسام التطبيق"
      className="clay-selection-bar word-in-scope relative grid grid-cols-4 min-w-0 gap-1 p-1.5 mb-5 select-none backdrop-blur-xl"
    >
      {tabs.map((tab, idx) => {
        const IconComponent = tab.icon;
        const isActive = activeView === tab.id;
        return (
          <motion.button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={isActive}
            aria-pressed={isActive}
            whileTap={{ scale: 0.96 }}
            onClick={() => setActiveView(tab.id)}
            onKeyDown={(e) => handleKeyDown(e, idx)}
            style={{ '--i': idx } as React.CSSProperties}
            className={`word-in relative flex min-w-0 flex-col sm:flex-row items-center justify-center gap-1 sm:gap-2 py-2 px-1 sm:px-3 rounded-xl text-[10px] sm:text-sm font-extrabold cursor-pointer transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#20C7E8] ${
              isActive
                ? 'text-white'
                : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-white/[0.05]'
            }`}
          >
            {isActive && (
              <motion.span
                layoutId="navActiveIndicator"
                transition={{ type: 'spring', stiffness: 420, damping: 32, mass: 0.85 }}
                aria-hidden="true"
                className="clay-active-pill glass-btn--active absolute inset-0 rounded-xl pointer-events-none"
              >
                <span className="absolute bottom-1 left-4 right-4 h-[2.5px] rounded-full bg-gradient-to-r from-[#20C7E8] via-white/90 to-[#267AFF] shadow-[0_0_10px_rgba(32,199,232,0.85)]" />
              </motion.span>
            )}

            <motion.span
              aria-hidden="true"
              animate={isActive ? { scale: 1.12, rotate: -4 } : { scale: 1, rotate: 0 }}
              transition={{ type: 'spring', stiffness: 380, damping: 24 }}
              className="relative z-10 inline-flex items-center justify-center"
            >
              <IconComponent className={`w-4 h-4 ${isActive ? 'text-[#20C7E8] drop-shadow-[0_0_8px_rgba(32,199,232,0.65)]' : ''}`} />
            </motion.span>

            <span className="relative z-10 hidden sm:inline whitespace-nowrap">{tab.label}</span>
            <span className="relative z-10 sm:hidden whitespace-nowrap text-[10px]">{tab.shortLabel}</span>
          </motion.button>
        );
      })}
    </nav>
  );
};
