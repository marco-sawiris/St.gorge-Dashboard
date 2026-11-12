import React, { useId, useRef, useState } from 'react';

export interface LiquidToggleProps {
  checked: boolean;
  onChange: (nextChecked: boolean) => boolean | void | Promise<boolean | void>;
  label: string;
  disabled?: boolean;
  loading?: boolean;
  size?: 'sm' | 'md';
  onLabel?: string;
  offLabel?: string;
  className?: string;
}

/**
 * Compute horizontal ON fraction (0 = OFF, 1 = ON) from pointer clientX,
 * respecting RTL vs LTR layout direction cleanly.
 */
export function computeLiquidToggleFraction(
  clientX: number,
  rect: { left: number; width: number },
  isRtl: boolean
): number {
  const safeWidth = Math.max(rect.width, 1);
  const raw = (clientX - rect.left) / safeWidth;
  const clamped = Math.max(0, Math.min(1, raw));
  // In LTR: left = 0 (OFF), right = 1 (ON)
  // In RTL: right = 0 (OFF), left = 1 (ON)
  return isRtl ? 1 - clamped : clamped;
}

/**
 * Liquid Glass Gooey Toggle Switch inspired by CodePen bNVWoBW (@jh3y)
 * Features:
 * - Drag gesture + tap/click + keyboard (Space / Enter) accessibility
 * - Strict real-state commitment: displayed steady state ALWAYS follows `checked` prop
 *   (only previews temporarily during active pointer drag and clears immediately on release)
 * - Strictly Zero Green: St. George Electric Blue & Cyan palette
 */
export const LiquidToggle: React.FC<LiquidToggleProps> = ({
  checked,
  onChange,
  label,
  disabled = false,
  loading = false,
  size = 'md',
  onLabel,
  offLabel,
  className = ''
}) => {
  const filterId = useId().replace(/:/g, '_');
  const trackRef = useRef<HTMLButtonElement | null>(null);
  const dragStateRef = useRef<{
    pointerId: number;
    startX: number;
    moved: boolean;
    isRtl: boolean;
    fraction: number;
  } | null>(null);

  const [dragFraction, setDragFraction] = useState<number | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [isCommitting, setIsCommitting] = useState(false);
  const [isRtlLayout, setIsRtlLayout] = useState(true);

  const isUnavailable = disabled || loading || isCommitting;

  const commitToggle = async (targetNext: boolean) => {
    if (isUnavailable || targetNext === checked) return;
    setIsCommitting(true);
    try {
      await onChange(targetNext);
    } finally {
      setIsCommitting(false);
    }
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (isUnavailable) return;
    // Allow primary mouse button or touch/pen
    if (e.pointerType === 'mouse' && e.button !== 0) return;

    const el = trackRef.current;
    if (!el) return;

    const rect = el.getBoundingClientRect();
    const isRtl =
      typeof window !== 'undefined'
        ? window.getComputedStyle(el).direction !== 'ltr'
        : true;
    setIsRtlLayout(isRtl);

    const initialFrac = checked ? 1 : 0;
    dragStateRef.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      moved: false,
      isRtl,
      fraction: initialFrac
    };

    try {
      el.setPointerCapture(e.pointerId);
    } catch {}
    setIsDragging(true);
    setDragFraction(initialFrac);
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLButtonElement>) => {
    const state = dragStateRef.current;
    const el = trackRef.current;
    if (!state || !el || state.pointerId !== e.pointerId) return;

    const deltaX = Math.abs(e.clientX - state.startX);
    if (deltaX >= 5) {
      state.moved = true;
    }

    if (state.moved) {
      const rect = el.getBoundingClientRect();
      const frac = computeLiquidToggleFraction(e.clientX, rect, state.isRtl);
      state.fraction = frac;
      setDragFraction(frac);
    }
  };

  const handlePointerFinish = async (e: React.PointerEvent<HTMLButtonElement>, cancelled = false) => {
    const state = dragStateRef.current;
    const el = trackRef.current;
    if (!state || state.pointerId !== e.pointerId) return;

    dragStateRef.current = null;
    setIsDragging(false);
    setDragFraction(null);

    if (el) {
      try {
        if (el.hasPointerCapture?.(e.pointerId)) {
          el.releasePointerCapture(e.pointerId);
        }
      } catch {}
    }

    if (cancelled || isUnavailable) return;

    // Determine target boolean state strictly from tap vs drag threshold
    const targetNext = state.moved ? state.fraction >= 0.5 : !checked;
    if (targetNext !== checked) {
      await commitToggle(targetNext);
    }
  };

  const handleKeyDown = async (e: React.KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault();
      if (!isUnavailable) {
        await commitToggle(!checked);
      }
    }
  };

  // Visual progress follows active pointer drag OR committed boolean prop
  const visualFraction = dragFraction !== null ? dragFraction : checked ? 1 : 0;
  const isVisuallyOn = visualFraction >= 0.5;
  const translateSign = isRtlLayout ? -1 : 1;

  const isSmall = size === 'sm';
  const trackDims = isSmall ? 'w-12 h-6' : 'w-14 h-7';
  const thumbDims = isSmall ? 'w-4 h-4' : 'w-5 h-5';
  // Travel distance in pixels inside padding (12*4 - 4*4 - 8 = 24px | 14*4 - 5*4 - 8 = 28px)
  const maxTravelPx = isSmall ? 24 : 28;

  return (
    <div className={`inline-flex items-center gap-2 select-none ${className}`}>
      {/* Scoped gooey SVG filter for refractive droplet tail during motion */}
      <svg width="0" height="0" className="hidden" aria-hidden="true">
        <defs>
          <filter id={`goo_${filterId}`}>
            <feGaussianBlur in="SourceGraphic" stdDeviation="2.2" result="blur" />
            <feColorMatrix
              in="blur"
              mode="matrix"
              values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 18 -7"
              result="goo"
            />
            <feComposite in="SourceGraphic" in2="goo" operator="atop" />
          </filter>
        </defs>
      </svg>

      <button
        ref={trackRef}
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        aria-disabled={isUnavailable}
        disabled={disabled}
        onClick={(e) => {
          // Stop parent card click bubbling; actual toggle runs via pointer/keyboard handlers
          e.stopPropagation();
          // Fallback click trigger for synthetic testing environments without pointer events
          if (!dragStateRef.current && e.detail === 0 && !isUnavailable) {
            void commitToggle(!checked);
          }
        }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={(e) => void handlePointerFinish(e, false)}
        onPointerCancel={(e) => void handlePointerFinish(e, true)}
        onKeyDown={(e) => void handleKeyDown(e)}
        className={`liquid-toggle relative ${trackDims} rounded-full p-1 transition-all duration-300 ease-[var(--ease-spring)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#20C7E8] touch-none shrink-0 ${
          isUnavailable ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'
        } ${isVisuallyOn ? 'liquid-toggle--on' : 'liquid-toggle--off'}`}
      >
        {/* Inner Liquid Energy Ripple Track */}
        <span
          aria-hidden="true"
          className="absolute inset-0 rounded-full overflow-hidden pointer-events-none"
        >
          <span
            className="block w-full h-full transition-opacity duration-300"
            style={{
              opacity: visualFraction,
              background:
                'linear-gradient(135deg, rgba(38,122,255,0.92) 0%, rgba(32,199,232,0.88) 100%)'
            }}
          />
        </span>

        {/* Gooey Motion Bridge & Droplet Layer */}
        <span
          aria-hidden="true"
          className="relative block w-full h-full pointer-events-none"
          style={{ filter: isDragging ? `url(#goo_${filterId})` : undefined }}
        >
          {/* Trailing subtle liquid trail bubble */}
          <span
            className={`absolute top-0 ${thumbDims} rounded-full transition-transform ${
              isDragging ? 'duration-75 scale-x-125' : 'duration-300 ease-[var(--ease-spring)] scale-100'
            }`}
            style={{
              insetInlineStart: 0,
              transform: `translateX(${visualFraction * maxTravelPx * translateSign}px)`,
              background: isVisuallyOn
                ? 'rgba(32, 199, 232, 0.45)'
                : 'rgba(148, 163, 184, 0.2)'
            }}
          />

          {/* Main Refractive Glass Droplet Thumb */}
          <span
            className={`liquid-toggle-thumb relative block ${thumbDims} rounded-full transition-transform ${
              isDragging ? 'duration-75 scale-110' : 'duration-300 ease-[var(--ease-spring)]'
            }`}
            style={{
              transform: `translateX(${visualFraction * maxTravelPx * translateSign}px)`
            }}
          >
            {/* Top specular reflection dot */}
            <span className="absolute top-0.5 right-1 w-2 h-1 rounded-full bg-white/80 blur-[0.3px]" />
          </span>
        </span>
      </button>

      {(onLabel || offLabel) && (
        <span className="text-[11px] font-bold text-[var(--text-secondary)] whitespace-nowrap">
          {checked ? (onLabel || 'مفعل') : (offLabel || 'متوقف')}
        </span>
      )}
    </div>
  );
};
