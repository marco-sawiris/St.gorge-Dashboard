import React, { useEffect, useState } from 'react';
import { ShieldCheck, Sparkles } from 'lucide-react';

export const SplashScreen: React.FC<{ onDismiss: () => void }> = ({ onDismiss }) => {
  const [isVisible, setIsVisible] = useState(true);

  useEffect(() => {
    // Auto-dismiss splash screen after 3 seconds, or click immediately
    const timer = setTimeout(() => {
      handleDismiss();
    }, 3200);

    return () => clearTimeout(timer);
  }, []);

  const handleDismiss = () => {
    setIsVisible(false);
    setTimeout(onDismiss, 350);
  };

  if (!isVisible) return null;

  return (
    <div
      onClick={handleDismiss}
      className="fixed inset-0 z-50 bg-[#030711] flex flex-col items-center justify-center p-4 cursor-pointer select-none overflow-hidden transition-opacity duration-300"
    >
      {/* Ambient Blue & Cyan Backlight Orbs */}
      <div className="absolute w-[500px] h-[500px] rounded-full bg-radial from-[#20c7e8]/15 via-[#123fce]/10 to-transparent blur-3xl pointer-events-none" />
      <div className="absolute -bottom-20 w-[600px] h-[300px] rounded-full bg-radial from-[#267aff]/20 via-transparent to-transparent blur-3xl pointer-events-none" />

      {/* Decorative Rings */}
      <div className="absolute w-80 h-80 rounded-full border border-[#20c7e8]/15 animate-ping opacity-25 pointer-events-none" />
      <div className="absolute w-[440px] h-[440px] rounded-full border border-white/5 pointer-events-none" />

      {/* Main Saint Icon in Glowing Glass Container */}
      <div className="relative mb-6 animate-wordIn">
        <div className="relative w-48 sm:w-56 p-2 rounded-3xl glass-strong border border-white/15 shadow-[0_0_50px_rgba(32,199,232,0.25)]">
          <img
            src="https://raw.githubusercontent.com/marco-sawiris/St.gorge-Dashboard/main/Aset/Icon.png"
            alt="الشهيد مارجرجس"
            className="w-full h-auto object-contain drop-shadow-[0_15px_30px_rgba(0,0,0,0.8)]"
          />
        </div>
      </div>

      {/* Text Info */}
      <div className="text-center space-y-2 animate-wordIn" style={{ animationDelay: '150ms' }}>
        <h1 className="text-2xl sm:text-3xl font-black text-[#f4f7fc] drop-shadow-md m-0 tracking-tight">
          فصل الشهيد العظيم مارجرجس
        </h1>
        <p className="text-xs sm:text-sm font-bold text-[#8ecfff] m-0">
          بكنيسة السيدة العذراء مريم بالزيتون
        </p>
        <p className="text-xs text-[#a6b1c2] font-semibold m-0">
          لوحة الخدمة والمتابعة التفاعلية — Liquid Glass UI
        </p>

        <div className="pt-3">
          <span className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-full text-xs font-black bg-[#20c7e8]/15 text-[#20c7e8] border border-[#20c7e8]/30 shadow-[0_0_15px_rgba(32,199,232,0.25)]">
            <Sparkles className="w-3.5 h-3.5 text-[#20c7e8]" />
            <span>Liquid Glass v2.0 Enterprise</span>
          </span>
        </div>
      </div>

      <div className="absolute bottom-8 text-[11px] text-[#a6b1c2]/60 tracking-wider flex items-center gap-1.5">
        <span>اضغط في أي مكان للدخول</span>
      </div>
    </div>
  );
};
