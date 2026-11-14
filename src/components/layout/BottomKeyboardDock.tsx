import React, { useState } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { useApp } from '../../context/AppContext';
import { ARABIC_ALPHABET, normalizeArabicInitial } from '../../utils/arabicUtils';
import { ChevronDown, ChevronUp, Sparkles } from 'lucide-react';

/**
 * Bottom Arabic Alphabet Quick Filter Dock (Alphabet-only per user spec)
 * Auto-hides behind modals/active edits and respects Android Safe Area.
 */
export const BottomKeyboardDock: React.FC = () => {
  const {
    students,
    filters,
    setFilters,
    isSidebarCollapsed,
    isAddModalOpen,
    activeEditingId,
    isAssistantOpen,
    isSyncModalOpen,
    isAreaModalOpen,
    isAboutModalOpen,
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
    isNotificationsOpen;

  const letterCounts = React.useMemo(() => {
    const counts: Record<string, number> = {};
    students.forEach((s) => {
      if (filters.sheet !== '__ALL__' && s.sourceSheet !== filters.sheet) return;
      if (filters.servant && s.servant.trim() !== filters.servant.trim()) return;
      if (filters.area && s.area.trim() !== filters.area.trim()) return;

      const initial = normalizeArabicInitial(s.name);
      if (initial) {
        counts[initial] = (counts[initial] || 0) + 1;
      }
    });
    return counts;
  }, [students, filters.sheet, filters.servant, filters.area]);

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
          className="glass-btn px-3 py-1 rounded-full flex items-center justify-center gap-1.5 text-[11px] sm:text-xs font-extrabold cursor-pointer shrink-0 justify-self-center border border-white/25"
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

        <div className="flex items-center justify-end gap-1.5 shrink-0">
          {filters.alphabetLetter && (
            <span className="text-[11px] font-bold px-2 py-0.5 rounded-full bg-[#20c7e8]/15 text-[#20c7e8] border border-[#20c7e8]/30 flex items-center gap-1">
              <Sparkles className="w-3 h-3 text-[#20c7e8]" />
              <span>حرف {filters.alphabetLetter} ({letterCounts[filters.alphabetLetter] || 0})</span>
            </span>
          )}

          <button
            type="button"
            onClick={handleClearLetter}
            aria-pressed={filters.alphabetLetter === null}
            className={`glass-btn text-xs font-bold px-3 py-1 rounded-xl cursor-pointer ${
              filters.alphabetLetter === null ? 'glass-btn--active' : ''
            }`}
          >
            الكل
          </button>
        </div>
      </div>

      {/* Arabic Alphabet Quick Filter (28 Letters) */}
      <div className="relative z-10 max-w-4xl mx-auto flex flex-col gap-1.5 pb-0.5">
        <div className="grid grid-cols-14 gap-1 sm:gap-1.5 w-full">
          {ARABIC_ALPHABET.slice(0, 14).map((letter) => {
            const count = letterCounts[letter] || 0;
            const isSelected = filters.alphabetLetter === letter;
            return (
              <motion.button
                key={letter}
                type="button"
                onClick={() => handleSelectLetter(letter)}
                disabled={count === 0 && !isSelected}
                aria-pressed={isSelected}
                initial={shouldReduceMotion ? false : { opacity: 0, y: 10, scale: 0.92 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                whileHover={shouldReduceMotion || count === 0 ? undefined : { y: -2, scale: 1.04 }}
                whileTap={shouldReduceMotion ? undefined : { scale: 0.9 }}
                transition={{ type: 'spring', stiffness: 480, damping: 30, delay: shouldReduceMotion ? 0 : (ARABIC_ALPHABET.indexOf(letter) * 0.012) }}
                className={`glass-keyboard-key min-w-0 text-xs sm:text-sm font-bold flex items-center justify-center cursor-pointer select-none ${
                  isSelected
                    ? '!bg-gradient-to-br !from-[#267aff] !to-[#20c7e8] !text-[#030711] font-black shadow-[0_0_15px_rgba(32,199,232,0.55)] scale-105 border-white/45'
                    : count > 0
                    ? ''
                    : 'opacity-30 cursor-not-allowed'
                }`}
                title={`حرف ${letter} (${count} مخدوم)`}
              >
                {letter}
              </motion.button>
            );
          })}
        </div>

        <div className="grid grid-cols-14 gap-1 sm:gap-1.5 w-full">
          {ARABIC_ALPHABET.slice(14).map((letter) => {
            const count = letterCounts[letter] || 0;
            const isSelected = filters.alphabetLetter === letter;
            return (
              <motion.button
                key={letter}
                type="button"
                onClick={() => handleSelectLetter(letter)}
                disabled={count === 0 && !isSelected}
                aria-pressed={isSelected}
                initial={shouldReduceMotion ? false : { opacity: 0, y: 10, scale: 0.92 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                whileHover={shouldReduceMotion || count === 0 ? undefined : { y: -2, scale: 1.04 }}
                whileTap={shouldReduceMotion ? undefined : { scale: 0.9 }}
                transition={{ type: 'spring', stiffness: 480, damping: 30, delay: shouldReduceMotion ? 0 : (ARABIC_ALPHABET.indexOf(letter) * 0.012) }}
                className={`glass-keyboard-key min-w-0 text-xs sm:text-sm font-bold flex items-center justify-center cursor-pointer select-none ${
                  isSelected
                    ? '!bg-gradient-to-br !from-[#267aff] !to-[#20c7e8] !text-[#030711] font-black shadow-[0_0_15px_rgba(32,199,232,0.55)] scale-105 border-white/45'
                    : count > 0
                    ? ''
                    : 'opacity-30 cursor-not-allowed'
                }`}
                title={`حرف ${letter} (${count} مخدوم)`}
              >
                {letter}
              </motion.button>
            );
          })}
        </div>
      </div>
    </div>
  );
};
