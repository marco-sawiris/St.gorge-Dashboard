import React, { useState } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { useApp } from '../../context/AppContext';
import { ChevronDown, ChevronUp } from 'lucide-react';

/**
 * Bottom Arabic Alphabet Quick Filter Dock (Dynamic Used-Letters Only)
 * Derives active letters solely from real registered student names, sorted dynamically
 * in Arabic alphabetical order. Auto-hides behind modals/active edits and respects Safe Area.
 */
export const BottomKeyboardDock: React.FC = () => {
  const {
    availableAlphabetBuckets,
    filters,
    setFilters,
    isSidebarCollapsed,
    isAddModalOpen,
    activeEditingId,
    isAssistantOpen,
    isSyncModalOpen,
    isAreaModalOpen,
    isAboutModalOpen,
    isAppearanceModalOpen,
    isNotificationsOpen
  } = useApp();

  const [isCollapsed, setIsCollapsed] = useState(false);
  const shouldReduceMotion = useReducedMotion();

  const hasModalBlockingDock =
    isAddModalOpen ||
    Boolean(activeEditingId) ||
    isAssistantOpen ||
    isSyncModalOpen ||
    isAreaModalOpen ||
    isAboutModalOpen ||
    isAppearanceModalOpen ||
    isNotificationsOpen;

  const activeSelectedBucket = filters.alphabetLetter
    ? availableAlphabetBuckets.find((b) => b.letter === filters.alphabetLetter) || null
    : null;

  const handleSelectLetter = (letter: string) => {
    setFilters((prev) => ({
      ...prev,
      alphabetLetter: prev.alphabetLetter === letter ? null : letter
    }));
  };

  const handleClearLetter = () => {
    setFilters((prev) => ({ ...prev, alphabetLetter: null }));
  };

  return (
    <div
      role="region"
      aria-label="شريط التصفية الأبجدية"
      aria-hidden={hasModalBlockingDock}
      className={`fixed bottom-0 left-0 right-0 ${
        isSidebarCollapsed ? 'lg:right-[84px]' : 'lg:right-[272px]'
      } z-30 glass-strong border-t border-[var(--border-color)] shadow-[var(--shadow)] px-2 sm:px-3 pt-1.5 pb-[max(0.35rem,env(safe-area-inset-bottom))] transition-all duration-300 ease-[var(--ease-spring)] select-none overflow-hidden ${
        hasModalBlockingDock
          ? 'translate-y-full opacity-0 pointer-events-none'
          : isCollapsed
          ? 'translate-y-[calc(100%-32px)]'
          : 'translate-y-0'
      }`}
    >
      {/* Subtle Ambient Glassmorphism Glow inside Dock */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -top-10 right-10 w-36 h-36 rounded-full bg-radial from-[#267AFF]/20 via-[#20C7E8]/10 to-transparent blur-2xl"
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -bottom-10 left-12 w-40 h-40 rounded-full bg-radial from-[#6548F5]/20 via-[#20C7E8]/10 to-transparent blur-2xl"
      />

      {/* Keyboard Handle & All/Clear filter action — compact bar keeping clear tap targets */}
      <div className="relative z-10 max-w-4xl mx-auto flex flex-wrap items-center justify-between gap-1.5 min-h-[30px] h-auto px-1 mb-1">
        <button
          type="button"
          onClick={() => setIsCollapsed(!isCollapsed)}
          className="glass-btn min-h-[28px] px-2.5 py-0.5 rounded-full flex items-center justify-center gap-1 text-[11px] sm:text-xs font-extrabold cursor-pointer shrink-0 border border-[var(--border-color)] whitespace-nowrap"
          aria-expanded={!isCollapsed}
          title={isCollapsed ? 'إظهار الكيبورد' : 'إخفاء الكيبورد'}
        >
          {isCollapsed ? (
            <ChevronUp className="w-3.5 h-3.5 text-[var(--accent-secondary)] shrink-0" />
          ) : (
            <ChevronDown className="w-3.5 h-3.5 text-[var(--accent-secondary)] shrink-0" />
          )}
          <span>الكيبورد</span>
        </button>

        <div className="flex flex-wrap items-center justify-end gap-1.5 min-w-0">
          {activeSelectedBucket && (
            <span className="text-[11px] font-bold text-[var(--accent-secondary)] tabular-nums whitespace-nowrap">
              حرف {activeSelectedBucket.letter} · {activeSelectedBucket.count}
            </span>
          )}

          <button
            type="button"
            onClick={handleClearLetter}
            aria-pressed={filters.alphabetLetter === null}
            className={`glass-btn min-h-[28px] text-[11px] sm:text-xs font-bold px-2.5 py-0.5 rounded-lg cursor-pointer whitespace-nowrap shrink-0 ${
              filters.alphabetLetter === null ? 'glass-btn--active' : ''
            }`}
          >
            الكل
          </button>
        </div>
      </div>

      {/* Dynamic Arabic Alphabet Quick Filter (Used Letters Only) */}
      <div className="relative z-10 max-w-4xl mx-auto">
        {availableAlphabetBuckets.length === 0 ? (
          <p className="text-[11px] font-semibold text-[var(--text-muted)] text-center py-1.5 m-0">
            لا توجد حروف متاحة في النطاق الحالي
          </p>
        ) : (
          <div className="flex flex-nowrap items-center justify-start sm:justify-center gap-1.5 overflow-x-auto no-scrollbar px-0.5 py-0.5">
            {availableAlphabetBuckets.map(({ letter, count }, index) => {
              const isSelected = filters.alphabetLetter === letter;
              return (
                <motion.button
                  key={letter}
                  type="button"
                  onClick={() => handleSelectLetter(letter)}
                  aria-pressed={isSelected}
                  initial={shouldReduceMotion ? false : { opacity: 0, y: 6, scale: 0.95 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  whileHover={shouldReduceMotion ? undefined : { y: -1.5, scale: 1.03 }}
                  whileTap={shouldReduceMotion ? undefined : { scale: 0.92 }}
                  transition={{
                    type: 'spring',
                    stiffness: 480,
                    damping: 30,
                    delay: shouldReduceMotion ? 0 : Math.min(index, 14) * 0.012
                  }}
                  className={`glass-keyboard-key w-[34px] min-w-[34px] h-[34px] sm:w-[38px] sm:min-w-[38px] sm:h-[38px] px-1 text-[13px] sm:text-sm font-extrabold leading-none flex items-center justify-center shrink-0 cursor-pointer select-none whitespace-nowrap ${
                    isSelected
                      ? '!bg-gradient-to-br !from-[#1d4ed8] !to-[#123fce] !text-white font-black shadow-[0_0_12px_rgba(18,63,206,0.45)] scale-[1.03] border-white/45'
                      : ''
                  }`}
                  title={`حرف ${letter} (${count} مخدوم)`}
                >
                  {letter}
                </motion.button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};
