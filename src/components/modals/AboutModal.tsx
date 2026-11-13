import React from 'react';
import { useApp } from '../../context/AppContext';
import { useTheme } from '../../context/ThemeContext';
import { Church, Heart, X, Sparkles, CloudMoon } from 'lucide-react';
import { ThemeSwitcher } from '../glass/ThemeSwitcher';
const stGeorgeIcon = new URL('../../assets/images/st_george_icon_1794405195493.jpg', import.meta.url).href;

export const AboutModal: React.FC = () => {
  const { isAboutModalOpen, setIsAboutModalOpen } = useApp();
  const { theme, setTheme } = useTheme();

  if (!isAboutModalOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75 backdrop-blur-md animate-fadeIn select-none">
      <div className="w-full max-w-lg glass-strong border border-[var(--border-color)] rounded-3xl shadow-[var(--shadow)] overflow-hidden flex flex-col max-h-[90vh] animate-wordIn">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-[var(--border-color)] bg-white/[0.02]">
          <div className="flex items-center gap-3">
            <div className="w-11 h-11 rounded-2xl bg-gradient-to-br from-[#123fce]/30 to-[#20c7e8]/30 p-0.5 border border-[#20c7e8]/40 shadow-[0_0_15px_rgba(32,199,232,0.25)]">
              <img
                src={stGeorgeIcon}
                alt="St.Gorge"
                className="w-full h-full object-cover rounded-xl"
              />
            </div>
            <div>
              <h3 className="font-extrabold text-base text-[var(--text-primary)] m-0">
                St. George Dashboard
              </h3>
              <span className="text-[11px] font-bold text-[#20c7e8] bg-[#20c7e8]/10 px-2 py-0.5 rounded-full border border-[#20c7e8]/30">
                Liquid Glass v2.0 Enterprise
              </span>
            </div>
          </div>

          <button
            type="button"
            onClick={() => setIsAboutModalOpen(false)}
            aria-label="إغلاق نافذة عن التطبيق"
            className="glass-btn w-8 h-8 rounded-xl text-[var(--text-secondary)] flex items-center justify-center hover:text-[var(--text-primary)] cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="p-4 overflow-y-auto space-y-3.5 flex-1 text-xs sm:text-sm">
          {/* Church Info */}
          <div className="p-4 rounded-2xl bg-[var(--surface-primary)] border border-[var(--border-color)] flex items-center gap-3">
            <Church className="w-8 h-8 text-[#20c7e8] shrink-0" />
            <div>
              <h4 className="font-extrabold text-sm text-[var(--text-primary)] m-0">
                فصل الشهيد العظيم مارجرجس الروماني
              </h4>
              <p className="text-xs text-[var(--text-secondary)] m-0 mt-0.5 font-semibold">
                كنيسة السيدة العذراء مريم بالزيتون
              </p>
            </div>
          </div>

          {/* Description */}
          <div className="p-4 rounded-2xl bg-[var(--surface-secondary)] border border-[var(--border-color)] text-center">
            <p className="text-xs leading-relaxed text-[var(--text-primary)] m-0 font-medium">
              تطبيق مخصص لتنظيم ومتابعة خدمة الفصل، وتسهيل إدارة بيانات المخدومين ومتابعة حضورهم
              وافتقادهم وتوليد كشوف المتابعة الذكية بهوية بصرية Liquid Glass متطورة.
            </p>
          </div>

          {/* Features - ZERO GREEN */}
          <div className="p-4 rounded-2xl bg-[var(--surface-primary)] border border-[var(--border-color)]">
            <h5 className="font-extrabold text-xs text-[#20c7e8] flex items-center gap-1.5 mb-2.5">
              <Sparkles className="w-4 h-4 text-[#20c7e8]" />
              <span>أهم مميزات نظام Liquid Glass المحدث</span>
            </h5>
            <ul className="text-xs text-[var(--text-primary)] space-y-2 list-none p-0 m-0">
              <li className="flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-[#20c7e8] shadow-[0_0_6px_#20c7e8]" />
                <span>إدارة وحفظ بيانات المخدومين محلياً مع التزامن الآمن.</span>
              </li>
              <li className="flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-[#267aff] shadow-[0_0_6px_#267aff]" />
                <span>تسجيل الحضور والغياب مع المسار المزدوج وإحصائيات الشهر.</span>
              </li>
              <li className="flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-[#8ecfff] shadow-[0_0_6px_#8ecfff]" />
                <span>العمل دون اتصال بالإنترنت (Offline Mode) مع طابور التزامن المحمي.</span>
              </li>
              <li className="flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-[#123fce] shadow-[0_0_6px_#123fce]" />
                <span>تبديل السمات ثلاثي الحالات: داكن، خافت، فاتح.</span>
              </li>
            </ul>
          </div>

          {/* Theme Appearance Control (Moved out of Sidebar for compact clutter-free nav) */}
          <div className="p-3.5 rounded-2xl bg-[var(--surface-primary)] border border-[var(--border-color)] flex flex-wrap items-center justify-between gap-2.5">
            <span className="text-xs font-extrabold text-[var(--text-primary)]">مظهر التطبيق</span>
            <div className="flex items-center gap-2">
              <ThemeSwitcher />
              <button
                type="button"
                onClick={() => setTheme('dim')}
                aria-pressed={theme === 'dim'}
                className={`glass-btn px-3 py-1.5 rounded-full text-xs font-bold flex items-center gap-1 cursor-pointer ${
                  theme === 'dim' ? 'glass-btn--active' : ''
                }`}
              >
                <CloudMoon className="w-3.5 h-3.5 text-[#8ecfff]" />
                <span>خافت</span>
              </button>
            </div>
          </div>

          {/* Mission Quote */}
          <div className="p-4 rounded-2xl bg-gradient-to-l from-[#071b3b] via-[#0b2452] to-[#123fce] text-white text-center shadow-md border border-[#20c7e8]/30">
            <Heart className="w-6 h-6 text-[#20c7e8] mx-auto mb-1.5 fill-[#20c7e8]" />
            <h5 className="font-extrabold text-sm text-[#20c7e8] m-0 mb-1">رسالتنا في الخدمة</h5>
            <p className="text-xs text-[#f4f7fc]/90 leading-relaxed m-0 mb-2">
              "نخدم بمحبة، ونتابع بأمانة، ونسعى دائمًا لتطوير خدمتنا من أجل أولاد ربنا."
            </p>
            <div className="pt-2 border-t border-white/15 text-xs font-bold text-[#8ecfff]">
              كل تعب المحبة من أجل أولاد ربنا
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="p-3.5 border-t border-[var(--border-color)] flex justify-end bg-white/[0.02]">
          <button
            type="button"
            onClick={() => setIsAboutModalOpen(false)}
            className="glass-btn--primary btn--lens px-5 py-2 rounded-xl text-xs font-extrabold cursor-pointer"
          >
            إغلاق
          </button>
        </div>
      </div>
    </div>
  );
};
