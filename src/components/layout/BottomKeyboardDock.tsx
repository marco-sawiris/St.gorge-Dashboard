import React, { useState } from 'react';
import { useApp } from '../../context/AppContext';
import { ARABIC_ALPHABET, normalizeArabicInitial } from '../../utils/arabicUtils';
import { ChevronDown, ChevronUp, Sparkles } from 'lucide-react';

export const BottomKeyboardDock: React.FC = () => {
  const { students, filters, setFilters } = useApp();
  const [isCollapsed, setIsCollapsed] = useState(false);

  // Count available students per letter under current other active filters
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

  const handleClear = () => {
    setFilters((prev) => ({ ...prev, alphabetLetter: null }));
  };

  return (
    <div
      className={`fixed bottom-0 left-0 right-0 z-30 glass-strong border-t border-[var(--border-color)] shadow-[var(--shadow)] px-2 sm:px-4 py-2 transition-all duration-300 select-none ${
        isCollapsed ? 'translate-y-[calc(100%-34px)]' : 'translate-y-0'
      }`}
    >
      {/* Header bar */}
      <div className="max-w-4xl mx-auto flex items-center justify-between h-7 px-1 mb-1.5">
        <button
          type="button"
          onClick={() => setIsCollapsed(!isCollapsed)}
          className="flex items-center gap-1.5 text-xs font-bold text-[var(--text-primary)] hover:text-[#20c7e8] cursor-pointer transition-colors"
        >
          {isCollapsed ? (
            <ChevronUp className="w-4 h-4 text-[#20c7e8]" />
          ) : (
            <ChevronDown className="w-4 h-4 text-[#20c7e8]" />
          )}
          <span>تصفية بالحروف الأبجدية</span>
        </button>

        <div className="flex items-center gap-2">
          {filters.alphabetLetter && (
            <span className="text-[11px] font-bold px-2.5 py-0.5 rounded-full bg-[#20c7e8]/15 text-[#20c7e8] border border-[#20c7e8]/30 shadow-[0_0_10px_rgba(32,199,232,0.25)] flex items-center gap-1">
              <Sparkles className="w-3 h-3 text-[#20c7e8]" />
              <span>حرف {filters.alphabetLetter} ({letterCounts[filters.alphabetLetter] || 0})</span>
            </span>
          )}

          <button
            type="button"
            onClick={handleClear}
            className={`text-xs font-bold px-3 py-0.5 rounded-xl border transition-all cursor-pointer ${
              filters.alphabetLetter === null
                ? 'btn--lens bg-gradient-to-r from-[#123fce] to-[#267aff] text-white border-[#20c7e8]/50 shadow-[0_2px_10px_rgba(38,122,255,0.4)]'
                : 'bg-[var(--surface-primary)] text-[var(--text-secondary)] border-[var(--border-color)] hover:text-[var(--text-primary)]'
            }`}
          >
            الكل
          </button>
        </div>
      </div>

      {/* Letters Grid - 2 rows of 14 letters with Claymorphism & Liquid Glass keys */}
      <div className="max-w-4xl mx-auto flex flex-col gap-1.5 pb-1">
        <div className="grid grid-cols-14 gap-1 sm:gap-1.5 w-full">
          {ARABIC_ALPHABET.slice(0, 14).map((letter) => {
            const count = letterCounts[letter] || 0;
            const isSelected = filters.alphabetLetter === letter;
            return (
              <button
                key={letter}
                type="button"
                onClick={() => handleSelectLetter(letter)}
                disabled={count === 0 && !isSelected}
                className={`h-8 sm:h-9 min-w-0 rounded-xl text-xs sm:text-sm font-bold flex items-center justify-center transition-all cursor-pointer select-none active:scale-95 ${
                  isSelected
                    ? 'bg-gradient-to-br from-[#267aff] to-[#20c7e8] text-[#030711] font-black shadow-[0_0_15px_rgba(32,199,232,0.6)] scale-105 border border-white/40'
                    : count > 0
                    ? 'bg-[var(--surface-primary)] border border-[var(--border-color)] text-[var(--text-primary)] hover:border-[#20c7e8]/50 shadow-[inset_0_1px_0_rgba(255,255,255,0.08)]'
                    : 'bg-white/[0.02] border border-[var(--border-color)]/30 text-[var(--text-muted)] opacity-30 cursor-not-allowed'
                }`}
                title={`حرف ${letter} (${count} مخدوم)`}
              >
                {letter}
              </button>
            );
          })}
        </div>

        <div className="grid grid-cols-14 gap-1 sm:gap-1.5 w-full">
          {ARABIC_ALPHABET.slice(14).map((letter) => {
            const count = letterCounts[letter] || 0;
            const isSelected = filters.alphabetLetter === letter;
            return (
              <button
                key={letter}
                type="button"
                onClick={() => handleSelectLetter(letter)}
                disabled={count === 0 && !isSelected}
                className={`h-8 sm:h-9 min-w-0 rounded-xl text-xs sm:text-sm font-bold flex items-center justify-center transition-all cursor-pointer select-none active:scale-95 ${
                  isSelected
                    ? 'bg-gradient-to-br from-[#267aff] to-[#20c7e8] text-[#030711] font-black shadow-[0_0_15px_rgba(32,199,232,0.6)] scale-105 border border-white/40'
                    : count > 0
                    ? 'bg-[var(--surface-primary)] border border-[var(--border-color)] text-[var(--text-primary)] hover:border-[#20c7e8]/50 shadow-[inset_0_1px_0_rgba(255,255,255,0.08)]'
                    : 'bg-white/[0.02] border border-[var(--border-color)]/30 text-[var(--text-muted)] opacity-30 cursor-not-allowed'
                }`}
                title={`حرف ${letter} (${count} مخدوم)`}
              >
                {letter}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
};
