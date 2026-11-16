import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Capacitor, SystemBars, SystemBarType } from '@capacitor/core';
import { CheckCircle2, ArrowLeft, RefreshCw } from 'lucide-react';
import { useApp } from '../../context/AppContext';

const copticDomePortrait = new URL('../../assets/images/coptic_dome_dark_navy_port_1794829405532.jpg', import.meta.url).href;
const copticDomeLandscape = new URL('../../assets/images/coptic_dome_dark_navy_land_1794829406178.jpg', import.meta.url).href;
const stGeorgeSplashArtwork = new URL('../../../Aset/Stgorge.png', import.meta.url).href;

/**
 * Minimalist Coptic Cross Emblem (#D6AE68 muted gold accent)
 */
const CopticCrossEmblem: React.FC<{ className?: string }> = ({ className = 'w-6 h-6' }) => (
  <svg
    viewBox="0 0 36 36"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    className={className}
    aria-hidden="true"
  >
    <path
      d="M18 3.5V32.5M3.5 18H32.5"
      stroke="#D6AE68"
      strokeWidth="1.65"
      strokeLinecap="round"
    />
    <path
      d="M15.2 5.2L18 2.5L20.8 5.2M15.2 30.8L18 33.5L20.8 30.8M5.2 15.2L2.5 18L5.2 20.8M30.8 15.2L33.5 18L30.8 20.8"
      stroke="#D6AE68"
      strokeWidth="1.35"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <path
      d="M18 13.5L22.5 18L18 22.5L13.5 18L18 13.5Z"
      fill="#071A38"
      stroke="#D6AE68"
      strokeWidth="1.35"
    />
    <circle cx="18" cy="18" r="1.4" fill="#D6AE68" />
  </svg>
);

/**
 * Fallback Vector Silhouette for the Coptic Church Dome & Cross
 * Ensures Zero-Broken-Image visual completeness if backdrop assets fail to load.
 */
const CopticDomeFallbackBackdrop: React.FC = () => (
  <svg
    viewBox="0 0 400 560"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    className="w-[340px] sm:w-[460px] h-auto opacity-35"
    aria-hidden="true"
  >
    <defs>
      <linearGradient id="domeNavyGrad" x1="200" y1="80" x2="200" y2="540" gradientUnits="userSpaceOnUse">
        <stop offset="0%" stopColor="#123F78" stopOpacity="0.48" />
        <stop offset="55%" stopColor="#0B2854" stopOpacity="0.65" />
        <stop offset="100%" stopColor="#071A38" stopOpacity="0.95" />
      </linearGradient>
    </defs>
    <path d="M200 72V128M178 96H222" stroke="#123F78" strokeWidth="3.5" strokeLinecap="round" />
    <circle cx="200" cy="96" r="6" stroke="#123F78" strokeWidth="2" />
    <path
      d="M92 312C92 212 138 148 200 132C262 148 308 212 308 312H92Z"
      fill="url(#domeNavyGrad)"
      stroke="#123F78"
      strokeOpacity="0.35"
      strokeWidth="1.5"
    />
    <rect x="78" y="312" width="244" height="220" rx="4" fill="#071A38" fillOpacity="0.72" />
    <path d="M138 386C138 364 152 350 164 350C176 350 190 364 190 386V448H138V386Z" fill="#05132B" />
    <path d="M210 386C210 364 224 350 236 350C248 350 262 364 262 386V448H210V386Z" fill="#05132B" />
  </svg>
);

/**
 * Premium Dark Navy Coptic Glassmorphism Splash Screen
 * - Deep Dark Navy foundations (#071A38, #0B2854, #123F78) regardless of active dashboard theme
 * - Soft, dimmed, gently blurred Coptic Dome & Cross architectural background
 * - Dark Frosted Glassmorphic panel with directional edge highlights & subtle blue reflection
 * - Crisp Stgorge.png crest artwork & minimal #D6AE68 gold Coptic accents
 * - Non-blocking real-phase initialization indicator & Android multi-screen responsive layout
 */
export const SplashScreen: React.FC<{ onDismiss: () => void }> = ({ onDismiss }) => {
  const { isInitialLoading, isSyncing, students, lastSyncError, isOnline } = useApp();
  const [isVisible, setIsVisible] = useState(true);
  const [isExiting, setIsExiting] = useState(false);
  const [portImgFailed, setPortImgFailed] = useState(false);
  const [landImgFailed, setLandImgFailed] = useState(false);

  const phase = useMemo(() => {
    if (!isInitialLoading && !isSyncing) {
      return {
        stage: 'ready' as const,
        blurPx: 3,
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
        blurPx: 7,
        scale: 1.025,
        label:
          students.length > 0
            ? `عرض ${students.length} سجل محلي ومزامنة التحديثات...`
            : 'جاري مزامنة السجلات الحقيقية من Google Sheets...'
      };
    }
    return {
      stage: 'boot' as const,
      blurPx: 14,
      scale: 1.05,
      label: isOnline
        ? 'جاري تهيئة قاعدة البيانات المحلية (IndexedDB)...'
        : 'جاري فتح النسخة المحلية المحفوظة (وضع الأوفلاين)...'
    };
  }, [isInitialLoading, isSyncing, students.length, lastSyncError, isOnline]);

  const dismissTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const navBarRestoredRef = useRef(false);

  const restoreSystemNavigationBar = useCallback(() => {
    if (navBarRestoredRef.current) return;
    navBarRestoredRef.current = true;
    if (typeof window !== 'undefined' && Capacitor.isNativePlatform()) {
      void SystemBars.show({ bar: SystemBarType.NavigationBar }).catch(() => {});
    }
  }, []);

  // Hide only the Android system navigation bar while SplashScreen is active,
  // then immediately restore it when transitioning into the main app.
  useEffect(() => {
    if (typeof window === 'undefined' || !Capacitor.isNativePlatform()) return;
    navBarRestoredRef.current = false;
    void SystemBars.hide({ bar: SystemBarType.NavigationBar }).catch(() => {});

    return () => {
      restoreSystemNavigationBar();
    };
  }, [restoreSystemNavigationBar]);

  const handleDismiss = () => {
    if (isExiting) return;
    setIsExiting(true);
    restoreSystemNavigationBar();
    if (dismissTimerRef.current) clearTimeout(dismissTimerRef.current);
    dismissTimerRef.current = setTimeout(() => {
      setIsVisible(false);
      onDismiss();
    }, 360);
  };

  useEffect(() => {
    return () => {
      if (dismissTimerRef.current) {
        clearTimeout(dismissTimerRef.current);
        dismissTimerRef.current = null;
      }
    };
  }, []);

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
      className={`splash-dark-canvas fixed inset-0 h-[100dvh] w-full z-50 text-white flex flex-col items-center justify-center px-5 py-5 pt-[max(1.25rem,env(safe-area-inset-top))] pb-[max(1.25rem,env(safe-area-inset-bottom))] cursor-pointer select-none overflow-hidden transition-opacity duration-350 ${
        isExiting ? 'opacity-0 pointer-events-none' : 'opacity-100'
      }`}
    >
      {/* Subtle Restrained Navy Atmospheric Depth (Zero bright white or sky-blue flood) */}
      <div
        aria-hidden="true"
        className="absolute inset-0 pointer-events-none"
        style={{
          background:
            'radial-gradient(ellipse 68% 48% at 50% 42%, rgba(18, 63, 120, 0.28) 0%, rgba(11, 40, 84, 0.16) 50%, rgba(7, 26, 56, 0.94) 100%)'
        }}
      />

      {/* Coptic Church Dome & Cross Atmospheric Background (Soft, darkened, low-opacity, never competing with foreground) */}
      <div
        aria-hidden="true"
        className="blurry-splash-bg absolute inset-0 pointer-events-none flex items-center justify-center overflow-hidden"
        style={{
          filter: `blur(${phase.blurPx}px)`,
          transform: `scale(${phase.scale})`
        }}
      >
        <div className="absolute inset-0 flex items-center justify-center">
          <CopticDomeFallbackBackdrop />
        </div>

        {!portImgFailed && (
          <img
            src={copticDomePortrait}
            alt=""
            referrerPolicy="no-referrer"
            onError={() => setPortImgFailed(true)}
            className="md:hidden w-full h-full object-cover object-center opacity-[0.38] brightness-[0.82] contrast-[1.06]"
          />
        )}

        {!landImgFailed && (
          <img
            src={copticDomeLandscape}
            alt=""
            referrerPolicy="no-referrer"
            onError={() => setLandImgFailed(true)}
            className="hidden md:block w-full h-full object-cover object-center opacity-[0.36] brightness-[0.82] contrast-[1.06]"
          />
        )}

        {/* Measured Navy Scrim keeping dome quiet behind glassmorphism */}
        <div
          className="absolute inset-0"
          style={{
            background:
              'linear-gradient(180deg, rgba(7, 26, 56, 0.62) 0%, rgba(7, 26, 56, 0.28) 46%, rgba(7, 26, 56, 0.86) 100%)'
          }}
        />
      </div>

      {/* Vertical Composition with Generous Negative Space */}
      <div
        className="relative z-10 flex flex-col items-center text-center w-full max-w-[350px] sm:max-w-[400px]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 100% Crisp Crest Card (Dark Translucent Frosted Glass Panel behind St. George Artwork — Razor sharp from frame 1) */}
        <div
          dir="ltr"
          className="splash-dark-glass w-full rounded-[26px] px-6 py-6 sm:px-8 sm:py-7 flex flex-col items-center justify-center"
        >
          {/* Minimalist Gold Coptic Cross & Flanking Hairlines */}
          <div className="relative z-10 flex items-center justify-center gap-3 mb-3">
            <span className="w-8 sm:w-10 h-px bg-gradient-to-r from-transparent to-[#D6AE68]/65" aria-hidden="true" />
            <CopticCrossEmblem className="w-5 h-5 sm:w-6 sm:h-6 shrink-0" />
            <span className="w-8 sm:w-10 h-px bg-gradient-to-l from-transparent to-[#D6AE68]/65" aria-hidden="true" />
          </div>

          {/* Primary St. George Hero Crest Artwork (Original PNG preserved with natural aspect ratio, zero blur/frame) */}
          <div className="relative z-10 flex items-center justify-center w-full my-1">
            <div
              aria-hidden="true"
              className="absolute inset-0 pointer-events-none"
              style={{
                background:
                  'radial-gradient(circle at 50% 50%, rgba(147, 207, 255, 0.16) 0%, rgba(18, 63, 120, 0.08) 46%, transparent 72%)'
              }}
            />
            <img
              src={stGeorgeSplashArtwork}
              alt="الشهيد العظيم مارجرجس الروماني"
              width={1239}
              height={1270}
              className="relative z-10 w-[184px] sm:w-[224px] max-w-full max-h-[30vh] h-auto aspect-[1239/1270] object-contain select-none pointer-events-none drop-shadow-[0_14px_28px_rgba(3,10,26,0.65)]"
            />
          </div>

          {/* Subtle Minimal Gold Accent Line */}
          <div
            aria-hidden="true"
            className="relative z-10 w-14 h-px mt-3.5 bg-gradient-to-r from-transparent via-[#D6AE68]/65 to-transparent"
          />

          {/* Quiet Service Context Line */}
          <p
            dir="rtl"
            className="relative z-10 m-0 mt-3 text-[11.5px] sm:text-xs font-semibold text-[#C6D6F0]/85 tracking-normal leading-relaxed"
          >
            فصل الشهيد العظيم مارجرجس · الزيتون
          </p>
        </div>

        {/* Real Initialization Status Capsule (Honest milestone indicator — NO fake 0-100% loop) */}
        <div className="splash-status-glass w-full max-w-[300px] sm:max-w-[320px] mt-7 sm:mt-8 p-3.5 rounded-2xl space-y-2.5">
          <div className="flex items-center justify-center gap-2 text-[11.5px] font-bold text-[#E6EEF9]/90">
            {phase.stage === 'ready' ? (
              <CheckCircle2 className="w-3.5 h-3.5 text-[#D6AE68] shrink-0" />
            ) : (
              <RefreshCw className="w-3.5 h-3.5 text-[#D6AE68]/85 animate-spin shrink-0" />
            )}
            <span className="truncate">{phase.label}</span>
          </div>

          {/* Optical Loading Indicator (Honest indeterminate shimmer during load, full bar only on completion) */}
          <div
            className="relative w-full h-1 rounded-full bg-[#0B2854]/90 overflow-hidden border border-[#9AC3FF]/10"
            aria-hidden="true"
          >
            {phase.stage === 'ready' ? (
              <div className="h-full w-full rounded-full transition-all duration-300 ease-out bg-gradient-to-r from-[#123F78] via-[#2A5FA8] to-[#D6AE68]/85" />
            ) : (
              <div className="splash-shimmer h-full w-1/2 rounded-full bg-gradient-to-r from-transparent via-[#123F78] to-[#D6AE68]/75" />
            )}
          </div>

          <button
            type="button"
            onClick={handleDismiss}
            className="splash-entry-btn w-full min-h-[40px] py-2 px-4 rounded-xl text-xs font-bold flex items-center justify-center gap-1.5 cursor-pointer"
          >
            <span>دخول الآن</span>
            <ArrowLeft className="w-3.5 h-3.5 text-[#D6AE68]" />
          </button>
        </div>
      </div>

      <div className="relative z-10 mt-5 text-[11px] text-[#9EB4D8]/60 tracking-wide">
        <span>اضغط في أي مكان للمتابعة</span>
      </div>
    </div>
  );
};
