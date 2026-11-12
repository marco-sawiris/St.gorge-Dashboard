import React from 'react';
import { useTheme } from '../../context/ThemeContext';
import { Moon, Sun } from 'lucide-react';

export const ThemeSwitcher: React.FC<{ className?: string }> = ({ className = '' }) => {
  const { theme, setTheme, toggleTheme, isDark } = useTheme();

  return (
    <div
      className={`relative inline-flex items-center p-1 rounded-full bg-[var(--glass-bg)] border border-[var(--glass-border)] shadow-[var(--shadow-1)] backdrop-blur-xl select-none transition-all duration-300 ${className}`}
      role="group"
      aria-label="مبدل المظهر (داكن / فاتح)"
    >
      {/* Dark Theme Button */}
      <button
        type="button"
        onClick={() => setTheme('dark')}
        aria-pressed={isDark}
        className={`relative z-10 flex items-center gap-1.5 px-2.5 sm:px-3 py-1 rounded-full text-xs font-bold transition-all duration-300 cursor-pointer active:scale-95 ${
          isDark
            ? 'text-white shadow-[0_0_14px_rgba(32,199,232,0.45)]'
            : 'text-[var(--text-muted)] hover:text-[var(--text)]'
        }`}
        title="تفعيل المظهر الداكن (Dark)"
      >
        <Moon className={`w-3.5 h-3.5 transition-transform duration-300 ${isDark ? 'text-[var(--accent)] scale-110' : ''}`} />
        <span className="hidden sm:inline">داكن</span>
      </button>

      {/* Light Theme Button */}
      <button
        type="button"
        onClick={() => setTheme('light')}
        aria-pressed={!isDark}
        className={`relative z-10 flex items-center gap-1.5 px-2.5 sm:px-3 py-1 rounded-full text-xs font-bold transition-all duration-300 cursor-pointer active:scale-95 ${
          !isDark
            ? 'text-white shadow-[0_2px_12px_rgba(18,63,206,0.35)]'
            : 'text-[var(--text-muted)] hover:text-[var(--text)]'
        }`}
        title="تفعيل المظهر الفاتح (Light)"
      >
        <Sun className={`w-3.5 h-3.5 transition-transform duration-300 ${!isDark ? 'text-amber-300 scale-110' : ''}`} />
        <span className="hidden sm:inline">فاتح</span>
      </button>

      {/* Liquid Glass Sliding Active Pill Indicator */}
      <div
        className={`absolute top-1 bottom-1 w-[calc(50%-4px)] rounded-full transition-all duration-300 ease-[cubic-bezier(0.34,1.56,0.64,1)] pointer-events-none ${
          isDark
            ? 'right-1 bg-gradient-to-r from-[var(--primary)] to-[var(--royal)] border border-[var(--glass-border-2)] shadow-[inset_0_1px_1px_rgba(255,255,255,0.4),0_0_12px_rgba(32,199,232,0.35)]'
            : 'right-[calc(50%)] bg-gradient-to-r from-[#267AFF] to-[#123FCE] border border-white/40 shadow-[inset_0_1px_1px_rgba(255,255,255,0.6),0_4px_14px_rgba(18,63,206,0.35)]'
        }`}
      />
    </div>
  );
};
