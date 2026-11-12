import React from 'react';

interface GlassCardProps extends React.HTMLAttributes<HTMLDivElement> {
  children: React.ReactNode;
  variant?: 'normal' | 'strong' | 'interactive';
  className?: string;
}

export const GlassCard: React.FC<GlassCardProps> = ({
  children,
  variant = 'normal',
  className = '',
  ...props
}) => {
  const variantClass = {
    normal: 'glass',
    strong: 'glass-strong',
    interactive: 'glass glass-hover cursor-pointer'
  }[variant];

  return (
    <div
      className={`${variantClass} p-4 transition-all duration-300 relative overflow-hidden ${className}`}
      {...props}
    >
      {children}
    </div>
  );
};
