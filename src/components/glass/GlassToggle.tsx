import React from 'react';

interface GlassToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label?: string;
  disabled?: boolean;
}

export const GlassToggle: React.FC<GlassToggleProps> = ({
  checked,
  onChange,
  label,
  disabled = false
}) => {
  return (
    <label className={`inline-flex items-center gap-2.5 select-none cursor-pointer ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`}>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => !disabled && onChange(!checked)}
        className={`relative w-12 h-6.5 rounded-full p-0.5 transition-all duration-300 backdrop-blur-md cursor-pointer border ${
          checked
            ? 'bg-gradient-to-r from-[var(--primary)]/80 to-[var(--accent)]/90 border-[var(--accent)] shadow-[0_0_14px_rgba(32,199,232,0.5)]'
            : 'bg-[var(--navy)]/80 border-[var(--glass-border)] shadow-inner'
        }`}
      >
        {/* Glossy Liquid Thumb */}
        <span
          className={`block w-5 h-5 rounded-full bg-white shadow-md transform transition-transform duration-300 ease-[cubic-bezier(0.34,1.56,0.64,1)] ${
            checked ? '-translate-x-5.5 bg-gradient-to-br from-white to-[var(--accent)]' : 'translate-x-0 bg-white/90'
          }`}
          style={{
            boxShadow: checked
              ? 'inset 0 1px 1px rgba(255,255,255,0.8), 0 2px 6px rgba(3,7,17,0.6)'
              : 'inset 0 1px 1px rgba(255,255,255,0.9), 0 1px 4px rgba(0,0,0,0.4)'
          }}
        />
      </button>
      {label && <span className="text-xs font-bold text-[var(--text)]">{label}</span>}
    </label>
  );
};
