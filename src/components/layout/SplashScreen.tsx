import React, { useEffect, useMemo, useState } from 'react';
import { Sparkles, CheckCircle2, ArrowLeft, RefreshCw } from 'lucide-react';
import { useApp } from '../../context/AppContext';

const stGeorgeIcon = new URL('../../assets/images/st_george_icon_1794405195493.jpg', import.meta.url).href;

/**
 * Blurry Loading Initial Screen inspired by CodePen LYBgdwr
 * - Background starts strongly blurred and sharpens progressively
 *   strictly based on real App initialization phases (IndexedDB read + Google Sheets sync)
 * - ZERO fabricated percentage timers
 * - Non-blocking safety timeout & immediate click/button bypass so user is never trapped
 */
export const SplashScreen: React.FC<{ onDismiss: () => void }> = ({ onDismiss }) => {
  const { isInitialLoading, isSyncing, students, lastSyncError, isOnline } = useApp();
  const [isVisible, setIsVisible] = useState(true);
  const [isExiting, setIsExiting] = useState(false);

  const phase = useMemo(() => {
    if (!isInitialLoading && !isSyncing) {
      return {
        stage: 'ready' as const,
        blurPx: 0,
        scale: 1,
        label:
          students.length > 0
            ? `تم تحميل ${students.length} مخدوم — لوحة الخدمة جاهزة`
            : lastSyncError
            ? 'تعذر الاتصال بالخادم — المتابعة للوحة الخدمة'
            : 'لوحة الخدمة جاهزة للاستخدام'
      };
    }
    if (isSyncing) {
      return {
        stage: 'syncing' as const,
        blurPx: 8,
        scale: 1.03,
        label:
          students.length > 0
            ? `عرض ${students.length} سجل محلي ومزامنة التحديثات...`
            : 'جاري مزامنة السجلات الحقيقية من Google Sheets...'
      };
    }
    return {
      stage: 'boot' as const,
      blurPx: 20,
      scale: 1.07,
      label: isOnline
        ? 'جاري تهيئة قاعدة البيانات المحلية (IndexedDB)...'
        : 'جاري فتح النسخة المحلية المحفوظة (وضع الأوفلاين)...'
    };
  }, [isInitialLoading, isSyncing, students.length, lastSyncError, isOnline]);

  const handleDismiss = () => {
    if (isExiting) return;
    setIsExiting(true);
    setTimeout(() => {
      setIsVisible(false);
      onDismiss();
    }, 360);
  };

  // Auto-dissolve shortly after real initialization finishes
  useEffect(() => {
    if (phase.stage === 'ready') {
      const doneTimer = setTimeout(handleDismiss, 550);
      return () => clearTimeout(doneTimer);
    }
  }, [phase.stage]);

  // Non-blocking fail-safe so slow/stalled mobile networks never trap the user on splash
  useEffect(() => {
    const safetyTimer = setTimeout(handleDismiss, 4200);
    return () => clearTimeout(safetyTimer);
  }, []);

  if (!isVisible) return null;

  return (
    <div
      role="dialog"
      aria-label="شاشة التحميل والتهيئة"
      onClick={handleDismiss}
      className={`fixed inset-0 z-50 bg-[#030711] flex flex-col items-center justify-center p-4 cursor-pointer select-none overflow-hidden transition-opacity duration-350 ${
        isExiting ? 'opacity-0 pointer-events-none' : 'opacity-100'
      }`}
    >
      {/* Blurry Atmospheric Optical Background Layer (Sharpens as real initialization completes) */}
      <div
        aria-hidden="true"
        className="blurry-splash-bg absolute inset-0 pointer-events-none flex items-center justify-center overflow-hidden"
        style={{
          filter: `blur(${phase.blurPx}px)`,
          transform: `scale(${phase.scale})`
        }}
      >
        <div className="absolute inset-0 bg-radial from-[#123FCE]/30 via-[#071B3B]/65 to-[#030711]" />
        <img
          src={stGeorgeIcon}
          alt=""
          className="w-[340px] sm:w-[460px] h-auto object-cover rounded-full opacity-18 mix-blend-screen"
        />
        <div className="absolute w-[520px] h-[520px] rounded-full bg-radial from-[#20C7E8]/20 via-[#123FCE]/10 to-transparent blur-3xl" />
      </div>

      {/* Main Optical Glass Focus Stage */}
      <div
        className="relative z-10 flex flex-col items-center text-center max-w-md w-full"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Crisp Crest Card */}
        <div
          className="blurry-splash-bg relative mb-6"
          style={{
            filter: `blur(${Math.max(0, phase.blurPx * 0.35)}px)`
          }}
        >
          <div className="relative w-44 sm:w-52 p-2 rounded-3xl glass-strong border border-[#20C7E8]/35 shadow-[0_0_55px_rgba(32,199,232,0.28)]">
            <img
              src={stGeorgeIcon}
              alt="الشهيد العظيم مارجرجس"
              className="w-full h-auto object-contain rounded-2xl drop-shadow-[0_14px_28px_rgba(0,0,0,0.85)]"
            />
          </div>
        </div>

        {/* Service Identity (wordIn per-word spring reveal matching Ainmation_code_8feeba97.html) */}
        <div className="space-y-1.5 mb-5">
          <h1 className="word-in-text text-2xl sm:text-3xl font-black text-[#F4F7FC] drop-shadow-md m-0 tracking-tight flex flex-wrap justify-center gap-x-1.5">
            {['فصل', 'الشهيد', 'العظيم', 'مارجرجس'].map((word, idx) => (
              <span key={word} style={{ '--w': idx } as React.CSSProperties}>
                {word}
              </span>
            ))}
          </h1>
          <p className="text-xs sm:text-sm font-bold text-[#8ECFFF] m-0 word-in" style={{ '--i': 4 } as React.CSSProperties}>
            بكنيسة السيدة العذراء مريم بالزيتون
          </p>
          <p className="text-[11px] text-[#A6B1C2] font-semibold m-0 flex items-center justify-center gap-1.5 pt-1 word-in" style={{ '--i': 5 } as React.CSSProperties}>
            <Sparkles className="w-3.5 h-3.5 text-[#20C7E8]" />
            <span>Liquid Glass Service Dashboard</span>
          </p>
        </div>

        {/* Real Initialization Status Capsule (Honest milestone indicator — NO fake 0-100% loop) */}
        <div className="w-full max-w-xs p-3.5 rounded-2xl glass border border-[#20C7E8]/30 space-y-2.5 shadow-[0_10px_28px_rgba(3,7,17,0.75)]">
          <div className="flex items-center justify-center gap-2 text-xs font-extrabold text-[#F4F7FC]">
            {phase.stage === 'ready' ? (
              <CheckCircle2 className="w-4 h-4 text-[#20C7E8] shrink-0" />
            ) : (
              <RefreshCw className="w-4 h-4 text-[#20C7E8] animate-spin shrink-0" />
            )}
            <span className="truncate">{phase.label}</span>
          </div>

          {/* Optical Loading Indicator (Honest indeterminate shimmer during load, full bar only on completion) */}
          <div
            className="relative w-full h-1.5 rounded-full bg-[#071B3B] overflow-hidden border border-[#267AFF]/25"
            aria-hidden="true"
          >
            {phase.stage === 'ready' ? (
              <div className="h-full w-full rounded-full transition-all duration-300 ease-out bg-gradient-to-r from-[#123FCE] via-[#267AFF] to-[#20C7E8]" />
            ) : (
              <div className="splash-shimmer h-full w-1/2 rounded-full bg-gradient-to-r from-transparent via-[#20C7E8] to-[#267AFF]" />
            )}
          </div>

          <button
            type="button"
            onClick={handleDismiss}
            className="glass-btn--primary w-full py-2 px-4 rounded-xl text-xs font-extrabold flex items-center justify-center gap-1.5 cursor-pointer"
          >
            <span>دخول الآن</span>
            <ArrowLeft className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      <div className="relative z-10 mt-6 text-[11px] text-[#A6B1C2]/70 tracking-wide">
        <span>اضغط في أي مكان للمتابعة</span>
      </div>
    </div>
  );
};
