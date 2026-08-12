'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { ArrowLeft, ArrowRight, ChevronDown } from 'lucide-react';
import { toast } from 'sonner';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { fetcher } from '@/lib/auth';
import { cn } from '@/lib/utils';
import { useOnboarding } from '../OnboardingContext';
import { getFaqTemplates } from '../templates/faqTemplates';
import { SERVICE_TEMPLATES } from '../templates/serviceTemplates';

interface Props {
  locale: string;
  token: string;
}

const DURATION_OPTIONS = [15, 20, 30, 45, 60, 90, 120] as const;

const serviceSchema = z.object({
  name: z.string().trim().min(2).max(120),
  durationMin: z.coerce.number().int().min(5).max(480),
  priceCents: z
    .union([z.coerce.number().int().min(0), z.literal('')])
    .optional(),
});

type ServiceFormValues = z.infer<typeof serviceSchema>;

/**
 * Step 2 — Primer servicio. Chips por clinicType para bajar activation
 * energy. Al elegir chip se pre-llena name + duration; el user puede editar.
 * Precio en collapse (progressive disclosure — 90% de las clínicas del piloto
 * no lo cargan y no es requerido para bookear).
 *
 * Al submit crea el Service y — si `prefillFaqs` estaba true en step 1 —
 * dispara Promise.allSettled con las FAQ templates. Errores parciales se
 * loguean pero no bloquean el avance.
 */
export function StepService({ locale, token }: Props) {
  const t = useTranslations('onboarding.step2');
  const tShell = useTranslations('onboarding.shell');
  const router = useRouter();
  const { me, state, patch } = useOnboarding();

  const [showPrice, setShowPrice] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const suggestions = state.clinicType
    ? SERVICE_TEMPLATES[state.clinicType]
    : [];

  const form = useForm<ServiceFormValues>({
    resolver: zodResolver(serviceSchema),
    defaultValues: {
      name: state.serviceName ?? '',
      durationMin: 30,
      priceCents: '',
    },
  });

  const applySuggestion = (name: string, durationMin: number) => {
    form.setValue('name', name, { shouldValidate: true });
    form.setValue('durationMin', durationMin, { shouldValidate: true });
  };

  const onSubmit = async (values: ServiceFormValues) => {
    if (submitting) return;
    setSubmitting(true);

    const payload: Record<string, unknown> = {
      name: values.name,
      durationMin: values.durationMin,
    };
    if (values.priceCents !== '' && values.priceCents !== undefined) {
      payload.priceCents = values.priceCents;
    }

    const res = await fetcher<{ id: string; name: string }>('/api/services', {
      method: 'POST',
      body: JSON.stringify(payload),
      token,
    });

    if (!res.ok) {
      setSubmitting(false);
      toast.error(t('errors.createFailed'));
      return;
    }

    patch({ serviceId: res.data.id, serviceName: res.data.name });

    // Pre-cargar FAQs en background — errores tolerables (log, no bloqueamos).
    if (state.prefillFaqs && state.clinicType && me.clinic?.name) {
      const faqs = getFaqTemplates(state.clinicType, me.clinic.name);
      void Promise.allSettled(
        faqs.map((f) =>
          fetcher('/api/faq', {
            method: 'POST',
            body: JSON.stringify(f),
            token,
          }),
        ),
      );
    }

    router.push(`/${locale}/onboarding/3`);
  };

  return (
    <form onSubmit={form.handleSubmit(onSubmit)} className="flex flex-col gap-8">
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight text-foreground md:text-3xl">
          {t('title')}
        </h1>
        <p className="text-sm text-muted-foreground md:text-base">
          {t('subtitle')}
        </p>
      </div>

      {suggestions.length > 0 ? (
        <div className="space-y-2">
          <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            {t('suggestions')}
          </p>
          <div className="flex flex-wrap gap-2">
            {suggestions.map((sug) => (
              <button
                key={sug.name}
                type="button"
                onClick={() => applySuggestion(sug.name, sug.durationMin)}
                className="rounded-full border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:border-brand-400 hover:bg-brand-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {sug.name}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      <div className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="service-name" className="text-sm font-medium">
            {t('name')}
          </Label>
          <Input
            id="service-name"
            {...form.register('name')}
            placeholder={t('namePlaceholder')}
            aria-invalid={form.formState.errors.name ? 'true' : 'false'}
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="service-duration" className="text-sm font-medium">
            {t('duration')}
          </Label>
          <Select
            value={String(form.watch('durationMin') ?? 30)}
            onValueChange={(v) =>
              form.setValue('durationMin', Number(v), { shouldValidate: true })
            }
          >
            <SelectTrigger id="service-duration">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {DURATION_OPTIONS.map((mins) => (
                <SelectItem key={mins} value={String(mins)}>
                  {t('durationOption', { mins })}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-2">
          <button
            type="button"
            onClick={() => setShowPrice((v) => !v)}
            className="flex items-center gap-1.5 text-xs font-medium text-brand-700 hover:text-brand-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <ChevronDown
              className={cn(
                'h-3.5 w-3.5 transition-transform',
                showPrice && 'rotate-180',
              )}
              aria-hidden="true"
            />
            {t('togglePrice')}
          </button>
          {showPrice ? (
            <div className="space-y-2">
              <Label htmlFor="service-price" className="text-sm font-medium">
                {t('priceOptional')}
              </Label>
              <Input
                id="service-price"
                type="number"
                min="0"
                step="1"
                inputMode="numeric"
                placeholder="0"
                {...form.register('priceCents')}
              />
              <p className="text-xs text-muted-foreground">
                {t('priceHint')}
              </p>
            </div>
          ) : null}
        </div>
      </div>

      <div className="flex flex-col-reverse gap-2 pt-2 sm:flex-row sm:justify-between">
        <Button
          type="button"
          variant="ghost"
          size="lg"
          onClick={() => router.push(`/${locale}/onboarding/1`)}
          className="min-h-11 gap-2"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
          {tShell('back')}
        </Button>
        <Button
          type="submit"
          size="lg"
          disabled={submitting || !form.formState.isValid}
          className="min-h-11 gap-2 sm:min-w-40"
        >
          {submitting ? tShell('creating') : tShell('next')}
          {!submitting ? <ArrowRight className="h-4 w-4" aria-hidden="true" /> : null}
        </Button>
      </div>
    </form>
  );
}
