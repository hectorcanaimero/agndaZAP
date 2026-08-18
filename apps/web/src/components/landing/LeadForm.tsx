'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation } from '@tanstack/react-query';
import { ArrowRight, CheckCircle2 } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { submitLead, type CreateLeadResponse } from '@/lib/lead';

/**
 * Schema Zod que espeja al DTO de backend (`CreateLeadDto`).
 * - Regex E.164 idéntica al DTO del backend y a `ScheduleForm`.
 * - `consent` con `literal(true)` (bool estricto).
 * - `clinicType` opcional pero cuando viene, debe estar en la whitelist.
 *   El value del `<Select>` de Radix nunca es undefined tras seleccionar,
 *   por eso admitimos también `''` para el estado inicial "sin elegir".
 * - `honeypot` opcional string.
 */
const CLINIC_TYPES = [
  'consultorio',
  'clinica',
  'estetica',
  'especialista',
  'otro',
] as const;

// clinicType admite '' (estado "sin elegir" del Select) además de la
// whitelist. No usamos `.transform()` — la normalización '' → undefined la
// hace `onSubmit` antes de llamar al backend. Motivo: zodResolver tiene una
// firma triple con transform que provoca desalineación de tipos entre el
// form y el handler; mantener input === output evita el infierno de casts.
const leadSchema = z.object({
  name: z.string().trim().min(2).max(80),
  phone: z.string().regex(/^\+?[1-9]\d{7,14}$/),
  clinicType: z.union([z.enum(CLINIC_TYPES), z.literal('')]).optional(),
  consent: z.literal(true),
  honeypot: z.string().optional(),
});

type LeadFormValues = z.infer<typeof leadSchema>;

/**
 * Form inline para captura de leads en la landing (FinalCta).
 *
 * Diseño visual: fondo blanco redondeado sobre el card gradient verde del
 * FinalCta — contraste alto + focus rings visibles para accesibilidad.
 * Cuando el submit es exitoso mostramos un empty-state de éxito INLINE
 * (no navegamos, no recargamos) — el patrón de "form desaparece, aparece
 * checkmark verde" tiene mejor perceived responsiveness que un toast solo.
 *
 * Manejo de errores:
 * - 429 → mensaje "muchas solicitudes, probá en un minuto" + toast.
 * - 400 (validation server) → mensaje genérico "revisá los datos" + toast.
 * - Red/otro → toast genérico. El form queda editable.
 *
 * Doble submit lock: rhf `isSubmitting` + `mutation.isPending`. Idéntico
 * cinturón + tirantes que `ScheduleForm`.
 */
export function LeadForm() {
  const t = useTranslations('landing.cta.form');
  const locale = useLocale();

  const {
    register,
    handleSubmit,
    watch,
    setValue,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<LeadFormValues>({
    resolver: zodResolver(leadSchema),
    defaultValues: {
      name: '',
      phone: '',
      clinicType: '',
      // consent NO es default true — el usuario tiene que marcarlo activamente.
      consent: undefined as unknown as true,
      honeypot: '',
    },
  });

  const clinicType = watch('clinicType');
  const consent = watch('consent');
  const [succeeded, setSucceeded] = useState(false);

  const mutation = useMutation<
    CreateLeadResponse,
    Error,
    LeadFormValues
  >({
    mutationFn: (values) =>
      submitLead({
        name: values.name,
        phone: values.phone,
        // '' → undefined: el schema del backend rechaza '' (no está en la
        // whitelist de clinicType), así que normalizamos acá.
        clinicType:
          values.clinicType && values.clinicType.length > 0
            ? values.clinicType
            : undefined,
        consent: true,
        locale,
        honeypot: values.honeypot,
      }),
  });

  async function onSubmit(values: LeadFormValues) {
    if (isSubmitting || mutation.isPending) return;

    const result = await mutation.mutateAsync(values);

    if (result.ok) {
      setSucceeded(true);
      toast.success(t('successToast'));
      reset();
      return;
    }

    if (result.status === 429) {
      toast.error(t('errors.rateLimit'));
      return;
    }
    if (result.status === 400) {
      toast.error(t('errors.validation'));
      return;
    }
    toast.error(t('errors.generic'));
  }

  const submitting = isSubmitting || mutation.isPending;

  if (succeeded) {
    // Empty-state post-envío. Sobre fondo blanco, texto neutral oscuro para
    // legibilidad. `role="status"` + `aria-live="polite"` para que screen
    // readers anuncien el éxito sin interrumpir.
    return (
      <div
        role="status"
        aria-live="polite"
        className="flex items-start gap-4 rounded-2xl bg-white p-6 shadow-lg sm:p-8"
      >
        <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-brand-teal/15 text-brand-navy">
          <CheckCircle2 className="h-6 w-6" aria-hidden="true" />
        </div>
        <div className="min-w-0">
          <h3 className="text-lg font-semibold text-neutral-950 sm:text-xl">
            {t('successTitle')}
          </h3>
          <p className="mt-2 text-sm text-neutral-600 sm:text-base">
            {t('successBody')}
          </p>
        </div>
      </div>
    );
  }

  return (
    <form
      onSubmit={handleSubmit(onSubmit)}
      className="rounded-2xl bg-white p-6 shadow-lg sm:p-8"
      noValidate
    >
      {/* Honeypot invisible. Idéntico patrón al ScheduleForm. */}
      <div className="sr-only" aria-hidden="true">
        <label htmlFor="lead-hp">Do not fill</label>
        <input
          id="lead-hp"
          type="text"
          tabIndex={-1}
          autoComplete="off"
          {...register('honeypot')}
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="lead-name" className="text-sm font-medium text-neutral-800">
            {t('labels.name')}
          </Label>
          <Input
            id="lead-name"
            type="text"
            autoComplete="name"
            placeholder={t('placeholders.name')}
            aria-invalid={errors.name ? 'true' : 'false'}
            {...register('name')}
          />
          {errors.name ? (
            <p className="text-xs text-red-600" role="alert">
              {t('errors.nameMin')}
            </p>
          ) : null}
        </div>

        <div className="space-y-2">
          <Label htmlFor="lead-phone" className="text-sm font-medium text-neutral-800">
            {t('labels.phone')}
          </Label>
          <Input
            id="lead-phone"
            type="tel"
            autoComplete="tel"
            placeholder={t('placeholders.phone')}
            aria-invalid={errors.phone ? 'true' : 'false'}
            {...register('phone')}
          />
          {errors.phone ? (
            <p className="text-xs text-red-600" role="alert">
              {t('errors.phoneInvalid')}
            </p>
          ) : null}
        </div>
      </div>

      <div className="mt-4 space-y-2">
        <Label htmlFor="lead-clinic-type" className="text-sm font-medium text-neutral-800">
          {t('labels.clinicType')}
        </Label>
        {/*
          Radix Select — controlled con watch/setValue porque no acepta el
          `register()` de rhf (asume <select> nativo con onChange+event).
          Mismo patrón que `ScheduleForm`. El value inicial es '' (sin
          selección); al elegir uno queda como el value del SelectItem.
        */}
        <Select
          value={clinicType ?? ''}
          onValueChange={(v) =>
            setValue('clinicType', v as (typeof CLINIC_TYPES)[number], {
              shouldValidate: true,
            })
          }
        >
          <SelectTrigger id="lead-clinic-type">
            <SelectValue placeholder={t('placeholders.clinicType')} />
          </SelectTrigger>
          <SelectContent>
            {CLINIC_TYPES.map((type) => (
              <SelectItem key={type} value={type}>
                {t(`clinicTypes.${type}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="mt-5 flex items-start gap-3">
        <Checkbox
          id="lead-consent"
          checked={consent === true}
          onCheckedChange={(v) =>
            setValue('consent', v === true ? true : (undefined as never), {
              shouldValidate: true,
            })
          }
          className="mt-0.5"
        />
        <Label
          htmlFor="lead-consent"
          className="cursor-pointer text-xs font-normal leading-relaxed text-neutral-600"
        >
          {t('labels.consent')}
        </Label>
      </div>
      {errors.consent ? (
        <p className="mt-2 text-xs text-red-600" role="alert">
          {t('errors.consent')}
        </p>
      ) : null}

      {/*
        Batch 4: invertimos la jerarquía cromática — teal como acento sobre
        el fondo navy del FinalCta. El texto en navy garantiza contraste
        AA sobre teal (#28D9B9). El botón mantiene h-12 y w-full para no
        romper el ritmo del form.
      */}
      <Button
        type="submit"
        size="lg"
        disabled={submitting}
        className="mt-6 h-12 w-full bg-brand-teal text-brand-navy text-base font-semibold shadow-sm hover:bg-brand-teal/90"
      >
        {submitting ? (
          t('submitting')
        ) : (
          <>
            {t('submit')}
            <ArrowRight className="ml-1 h-4 w-4" aria-hidden="true" />
          </>
        )}
      </Button>
    </form>
  );
}
