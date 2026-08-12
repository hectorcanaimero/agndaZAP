'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * Barra de progreso lineal. Consumidor principal: el shell del onboarding
 * (goal-gradient explícito: "2 de 5 pasos - 40%").
 *
 * - Track `slate-100`, fill `brand-600`, transición `width` 300ms.
 * - `label` opcional a la derecha con el porcentaje calculado o texto libre.
 * - Accesibilidad: `role="progressbar"` con `aria-valuenow/min/max`. `aria-label`
 *   se auto-genera desde `value` si no viene explícito.
 * - Respeta `prefers-reduced-motion`: la transición se colapsa a 0ms.
 */
export interface ProgressBarProps {
  /** 0-100. Valores fuera del rango se clampan. */
  value: number;
  /** Etiqueta opcional. Si es `null`, no se muestra. Default: "XX%". */
  label?: string | null;
  className?: string;
  ariaLabel?: string;
}

export const ProgressBar = React.forwardRef<HTMLDivElement, ProgressBarProps>(
  ({ value, label, className, ariaLabel }, ref) => {
    const clamped = Math.min(100, Math.max(0, Math.round(value)));
    const derivedLabel = label === null ? null : (label ?? `${clamped}%`);

    return (
      <div ref={ref} className={cn('flex items-center gap-3', className)}>
        <div
          role="progressbar"
          aria-valuenow={clamped}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={ariaLabel ?? `Progreso: ${clamped}%`}
          className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-slate-100"
        >
          <div
            className="h-full rounded-full bg-brand-600 transition-[width] duration-300 motion-reduce:transition-none"
            style={{ width: `${clamped}%` }}
          />
        </div>
        {derivedLabel !== null ? (
          <span className="shrink-0 text-xs font-medium tabular-nums text-muted-foreground">
            {derivedLabel}
          </span>
        ) : null}
      </div>
    );
  },
);
ProgressBar.displayName = 'ProgressBar';
