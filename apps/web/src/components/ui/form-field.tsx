import type { ComponentProps, ReactNode } from 'react';

type FormFieldProps = ComponentProps<'input'> & {
  id: string;
  label: string;
  hint?: ReactNode;
  className?: string;
  inputClassName?: string;
};
export function FormField({
  id,
  label,
  hint,
  className = '',
  inputClassName = '',
  'aria-describedby': describedBy,
  ...props
}: FormFieldProps) {
  const hintId = hint ? `${id}-hint` : undefined;
  return (
    <div className={className}>
      <div>
        <label htmlFor={id} className="mb-2.5 block text-[13px] font-medium">
          {label}
        </label>
        {hint && (
          <p id={hintId} className="mb-4 text-xs text-hint layout:mb-0">
            {hint}
          </p>
        )}
      </div>
      <input
        {...props}
        id={id}
        aria-describedby={[describedBy, hintId].filter(Boolean).join(' ') || undefined}
        className={`block w-full min-w-0 rounded-control border border-input-line bg-field px-3.5 py-3 text-sm text-ink placeholder:text-placeholder focus:border-accent disabled:opacity-60 ${inputClassName}`}
      />
    </div>
  );
}
