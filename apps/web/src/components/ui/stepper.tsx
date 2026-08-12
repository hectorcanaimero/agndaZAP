'use client';

import * as React from 'react';
import { Check } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Stepper visual para wizards multi-step. Consumidor principal: el shell del
 * onboarding en `/[locale]/onboarding/*`.
 *
 * Diseño:
 * - Mobile: dots horizontales con snap. Label del step actual visible; los
 *   demás labels colapsan a screen-reader only para no saturar el viewport.
 * - Desktop: labels visibles + línea de progreso animada 300ms entre dots.
 * - Colors del design system: pending `slate-300`, current `brand-600` filled
 *   con ring, done `brand-600` con check icon. Contrast ≥ 4.5:1.
 * - Accesibilidad: `role="progressbar"` en el contenedor con `aria-valuenow`
 *   apuntando al step actual. Cada dot es `<button>` si `onStepClick` está
 *   provisto — permite navegar hacia atrás por teclado (Tab + Enter).
 */
export interface StepperStep {
  id: number;
  label: string;
  done: boolean;
  current: boolean;
}

export interface StepperProps {
  steps: StepperStep[];
  /** Solo se dispara para steps `done` — no permite avanzar por dot. */
  onStepClick?: (id: number) => void;
  className?: string;
}

export const Stepper = React.forwardRef<HTMLDivElement, StepperProps>(
  ({ steps, onStepClick, className }, ref) => {
    const currentId = steps.find((s) => s.current)?.id ?? steps[0]?.id ?? 1;
    const totalSteps = steps.length;

    return (
      <div
        ref={ref}
        role="progressbar"
        aria-valuenow={currentId}
        aria-valuemin={1}
        aria-valuemax={totalSteps}
        aria-label={`Paso ${currentId} de ${totalSteps}`}
        className={cn('w-full', className)}
      >
        <ol className="flex items-center gap-1 md:gap-2">
          {steps.map((step, idx) => {
            const isLast = idx === steps.length - 1;
            const canClick = step.done && !!onStepClick;
            const Dot = canClick ? 'button' : 'div';

            return (
              <React.Fragment key={step.id}>
                <li className="flex min-w-0 items-center gap-2">
                  <Dot
                    type={canClick ? 'button' : undefined}
                    onClick={canClick ? () => onStepClick!(step.id) : undefined}
                    aria-current={step.current ? 'step' : undefined}
                    aria-label={
                      canClick ? `Volver al paso ${step.id}: ${step.label}` : undefined
                    }
                    disabled={canClick ? undefined : undefined}
                    className={cn(
                      'relative flex h-9 w-9 shrink-0 items-center justify-center rounded-full border text-xs font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
                      step.done && !step.current
                        ? 'border-brand-600 bg-brand-600 text-white'
                        : step.current
                          ? 'border-brand-600 bg-white text-brand-700 ring-2 ring-brand-200'
                          : 'border-slate-300 bg-white text-slate-500',
                      canClick && 'cursor-pointer hover:bg-brand-50',
                    )}
                  >
                    {step.done && !step.current ? (
                      <Check className="h-4 w-4" aria-hidden="true" />
                    ) : (
                      step.id
                    )}
                  </Dot>
                  <span
                    className={cn(
                      'min-w-0 truncate text-sm',
                      step.current
                        ? 'font-medium text-foreground md:inline'
                        : 'hidden text-muted-foreground md:inline',
                    )}
                  >
                    {step.label}
                  </span>
                </li>
                {!isLast ? (
                  <li aria-hidden="true" className="min-w-4 flex-1">
                    <div
                      className={cn(
                        'h-0.5 w-full rounded-full transition-colors duration-300',
                        step.done ? 'bg-brand-600' : 'bg-slate-200',
                      )}
                    />
                  </li>
                ) : null}
              </React.Fragment>
            );
          })}
        </ol>
      </div>
    );
  },
);
Stepper.displayName = 'Stepper';
