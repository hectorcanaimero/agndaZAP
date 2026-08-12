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
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { fetcher } from '@/lib/auth';
import { cn } from '@/lib/utils';
import { useOnboarding } from '../OnboardingContext';

interface Props {
  locale: string;
  token: string;
}

/**
 * Paleta de colores para diferenciar profesionales en la agenda. Elegimos 6
 * tonos con buen contraste sobre fondo blanco y suficientemente distintos
 * entre sí. Free color picker se evita — introduce contrast issues y no
 * aporta valor real (el operador solo necesita distinguir profesionales).
 */
const COLOR_SWATCHES = [
  '#0EA5E9', // sky
  '#22C55E', // green
  '#F59E0B', // amber
  '#EC4899', // pink
  '#8B5CF6', // violet
  '#F43F5E', // rose
] as const;

const professionalSchema = z.object({
  name: z.string().trim().min(2).max(120),
  email: z
    .union([z.string().trim().email(), z.literal('')])
    .optional()
    .transform((v) => (v === '' ? undefined : v)),
  phone: z
    .union([z.string().trim().min(6).max(20), z.literal('')])
    .optional()
    .transform((v) => (v === '' ? undefined : v)),
  specialty: z
    .union([z.string().trim().min(2).max(120), z.literal('')])
    .optional()
    .transform((v) => (v === '' ? undefined : v)),
  color: z.string().regex(/^#[0-9A-Fa-f]{6}$/),
  linkToService: z.boolean(),
});

type ProfessionalFormValues = z.infer<typeof professionalSchema>;

/**
 * Step 3 — Primer profesional. Pre-fill del `name` con `me.name` (default
 * effect: la mayoría de los dueños se agregan a sí mismos primero). Fields
 * opcionales en collapse para no abrumar.
 *
 * Checkbox central "También hace: {serviceName}" default true — el 100% de
 * los casos en el piloto tuvo un solo profesional prestando el servicio del
 * step 2, así que el default es la opción probable.
 */
export function StepProfessional({ locale, token }: Props) {
  const t = useTranslations('onboarding.step3');
  const tShell = useTranslations('onboarding.shell');
  const router = useRouter();
  const { me, state, patch } = useOnboarding();

  const [showOptional, setShowOptional] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const form = useForm<ProfessionalFormValues>({
    resolver: zodResolver(professionalSchema),
    defaultValues: {
      name: me.name && me.name !== '—' ? me.name : '',
      email: '',
      phone: '',
      specialty: '',
      color: COLOR_SWATCHES[0],
      linkToService: true,
    },
  });

  const selectedColor = form.watch('color');
  const linkToService = form.watch('linkToService');

  const onSubmit = async (values: ProfessionalFormValues) => {
    if (submitting) return;
    setSubmitting(true);

    const payload: Record<string, unknown> = {
      name: values.name,
      color: values.color,
      active: true,
    };
    if (values.email) payload.email = values.email;
    if (values.phone) payload.phone = values.phone;
    if (values.specialty) payload.specialty = values.specialty;
    if (values.linkToService && state.serviceId) {
      payload.serviceIds = [state.serviceId];
    }

    const res = await fetcher<{ id: string; name: string }>(
      '/api/professionals',
      { method: 'POST', body: JSON.stringify(payload), token },
    );

    if (!res.ok) {
      setSubmitting(false);
      toast.error(t('errors.createFailed'));
      return;
    }

    patch({ professionalId: res.data.id });
    router.push(`/${locale}/onboarding/4`);
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

      <div className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="prof-name" className="text-sm font-medium">
            {t('name')}
          </Label>
          <Input
            id="prof-name"
            {...form.register('name')}
            placeholder={t('namePlaceholder')}
            aria-invalid={form.formState.errors.name ? 'true' : 'false'}
          />
        </div>

        {state.serviceName ? (
          <label
            htmlFor="link-service"
            className="flex cursor-pointer items-start gap-3 rounded-md border border-slate-200 bg-white p-4 transition-colors hover:bg-slate-50"
          >
            <Checkbox
              id="link-service"
              checked={linkToService}
              onCheckedChange={(v) =>
                form.setValue('linkToService', v === true)
              }
              className="mt-0.5"
            />
            <div className="min-w-0 space-y-1">
              <Label
                htmlFor="link-service"
                className="cursor-pointer text-sm font-medium text-foreground"
              >
                {t('linkService', { serviceName: state.serviceName })}
              </Label>
              <p className="text-xs text-muted-foreground">
                {t('linkServiceHint')}
              </p>
            </div>
          </label>
        ) : null}

        <div className="space-y-2">
          <p className="text-sm font-medium">{t('colorLabel')}</p>
          <div className="flex flex-wrap gap-2">
            {COLOR_SWATCHES.map((color) => (
              <button
                key={color}
                type="button"
                onClick={() => form.setValue('color', color)}
                aria-label={t('colorSwatch', { color })}
                aria-pressed={selectedColor === color}
                className={cn(
                  'h-8 w-8 rounded-full border-2 transition-transform focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
                  selectedColor === color
                    ? 'scale-110 border-foreground'
                    : 'border-white shadow-sm hover:scale-105',
                )}
                style={{ backgroundColor: color }}
              />
            ))}
          </div>
        </div>

        <div className="space-y-2">
          <button
            type="button"
            onClick={() => setShowOptional((v) => !v)}
            className="flex items-center gap-1.5 text-xs font-medium text-brand-700 hover:text-brand-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <ChevronDown
              className={cn(
                'h-3.5 w-3.5 transition-transform',
                showOptional && 'rotate-180',
              )}
              aria-hidden="true"
            />
            {t('optionalToggle')}
          </button>

          {showOptional ? (
            <div className="space-y-4 rounded-md border border-slate-200 bg-slate-50 p-4">
              <div className="space-y-2">
                <Label htmlFor="prof-email" className="text-sm font-medium">
                  {t('email')}
                </Label>
                <Input
                  id="prof-email"
                  type="email"
                  autoComplete="email"
                  {...form.register('email')}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="prof-phone" className="text-sm font-medium">
                  {t('phone')}
                </Label>
                <Input
                  id="prof-phone"
                  type="tel"
                  autoComplete="tel"
                  placeholder="+58412..."
                  {...form.register('phone')}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="prof-specialty" className="text-sm font-medium">
                  {t('specialty')}
                </Label>
                <Input
                  id="prof-specialty"
                  {...form.register('specialty')}
                  placeholder={t('specialtyPlaceholder')}
                />
              </div>
            </div>
          ) : null}
        </div>
      </div>

      <div className="flex flex-col-reverse gap-2 pt-2 sm:flex-row sm:justify-between">
        <Button
          type="button"
          variant="ghost"
          size="lg"
          onClick={() => router.push(`/${locale}/onboarding/2`)}
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
