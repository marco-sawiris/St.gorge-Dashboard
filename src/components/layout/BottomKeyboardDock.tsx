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
      } z-30 glass-strong border-t border-[var(--border-color)] shadow-[var(--shadow)] px-2 sm:px-4 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] transition-all duration-300 ease-[var(--ease-spring)] select-none overflow-hidden ${
        hasModalBlockingDock
          ? 'translate-y-full opacity-0 pointer-events-none'
          : isCollapsed
          ? 'translate-y-[calc(100%-38px)]'
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

      {/* Centered Keyboard Handle — preserve the All/Clear filter action */}
      <div className="relative z-10 max-w-4xl mx-auto grid grid-cols-[1fr_auto_1fr] items-center gap-2 h-8 px-1 mb-1.5">
        <span aria-hidden="true" />
        <button
          type="button"
          onClick={() => setIsCollapsed(!isCollapsed)}
          className="glass-btn px-3 py-1 rounded-full flex items-center justify-center gap-1.5 text-[11px] sm:text-xs font-extrabold cursor-pointer shrink-0 justify-self-center border border-white/25 whitespace-nowrap"
          aria-expanded={!isCollapsed}
          title={isCollapsed ? 'إظهار الكيبورد' : 'إخفاء الكيبورد'}
        >
          {isCollapsed ? (
            <ChevronUp className="w-3.5 h-3.5 text-[#20c7e8]" />
          ) : (
            <ChevronDown className="w-3.5 h-3.5 text-[#20c7e8]" />
          )}
          <span className="truncate">الكيبورد</span>
        </button>

        <div className="flex items-center justify-end gap-2 shrink-0">
          {activeSelectedBucket && (
            <span className="text-[11px] font-bold text-[var(--accent-secondary)] tabular-nums whitespace-nowrap">
              حرف {activeSelectedBucket.letter} · {activeSelectedBucket.count}
            </span>
          )}

          <button
            type="button"
            onClick={handleClearLetter}
            aria-pressed={filters.alphabetLetter === null}
            className={`glass-btn text-xs font-bold px-3 py-1 rounded-xl cursor-pointer whitespace-nowrap ${
              filters.alphabetLetter === null ? 'glass-btn--active' : ''
            }`}
          >
            الكل
          </button>
        </div>
      </div>

      {/* Dynamic Arabic Alphabet Quick Filter (Used Letters Only) */}
      <div className="relative z-10 max-w-4xl mx-auto pb-0.5">
        {availableAlphabetBuckets.length === 0 ? (
          <p className="text-[11px] font-semibold text-[var(--text-muted)] text-center py-2 m-0">
            لا توجد حروف متاحة في النطاق الحالي
          </p>
        ) : (
          <div className="flex flex-wrap items-center justify-center gap-1.5 sm:gap-2 max-h-[112px] overflow-y-auto px-0.5 py-0.5">
            {availableAlphabetBuckets.map(({ letter, count }, index) => {
              const isSelected = filters.alphabetLetter === letter;
              return (
                <motion.button
                  key={letter}
                  type="button"
                  onClick={() => handleSelectLetter(letter)}
                  aria-pressed={isSelected}
                  initial={shouldReduceMotion ? false : { opacity: 0, y: 8, scale: 0.94 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  whileHover={shouldReduceMotion ? undefined : { y: -2, scale: 1.04 }}
                  whileTap={shouldReduceMotion ? undefined : { scale: 0.92 }}
                  transition={{
                    type: 'spring',
                    stiffness: 480,
                    damping: 30,
                    delay: shouldReduceMotion ? 0 : Math.min(index, 14) * 0.012
                  }}
                  className={`glass-keyboard-key min-w-[40px] sm:min-w-[44px] min-h-[40px] px-2.5 text-xs sm:text-sm font-bold flex items-center justify-center cursor-pointer select-none whitespace-nowrap ${
                    isSelected
                      ? '!bg-gradient-to-br !from-[#267aff] !to-[#20c7e8] !text-[#030711] font-black shadow-[0_0_15px_rgba(32,199,232,0.55)] scale-105 border-white/45'
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
