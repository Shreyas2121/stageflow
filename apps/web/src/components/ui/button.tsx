import type { ComponentProps } from 'react';

const variants = {
  primary: 'border-transparent bg-accent text-accent-ink enabled:hover:bg-accent-hover',
  secondary:
    'border-input-line bg-control text-ink enabled:hover:border-hover-line enabled:hover:bg-control-hover',
};
type ButtonProps = ComponentProps<'button'> & {
  type: 'button' | 'submit' | 'reset';
  variant?: keyof typeof variants;
};
export function Button({ type, variant = 'secondary', className = '', ...props }: ButtonProps) {
  return (
    <button
      {...props}
      type={type}
      className={`inline-flex min-h-11 items-center justify-center gap-2.5 rounded-control border px-3 py-2.5 text-xs font-semibold transition-colors motion-reduce:transition-none disabled:cursor-not-allowed disabled:opacity-60 ${variants[variant]} ${className}`}
    />
  );
}
