import React from 'react';
import { Loader2 } from 'lucide-react';

interface GlassButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'lens' | 'secondary' | 'ghost' | 'danger';
  size?: 'sm' | 'md' | 'lg';
  isLoading?: boolean;
  icon?: React.ReactNode;
  children: React.ReactNode;
}

export const GlassButton: React.FC<GlassButtonProps> = ({
  variant = 'primary',
  size = 'md',
  isLoading = false,
  icon,
  children,
  className = '',
  disabled,
  ...props
}) => {
  const sizeClasses = {
    sm: 'px-3 py-1.5 text-xs rounded-xl gap-1.5',
    md: 'px-4 py-2 text-xs sm:text-sm rounded-xl gap-2',
    lg: 'px-5 py-2.5 text-sm sm:text-base rounded-2xl gap-2.5'
  }[size];

  const variantClasses = {
    primary:
      'bg-gradient-to-r from-[#123FCE] to-[#1D4ED8] text-white border border-[var(--glass-border-2)] shadow-[0_0_18px_rgba(18,63,206,0.4)] hover:shadow-[0_0_24px_rgba(56,189,248,0.55)] hover:border-[var(--accent)]',
    lens:
      'btn--lens',
    secondary:
      'bg-[var(--glass-bg)] text-[var(--text)] border border-[var(--glass-border)] shadow-xs hover:border-[var(--glass-border-2)] hover:bg-[var(--glass-bg-2)]',
    ghost:
      'bg-transparent text-[var(--text-secondary)] hover:text-[var(--text)] hover:bg-[var(--surface-hover)] border border-transparent hover:border-[var(--border-color)]',
    danger:
      'bg-gradient-to-r from-[#BE123C] to-[#9F1239] text-white border border-rose-400/50 shadow-[0_0_14px_rgba(190,18,60,0.3)] hover:border-rose-300'
  }[variant];

  return (
    <button
      disabled={disabled || isLoading}
      className={`inline-flex items-center justify-center font-extrabold transition-all duration-250 cursor-pointer active:scale-95 disabled:opacity-65 disabled:pointer-events-none select-none ${sizeClasses} ${variantClasses} ${className}`}
      {...props}
    >
      {isLoading ? (
        <Loader2 className="w-4 h-4 animate-spin text-current" />
      ) : icon ? (
        <span className="shrink-0">{icon}</span>
      ) : null}
      <span>{children}</span>
    </button>
  );
};
