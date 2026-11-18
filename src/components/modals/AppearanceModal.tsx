import React from 'react';
import { useApp } from '../../context/AppContext';
import { Theme, useTheme } from '../../context/ThemeContext';
import { ThemeSwitcher } from '../glass/ThemeSwitcher';
import { Check, CloudMoon, Moon, Palette, Sun, X } from 'lucide-react';

const THEME_OPTIONS: Array<{
  id: Theme;
  label: string;
  subtitle: string;
  icon: React.FC<{ className?: string }>;
  swatchBg: string;
  swatchSurface: string;
  swatchAccent: string;
}> = [
  {
    id: 'dark',
    label: 'داكن',
    subtitle: 'خلفية ليلية عميقة مع تباين عالٍ وإضاءة زرقاء',
    icon: Moon,
    swatchBg: 'bg-[#030711]',
    swatchSurface: 'bg-[#0b1936] border-[#20c7e8]/45',
    swatchAccent: 'bg-[#20c7e8]'
  },
  {
    id: 'dim',
    label: 'خافت',
    subtitle: 'درجة كحلي هادئة مريحة للعين في الإضاءة المتوسطة',
    icon: CloudMoon,
    swatchBg: 'bg-[#09152b]',
    swatchSurface: 'bg-[#12264a] border-[#267aff]/45',
    swatchAccent: 'bg-[#267aff]'
  },
  {
    id: 'light',
    label: 'فاتح',
    subtitle: 'مظهر نهاري زجاجي مشرق ومناسب للإضاءة القوية',
    icon: Sun,
    swatchBg: 'bg-[#eef4fc]',
    swatchSurface: 'bg-white border-[#123fce]/25',
    swatchAccent: 'bg-[#123fce]'
  }
];

export const AppearanceModal: React.FC = () => {
  const { isAppearanceModalOpen, setIsAppearanceModalOpen } = useApp();
  const { theme, setTheme } = useTheme();

  if (!isAppearanceModalOpen) return null;

  const activeThemeMeta = THEME_OPTIONS.find((item) => item.id === theme) || THEME_OPTIONS[0];

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="appearance-modal-title"
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75 backdrop-blur-md animate-fadeIn select-none"
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          setIsAppearanceModalOpen(false);
        }
      }}
    >
      <div className="w-full max-w-lg glass-strong border border-[var(--border-color)] rounded-3xl shadow-[var(--shadow)] overflow-hidden flex flex-col max-h-[90vh] animate-wordIn">
        {/* Header */}
        <div className="flex items-center justify-between gap-2 p-4 border-b border-[var(--border-color)] bg-[var(--surface-secondary)] shrink-0">
          <div className="flex items-center gap-3 min-w-0 flex-1">
            <div className="w-10 h-10 rounded-2xl bg-[var(--surface-primary)] border border-[var(--border-color)] flex items-center justify-center text-[var(--accent-secondary)] shrink-0">
              <Palette className="w-5 h-5 shrink-0" />
            </div>
            <div className="min-w-0">
              <h3
                id="appearance-modal-title"
                className="font-extrabold text-base text-[var(--text-primary)] m-0 leading-snug"
              >
                مظهر وسمة التطبيق
              </h3>
              <p className="text-[11px] font-semibold text-[var(--text-muted)] m-0 mt-0.5 leading-snug">
                اختر المظهر المناسب للعين · يُحفظ تلقائياً
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={() => setIsAppearanceModalOpen(false)}
            aria-label="إغلاق نافذة مظهر وسمة التطبيق"
            className="glass-btn min-w-[36px] min-h-[36px] w-9 h-9 rounded-xl text-[var(--text-secondary)] flex items-center justify-center hover:text-[var(--text-primary)] cursor-pointer shrink-0"
          >
            <X className="w-4 h-4 shrink-0" />
          </button>
        </div>

        {/* Body */}
        <div className="p-4 overflow-y-auto space-y-4 flex-1 text-xs sm:text-sm">
          {/* Primary Segmented Theme Switcher */}
          <div className="p-3.5 rounded-2xl bg-[var(--surface-primary)] border border-[var(--border-color)] flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="text-xs sm:text-sm font-extrabold text-[var(--text-primary)] m-0">
                تبديل السمة الفوري
              </p>
              <p className="text-[11px] text-[var(--text-muted)] m-0 mt-0.5">
                السمة النشطة حالياً: <strong className="text-[var(--accent-secondary)]">{activeThemeMeta.label}</strong>
              </p>
            </div>
            <ThemeSwitcher />
          </div>

          {/* Dedicated Visual Mode Cards */}
          <div className="space-y-2.5" role="radiogroup" aria-label="اختيار سمة التطبيق">
            {THEME_OPTIONS.map((option) => {
              const Icon = option.icon;
              const isSelected = theme === option.id;

              return (
                <button
                  key={option.id}
                  type="button"
                  role="radio"
                  aria-checked={isSelected}
                  onClick={() => setTheme(option.id)}
                  className={`w-full min-h-[56px] p-3.5 rounded-2xl border text-right flex items-center justify-between gap-3 transition-all cursor-pointer ${
                    isSelected
                      ? 'bg-[var(--surface-primary)] border-[var(--accent-secondary)] shadow-[0_0_16px_rgba(32,199,232,0.18)]'
                      : 'bg-[var(--surface-inset)] border-[var(--border-color)] hover:bg-[var(--surface-primary)]'
                  }`}
                >
                  <div className="flex items-center gap-3 min-w-0">
                    {/* Mini Theme Swatch Preview */}
                    <div
                      aria-hidden="true"
                      className={`w-11 h-11 rounded-xl p-1.5 flex flex-col justify-between border border-white/15 shrink-0 ${option.swatchBg}`}
                    >
                      <div className={`w-full h-3.5 rounded-md border ${option.swatchSurface}`} />
                      <div className={`w-5 h-1.5 rounded-full ${option.swatchAccent}`} />
                    </div>

                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <Icon className="w-4 h-4 text-[var(--accent-secondary)] shrink-0" />
                        <span className="font-extrabold text-xs sm:text-sm text-[var(--text-primary)]">
                          {option.label}
                        </span>
                      </div>
                      <p className="text-[11px] text-[var(--text-muted)] m-0 mt-0.5 leading-relaxed">
                        {option.subtitle}
                      </p>
                    </div>
                  </div>

                  <span
                    className={`w-6 h-6 rounded-full flex items-center justify-center shrink-0 border transition-colors ${
                      isSelected
                        ? 'bg-[#123FCE] border-[#123FCE] text-white'
                        : 'border-[var(--border-color)] bg-transparent text-transparent'
                    }`}
                  >
                    <Check className="w-3.5 h-3.5" />
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        {/* Footer */}
        <div className="p-3.5 border-t border-[var(--border-color)] flex justify-end bg-[var(--surface-secondary)]">
          <button
            type="button"
            onClick={() => setIsAppearanceModalOpen(false)}
            className="glass-btn--primary btn--lens px-5 py-2 rounded-xl text-xs font-extrabold text-white cursor-pointer min-h-[40px]"
          >
            تم
          </button>
        </div>
      </div>
    </div>
  );
};
