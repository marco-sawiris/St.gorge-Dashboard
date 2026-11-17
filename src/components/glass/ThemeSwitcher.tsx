import React from 'react';
import { useTheme, Theme } from '../../context/ThemeContext';
import { Moon, CloudMoon, Sun } from 'lucide-react';

export const ThemeSwitcher: React.FC<{ className?: string }> = ({ className = '' }) => {
  const { theme, setTheme } = useTheme();

  const themes: { id: Theme; label: string; icon: React.FC<{ className?: string }>; title: string }[] = [
    { id: 'dark', label: 'داكن', icon: Moon, title: 'المظهر الداكن (Dark - Midnight)' },
    { id: 'dim', label: 'خافت', icon: CloudMoon, title: 'المظهر الخافت (Dim - Deep Navy)' },
    { id: 'light', label: 'فاتح', icon: Sun, title: 'المظهر الفاتح (Light - Daylight)' }
  ];

  return (
    <div
      className={`relative inline-flex flex-wrap items-center gap-1 p-1 rounded-2xl bg-[var(--surface-primary)] border border-[var(--border-color)] shadow-xs select-none ${className}`}
      role="group"
      aria-label="مبدل المظهر (داكن / خافت / فاتح)"
    >
      {themes.map((t) => {
        const isActive = theme === t.id;
        const Icon = t.icon;
        return (
          <button
            key={t.id}
            type="button"
            onClick={() => setTheme(t.id)}
            aria-pressed={isActive}
            className={`relative z-10 min-h-[36px] flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-bold transition-all duration-200 cursor-pointer active:scale-95 ${
              isActive
                ? 'bg-gradient-to-r from-[#123FCE] to-[#1D4ED8] text-white shadow-[0_0_12px_rgba(18,63,206,0.35)]'
                : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-secondary)]/70'
            }`}
            title={t.title}
          >
            <Icon className={`w-3.5 h-3.5 shrink-0 ${isActive ? (t.id === 'light' ? 'text-amber-200' : 'text-sky-200') : ''}`} />
            <span>{t.label}</span>
          </button>
        );
      })}
    </div>
  );
};

