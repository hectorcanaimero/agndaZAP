'use client';

import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import {
  Activity,
  Brain,
  MoreHorizontal,
  Sparkles,
  Stethoscope,
  ThumbsUp,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';
import { useOnboarding } from '../OnboardingContext';
import { CLINIC_TYPES, type ClinicType } from '../templates/serviceTemplates';

interface Props {
  locale: string;
}

const CLINIC_TYPE_ICONS: Record<ClinicType, LucideIcon> = {
  dentistry: ThumbsUp,
  aesthetics: Sparkles,
  general_medicine: Stethoscope,
  physiotherapy: Activity,
  psychology: Brain,
  other: MoreHorizontal,
};

/**
 * Step 1 — Bienvenida. Elige tipo de clínica (habilita templates de servicio
 * + FAQs) y opt-in de pre-cargar FAQs típicas (default true por reciprocity).
 *
 * Al elegir tipo NO se avanza automático — el user marca/desmarca el checkbox
 * y aprieta "Empezar". Un solo submit facilita undo (typo en clinicType).
 */
export function StepWelcome({ locale }: Props) {
  const t = useTranslations('onboarding.step1');
  const tShell = useTranslations('onboarding.shell');
  const router = useRouter();
  const { me, state, patch } = useOnboarding();

  const clinicName = me.clinic?.name ?? '';

  const handleContinue = () => {
    if (!state.clinicType) return;
    // Persistimos el step actual en el progress también para que el root
    // dispatcher pueda retomar acá si el user cierra y vuelve.
    patch({ clinicType: state.clinicType, prefillFaqs: state.prefillFaqs });
    router.push(`/${locale}/onboarding/2`);
  };

  return (
    <div className="flex flex-col gap-8">
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight text-foreground md:text-3xl">
          {t('title', { clinicName })}
        </h1>
        <p className="text-sm text-muted-foreground md:text-base">
          {t('subtitle')}
        </p>
      </div>

      <div className="space-y-3">
        <p className="text-sm font-medium text-foreground">
          {t('clinicType.question')}
        </p>
        <div className="grid grid-cols-2 gap-2 md:grid-cols-3">
          {CLINIC_TYPES.map((type) => {
            const Icon = CLINIC_TYPE_ICONS[type];
            const selected = state.clinicType === type;
            return (
              <button
                key={type}
                type="button"
                onClick={() => patch({ clinicType: type })}
                aria-pressed={selected}
                className={cn(
                  'flex min-h-24 flex-col items-center justify-center gap-2 rounded-lg border p-3 text-center transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
                  selected
                    ? 'border-brand-600 bg-brand-50 text-brand-800'
                    : 'border-slate-200 bg-white text-foreground hover:border-slate-300 hover:bg-slate-50',
                )}
              >
                <Icon
                  className={cn(
                    'h-6 w-6',
                    selected ? 'text-brand-600' : 'text-muted-foreground',
                  )}
                  aria-hidden="true"
                />
                <span className="text-sm font-medium">
                  {t(`clinicType.${type}` as never)}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <label
        htmlFor="prefill-faqs"
        className="flex cursor-pointer items-start gap-3 rounded-md border border-slate-200 bg-white p-4 transition-colors hover:bg-slate-50"
      >
        <Checkbox
          id="prefill-faqs"
          checked={state.prefillFaqs}
          onCheckedChange={(v) => patch({ prefillFaqs: v === true })}
          className="mt-0.5"
        />
        <div className="min-w-0 space-y-1">
          <Label
            htmlFor="prefill-faqs"
            className="cursor-pointer text-sm font-medium text-foreground"
          >
            {t('prefillFaqs.title')}
          </Label>
          <p className="text-xs text-muted-foreground">
            {t('prefillFaqs.help')}
          </p>
        </div>
      </label>

      <div className="flex flex-col-reverse gap-2 pt-2 sm:flex-row sm:justify-end">
        <Button
          type="button"
          size="lg"
          disabled={!state.clinicType}
          onClick={handleContinue}
          className="min-h-11 gap-2 sm:min-w-40"
        >
          {t('cta')}
        </Button>
      </div>

      <p className="text-center text-xs text-muted-foreground">
        {tShell('footNote')}
      </p>
    </div>
  );
}
