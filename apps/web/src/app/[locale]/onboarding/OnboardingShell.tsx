'use client';

import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { ReactNode } from 'react';
import { Sparkles, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ProgressBar } from '@/components/ui/progress-bar';
import { Stepper, type StepperStep } from '@/components/ui/stepper';
import { cn } from '@/lib/utils';
import { TOTAL_STEPS, useOnboarding } from './OnboardingContext';

interface Props {
  locale: string;
  children: ReactNode;
}

/**
 * Shell client del wizard. Wrapea todo step-content con:
 * - Header sticky: brand + progress bar + "Guardar y salir" (redirect a
 *   /panel/dashboard sin marcar completed — el widget Zeigarnik del
 *   dashboard va a pull al user de vuelta).
 * - Stepper visible en mobile+desktop.
 * - Main scrollable — el step-content maneja su propio spacing y form.
 *
 * El footer con [Volver / Continuar] vive dentro de cada step para que el
 * submit sea del step-owner (los botones dependen de la validación local).
 */
export function OnboardingShell({ locale, children }: Props) {
  const t = useTranslations('onboarding.shell');
  const router = useRouter();
  const { currentStep, progressPercent } = useOnboarding();

  const steps: StepperStep[] = Array.from({ length: TOTAL_STEPS }, (_, i) => {
    const id = i + 1;
    return {
      id,
      label: t(`stepLabels.${id}` as never),
      done: id < currentStep,
      current: id === currentStep,
    };
  });

  const handleStepClick = (id: number) => {
    if (id < currentStep) {
      router.push(`/${locale}/onboarding/${id}`);
    }
  };

  return (
    <div className="flex min-h-dvh flex-col bg-muted/30">
      {/* Header sticky */}
      <header className="sticky top-0 z-30 border-b border-border bg-card/95 backdrop-blur">
        <div className="mx-auto flex w-full max-w-5xl items-center gap-3 px-4 py-3 md:px-6">
          <Link
            href={`/${locale}`}
            aria-label="Showly"
            className="flex shrink-0 items-center gap-2"
          >
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand-600 text-white shadow-sm">
              <Sparkles className="h-4 w-4" strokeWidth={2.25} />
            </div>
            <span className="hidden text-base font-semibold tracking-tight md:inline">
              Showly
            </span>
          </Link>

          <div className="hidden min-w-0 flex-1 md:block">
            <ProgressBar
              value={progressPercent}
              label={t('progress', {
                current: currentStep,
                total: TOTAL_STEPS,
                percent: progressPercent,
              })}
            />
          </div>

          <Button
            variant="ghost"
            size="sm"
            onClick={() => router.push(`/${locale}/panel/dashboard`)}
            className="shrink-0 gap-1.5"
          >
            <X className="h-4 w-4" aria-hidden="true" />
            <span className="hidden sm:inline">{t('saveAndExit')}</span>
          </Button>
        </div>

        {/* Mobile progress bar */}
        <div className="mx-auto w-full max-w-5xl px-4 pb-3 md:hidden">
          <ProgressBar
            value={progressPercent}
            label={t('progress', {
              current: currentStep,
              total: TOTAL_STEPS,
              percent: progressPercent,
            })}
          />
        </div>

        {/* Stepper */}
        <div className="mx-auto w-full max-w-5xl px-4 pb-3 md:px-6 md:pb-4">
          <Stepper steps={steps} onStepClick={handleStepClick} />
        </div>
      </header>

      {/* Main scrollable */}
      <main
        className={cn(
          'mx-auto flex w-full max-w-3xl flex-1 flex-col px-4 py-6 md:px-6 md:py-10',
        )}
      >
        {children}
      </main>
    </div>
  );
}
