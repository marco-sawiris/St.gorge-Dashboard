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
      'bg-gradient-to-r from-[var(--primary)] to-[var(--royal)] text-white border border-[var(--glass-border-2)] shadow-[0_0_18px_rgba(38,122,255,0.4)] hover:shadow-[0_0_24px_rgba(32,199,232,0.55)] hover:border-[var(--accent)]',
    lens:
      'btn--lens',
    secondary:
      'bg-[var(--glass-bg)] text-[var(--text)] border border-[var(--glass-border)] shadow-xs hover:border-[var(--glass-border-2)] hover:bg-[var(--glass-bg-2)]',
    ghost:
      'bg-transparent text-[var(--text-secondary)] hover:text-[var(--text)] hover:bg-white/5 border border-transparent hover:border-white/10',
    danger:
      'bg-gradient-to-r from-red-600/80 to-[var(--indigo)] text-white border border-red-500/30 shadow-[0_0_14px_rgba(225,29,72,0.3)] hover:border-red-400'
  }[variant];

  return (
    <button
      disabled={disabled || isLoading}
      className={`inline-flex items-center justify-center font-extrabold transition-all duration-250 cursor-pointer active:scale-95 disabled:opacity-50 disabled:pointer-events-none select-none ${sizeClasses} ${variantClasses} ${className}`}
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
