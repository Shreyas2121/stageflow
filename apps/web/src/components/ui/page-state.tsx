import type { ReactNode } from 'react';

export function PageState({
  title,
  eyebrow,
  children,
}: {
  title: string;
  eyebrow?: string;
  children?: ReactNode;
}) {
  return (
    <section className="py-16 layout:py-18">
      {eyebrow && (
        <p className="mb-4 text-[11px] font-semibold tracking-[0.11em] text-eyebrow uppercase">
          {eyebrow}
        </p>
      )}
      <h1 className="mb-4 text-[clamp(30px,4vw,40px)] leading-tight font-medium tracking-[-0.03em] wrap-anywhere">
        {title}
      </h1>
      {children}
    </section>
  );
}
