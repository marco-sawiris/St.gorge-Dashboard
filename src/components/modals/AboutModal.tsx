import React from 'react';
import { useApp } from '../../context/AppContext';
import { Church, Heart, X, Sparkles } from 'lucide-react';
const stGeorgeIcon = new URL('../../assets/images/st_george_icon_1794405195493.jpg', import.meta.url).href;

export const AboutModal: React.FC = () => {
  const { isAboutModalOpen, setIsAboutModalOpen } = useApp();

  if (!isAboutModalOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75 backdrop-blur-md animate-fadeIn select-none">
      <div className="w-full max-w-lg glass-strong border border-[var(--border-color)] rounded-3xl shadow-[var(--shadow)] overflow-hidden flex flex-col max-h-[90vh] animate-wordIn">
        {/* Header */}
        <div className="flex items-center justify-between gap-2 p-4 border-b border-[var(--border-color)] bg-[var(--surface-secondary)]/60 shrink-0">
          <div className="flex items-center gap-3 min-w-0 flex-1">
            <div className="w-11 h-11 rounded-2xl bg-gradient-to-br from-[#123fce]/30 to-[#20c7e8]/30 p-0.5 border border-[#20c7e8]/40 shadow-[0_0_15px_rgba(32,199,232,0.25)] shrink-0">
              <img
                src={stGeorgeIcon}
                alt="St.Gorge"
                className="w-full h-full object-cover rounded-xl"
              />
            </div>
            <div className="min-w-0">
              <h3 className="font-extrabold text-base text-[var(--text-primary)] m-0 leading-snug">
                St. George Dashboard
              </h3>
              <span className="inline-block mt-0.5 text-[11px] font-bold text-[var(--accent-secondary)] bg-[var(--accent-secondary)]/10 px-2 py-0.5 rounded-full border border-[var(--accent-secondary)]/30">
                الإصدار 2.0
              </span>
            </div>
          </div>

          <button
            type="button"
            onClick={() => setIsAboutModalOpen(false)}
            aria-label="إغلاق نافذة عن التطبيق"
            className="glass-btn min-w-[36px] min-h-[36px] w-9 h-9 rounded-xl text-[var(--text-secondary)] flex items-center justify-center hover:text-[var(--text-primary)] cursor-pointer shrink-0"
          >
            <X className="w-4 h-4 shrink-0" />
          </button>
        </div>

        {/* Body */}
        <div className="p-4 overflow-y-auto space-y-3.5 flex-1 text-xs sm:text-sm">
          {/* Church Info */}
          <div className="p-4 rounded-2xl bg-[var(--surface-primary)] border border-[var(--border-color)] flex items-center gap-3">
            <Church className="w-8 h-8 text-[var(--accent-secondary)] shrink-0" />
            <div className="min-w-0">
              <h4 className="font-extrabold text-sm text-[var(--text-primary)] m-0 leading-snug">
                فصل الشهيد العظيم مارجرجس
              </h4>
              <p className="text-xs text-[var(--text-secondary)] m-0 mt-0.5 font-semibold leading-snug">
                بكنيسة السيدة العذراء مريم بالزيتون
              </p>
            </div>
          </div>

          {/* Description */}
          <div className="p-4 rounded-2xl bg-[var(--surface-secondary)] border border-[var(--border-color)] text-center">
            <p className="text-xs leading-relaxed text-[var(--text-primary)] m-0 font-medium">
              تطبيق مخصص لتنظيم ومتابعة خدمة الفصل، وتسهيل إدارة بيانات المخدومين ومتابعة حضورهم
              وافتقادهم وتوليد كشوف المتابعة الذكية بتصميم حديث متطور.
            </p>
          </div>

          {/* Features */}
          <div className="p-4 rounded-2xl bg-[var(--surface-primary)] border border-[var(--border-color)]">
            <h5 className="font-extrabold text-xs text-[var(--accent-secondary)] flex items-center gap-1.5 mb-2.5">
              <Sparkles className="w-4 h-4 text-[var(--accent-secondary)] shrink-0" />
              <span>أهم مميزات التطبيق</span>
            </h5>
            <ul className="text-xs text-[var(--text-primary)] space-y-2.5 list-none p-0 m-0">
              <li className="flex items-start gap-2.5 leading-relaxed">
                <span className="w-2 h-2 mt-1.5 rounded-full bg-[#20c7e8] shadow-[0_0_6px_#20c7e8] shrink-0" />
                <span className="min-w-0">إدارة وحفظ بيانات المخدومين محلياً مع التزامن الآمن.</span>
              </li>
              <li className="flex items-start gap-2.5 leading-relaxed">
                <span className="w-2 h-2 mt-1.5 rounded-full bg-[#267aff] shadow-[0_0_6px_#267aff] shrink-0" />
                <span className="min-w-0">تسجيل الحضور والغياب وإحصائيات شهرية</span>
              </li>
              <li className="flex items-start gap-2.5 leading-relaxed">
                <span className="w-2 h-2 mt-1.5 rounded-full bg-[#8ecfff] shadow-[0_0_6px_#8ecfff] shrink-0" />
                <span className="min-w-0">العمل دون اتصال بالإنترنت مع طابور التزامن المحمي.</span>
              </li>
              <li className="flex items-start gap-2.5 leading-relaxed">
                <span className="w-2 h-2 mt-1.5 rounded-full bg-[#123fce] shadow-[0_0_6px_#123fce] shrink-0" />
                <span className="min-w-0">تبديل السمات ثلاثي الحالات: داكن، خافت، فاتح.</span>
              </li>
            </ul>
          </div>

          {/* Mission Quote */}
          <div className="p-4 rounded-2xl bg-gradient-to-l from-[#071b3b] via-[#0b2452] to-[#123fce] text-white text-center shadow-md border border-[#20c7e8]/30">
            <Heart className="w-6 h-6 text-[#20c7e8] mx-auto mb-1.5 fill-[#20c7e8]" />
            <h5 className="font-extrabold text-sm text-[#8ecfff] m-0 mb-1">رسالتنا في الخدمة</h5>
            <p className="text-xs text-white/95 leading-relaxed m-0 mb-2">
              "نخدم بمحبة، ونتابع بأمانة، ونسعى دائمًا لتطوير خدمتنا من أجل أولادنا."
            </p>
            <div className="pt-2 border-t border-white/15 text-xs font-bold text-[#8ecfff]">
              كل تعب المحبة من أجل أولادنا
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="p-3.5 border-t border-[var(--border-color)] flex justify-end bg-[var(--surface-secondary)]/60 shrink-0">
          <button
            type="button"
            onClick={() => setIsAboutModalOpen(false)}
            className="glass-btn--primary btn--lens min-h-[40px] px-5 py-2 rounded-xl text-xs font-extrabold cursor-pointer"
          >
            إغلاق
          </button>
        </div>
      </div>
    </div>
  );
};
