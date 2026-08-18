import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

// SectionEyebrow — reemplazo del patrón "pill verde clarito con dot" que
// gritaba AI-generated en Hero, Pricing y Testimonial. Solo texto uppercase
// tracking-wide + acento brand.teal (o versión luminosa sobre fondo oscuro).
// Sin dot circular, sin pill de fondo, sin borde. Anti-slop pass del batch 2.
type Variant = 'light' | 'dark';

interface SectionEyebrowProps {
  children: ReactNode;
  variant?: Variant;
  className?: string;
}

// Barra vertical fina como ancla visual sutil, sin caer en el dot verde.
// Se puede ocultar en mobile si molesta; hoy se mantiene siempre visible.
const RULE_CLASSES: Record<Variant, string> = {
  light: 'text-brand-teal',
  dark: 'text-brand-teal',
};

export function SectionEyebrow({
  children,
  variant = 'light',
  className,
}: SectionEyebrowProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.2em]',
        RULE_CLASSES[variant],
        className,
      )}
    >
      <span aria-hidden="true" className="inline-block h-px w-6 bg-current opacity-70" />
      {children}
    </span>
  );
}
