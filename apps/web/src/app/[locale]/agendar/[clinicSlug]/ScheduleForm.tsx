'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useTranslations } from 'next-intl';
import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { createAppointment, fetchAvailability, type Slot } from '@/lib/api';

interface Service {
  id: string;
  name: string;
  durationMin: number;
  priceCents: number | null;
}

interface Professional {
  id: string;
  name: string;
  serviceIds: string[];
}

interface ScheduleFormProps {
  clinicSlug: string;
  timezone: string;
  services: Service[];
  professionals: Professional[];
  locale: string;
}

/**
 * Schema Zod: refleja el DTO del backend (`CreatePublicAppointmentDto`).
 * - Regex E.164 idéntico.
 * - `consent` debe ser `true` (usamos `literal(true)`).
 * - `honeypot` opcional string (los bots suelen llenarlo).
 * - `slot` (aka startAtISO) es required — hasta que el usuario elige uno, no
 *   se puede enviar.
 */
const scheduleSchema = z.object({
  name: z.string().trim().min(2).max(80),
  phone: z.string().regex(/^\+?[1-9]\d{7,14}$/),
  notes: z.string().max(500).optional().or(z.literal('')),
  serviceId: z.string().min(1),
  professionalId: z.string().min(1),
  startAtISO: z.string().min(1),
  consent: z.literal(true),
  honeypot: z.string().optional(),
});

type ScheduleFormValues = z.infer<typeof scheduleSchema>;

/**
 * Agrupa slots por fecha local (YYYY-MM-DD en la TZ de la clínica) para render
 * en columnas por día. Usamos `Intl.DateTimeFormat` con la TZ correcta — no
 * `Date.toLocaleDateString` del user agent, porque queremos la fecha desde la
 * perspectiva de la clínica.
 */
function groupSlotsByDay(
  slots: Slot[],
  timezone: string,
  locale: string,
): Array<{ dayLabel: string; slots: Slot[] }> {
  const dayFormatter = new Intl.DateTimeFormat(locale, {
    timeZone: timezone,
    weekday: 'short',
    day: '2-digit',
    month: 'short',
  });
  const keyFormatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });

  const byKey = new Map<string, { dayLabel: string; slots: Slot[] }>();
  for (const slot of slots) {
    const d = new Date(slot.startAt);
    const key = keyFormatter.format(d);
    if (!byKey.has(key)) {
      byKey.set(key, { dayLabel: dayFormatter.format(d), slots: [] });
    }
    byKey.get(key)!.slots.push(slot);
  }
  return Array.from(byKey.values());
}

function formatSlotTime(iso: string, timezone: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(iso));
}

/**
 * Client component del formulario de agendamiento.
 *
 * Reglas:
 * - Cuando cambian serviceId y professionalId, refetch de slots.
 * - `professional` se filtra por `service.professionals` (multi-tenant cliente).
 * - `honeypot` está en el DOM pero oculto con `sr-only` y `aria-hidden` +
 *   `tabIndex={-1}` para que humanos no lo llenen y assistive tech lo ignore.
 * - 409 → refetch de slots automático + mensaje de "elegí otro".
 * - 429 → mensaje "probá en un minuto".
 * - 201 → redirect a /gracias con query params.
 */
export function ScheduleForm(props: ScheduleFormProps) {
  const { clinicSlug, timezone, services, professionals, locale } = props;
  const t = useTranslations('form');
  const router = useRouter();

  const {
    register,
    handleSubmit,
    watch,
    setValue,
    formState: { errors, isSubmitting },
  } = useForm<ScheduleFormValues>({
    resolver: zodResolver(scheduleSchema),
    defaultValues: {
      name: '',
      phone: '',
      notes: '',
      serviceId: '',
      professionalId: '',
      startAtISO: '',
      // consent no puede ser default true — el usuario tiene que marcarlo activamente.
      consent: undefined as unknown as true,
      honeypot: '',
    },
  });

  const serviceId = watch('serviceId');
  const professionalId = watch('professionalId');
  const selectedSlot = watch('startAtISO');

  const [slots, setSlots] = useState<Slot[]>([]);
  const [slotsLoading, setSlotsLoading] = useState(false);
  const [slotsError, setSlotsError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Profesionales filtrados por el servicio elegido — evita mostrar profesionales
  // que no atienden ese servicio (además de la validación del backend).
  const availableProfessionals = useMemo(() => {
    if (!serviceId) return [];
    return professionals.filter((p) => p.serviceIds.includes(serviceId));
  }, [serviceId, professionals]);

  // Reset del professional si dejó de ser válido para el nuevo servicio.
  useEffect(() => {
    if (
      professionalId &&
      !availableProfessionals.some((p) => p.id === professionalId)
    ) {
      setValue('professionalId', '');
      setValue('startAtISO', '');
      setSlots([]);
    }
  }, [availableProfessionals, professionalId, setValue]);

  // Fetch de slots cuando hay service + professional válidos.
  useEffect(() => {
    if (!serviceId || !professionalId) {
      setSlots([]);
      return;
    }
    let cancelled = false;
    async function load() {
      setSlotsLoading(true);
      setSlotsError(null);
      try {
        // `from` = hoy 00:00 en TZ del navegador; el backend re-anchura al día
        // en la TZ de la clínica al parsear.
        const todayISO = new Date().toISOString();
        const data = await fetchAvailability(clinicSlug, {
          serviceId,
          professionalId,
          from: todayISO,
          days: 7,
        });
        if (!cancelled) setSlots(data.slice(0, 12));
      } catch (e) {
        if (!cancelled) {
          setSlots([]);
          setSlotsError(t('errors.genericError'));
        }
      } finally {
        if (!cancelled) setSlotsLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [clinicSlug, serviceId, professionalId, t]);

  const groupedSlots = useMemo(
    () => groupSlotsByDay(slots, timezone, locale),
    [slots, timezone, locale],
  );

  async function refetchSlots() {
    if (!serviceId || !professionalId) return;
    setSlotsLoading(true);
    try {
      const todayISO = new Date().toISOString();
      const data = await fetchAvailability(clinicSlug, {
        serviceId,
        professionalId,
        from: todayISO,
        days: 7,
      });
      setSlots(data.slice(0, 12));
      setValue('startAtISO', '');
    } catch {
      setSlotsError(t('errors.genericError'));
    } finally {
      setSlotsLoading(false);
    }
  }

  async function onSubmit(values: ScheduleFormValues) {
    setSubmitError(null);
    const result = await createAppointment(clinicSlug, {
      phone: values.phone,
      name: values.name,
      notes: values.notes || undefined,
      consent: true,
      serviceId: values.serviceId,
      professionalId: values.professionalId,
      startAtISO: values.startAtISO,
      honeypot: values.honeypot,
    });

    if (result.ok) {
      const startISO = result.data.startAt;
      const dateFmt = new Intl.DateTimeFormat(locale, {
        timeZone: timezone,
        weekday: 'long',
        day: '2-digit',
        month: 'long',
      }).format(new Date(startISO));
      const timeFmt = formatSlotTime(startISO, timezone, locale);
      // Privacidad: NO poner `name` en la query string (queda en Referer +
      // historial + logs de CDN). Sólo la fecha/hora, que no son PII sensible.
      // El nombre del paciente lo pasamos por sessionStorage (limitado a la
      // pestaña, sin persistencia). Sólo guardamos el primer nombre para
      // reducir aún más la superficie.
      if (typeof window !== 'undefined') {
        try {
          const firstName = values.name.trim().split(/\s+/)[0] ?? '';
          window.sessionStorage.setItem('agz.thanks.name', firstName);
        } catch {
          // sessionStorage puede fallar en modo privado / algunas WebViews.
          // No es crítico — la página /gracias muestra un fallback.
        }
      }
      const qs = new URLSearchParams({
        date: dateFmt,
        time: timeFmt,
      });
      router.push(`/${locale}/agendar/${clinicSlug}/gracias?${qs.toString()}`);
      return;
    }

    if (result.status === 409) {
      setSubmitError(t('errors.slotTaken'));
      await refetchSlots();
      return;
    }
    if (result.status === 429) {
      setSubmitError(t('errors.rateLimit'));
      return;
    }
    setSubmitError(t('errors.genericError'));
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-5" noValidate>
      {/* Honeypot: absolutamente oculto. Los bots suelen llenar todos los inputs. */}
      <div className="sr-only" aria-hidden="true">
        <label htmlFor="hp">Do not fill</label>
        <input
          id="hp"
          type="text"
          tabIndex={-1}
          autoComplete="off"
          {...register('honeypot')}
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="name">{t('labels.name')}</Label>
        <Input
          id="name"
          type="text"
          autoComplete="name"
          placeholder={t('placeholders.name')}
          {...register('name')}
        />
        {errors.name ? (
          <p className="text-sm text-red-600">{t('errors.nameMin')}</p>
        ) : null}
      </div>

      <div className="space-y-2">
        <Label htmlFor="phone">{t('labels.phone')}</Label>
        <Input
          id="phone"
          type="tel"
          autoComplete="tel"
          placeholder={t('placeholders.phone')}
          {...register('phone')}
        />
        <p className="text-xs text-gray-500">{t('hints.phone')}</p>
        {errors.phone ? (
          <p className="text-sm text-red-600">{t('errors.phoneInvalid')}</p>
        ) : null}
      </div>

      <div className="space-y-2">
        <Label htmlFor="serviceId">{t('labels.service')}</Label>
        <Select id="serviceId" {...register('serviceId')}>
          <option value="">{t('placeholders.selectService')}</option>
          {services.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name} ({s.durationMin} min)
            </option>
          ))}
        </Select>
        {errors.serviceId ? (
          <p className="text-sm text-red-600">{t('errors.required')}</p>
        ) : null}
      </div>

      <div className="space-y-2">
        <Label htmlFor="professionalId">{t('labels.professional')}</Label>
        <Select
          id="professionalId"
          disabled={!serviceId}
          {...register('professionalId')}
        >
          <option value="">{t('placeholders.selectProfessional')}</option>
          {availableProfessionals.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </Select>
        {!serviceId ? (
          <p className="text-xs text-gray-500">{t('hints.selectServiceFirst')}</p>
        ) : null}
        {errors.professionalId ? (
          <p className="text-sm text-red-600">{t('errors.required')}</p>
        ) : null}
      </div>

      <div className="space-y-2">
        <Label>{t('labels.slot')}</Label>
        {!serviceId || !professionalId ? (
          <p className="text-sm text-gray-500">{t('chooseCombination')}</p>
        ) : slotsLoading ? (
          <p className="text-sm text-gray-500">…</p>
        ) : slotsError ? (
          <p className="text-sm text-red-600">{slotsError}</p>
        ) : slots.length === 0 ? (
          <p className="text-sm text-gray-500">{t('noSlots')}</p>
        ) : (
          <div className="space-y-4">
            {groupedSlots.map((group) => (
              <div key={group.dayLabel}>
                <p className="mb-2 text-sm font-semibold text-gray-700">
                  {group.dayLabel}
                </p>
                <div className="flex flex-wrap gap-2">
                  {group.slots.map((slot) => {
                    const time = formatSlotTime(slot.startAt, timezone, locale);
                    const isSelected = selectedSlot === slot.startAt;
                    return (
                      <button
                        key={slot.startAt}
                        type="button"
                        onClick={() => setValue('startAtISO', slot.startAt)}
                        className={`rounded-md border px-3 py-2 text-sm transition-colors ${
                          isSelected
                            ? 'border-brand-600 bg-brand-500 text-white'
                            : 'border-gray-300 bg-white text-gray-700 hover:border-brand-500 hover:bg-brand-50'
                        }`}
                      >
                        {time}
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
        {errors.startAtISO ? (
          <p className="text-sm text-red-600">{t('errors.slotRequired')}</p>
        ) : null}
      </div>

      <div className="space-y-2">
        <Label htmlFor="notes">{t('labels.notes')}</Label>
        <Textarea
          id="notes"
          placeholder={t('placeholders.notes')}
          {...register('notes')}
        />
      </div>

      <div className="flex items-start gap-2">
        <input
          id="consent"
          type="checkbox"
          className="mt-1 h-4 w-4 rounded border-gray-300 text-brand-600 focus:ring-brand-500"
          {...register('consent')}
        />
        <Label htmlFor="consent" className="cursor-pointer">
          {t('labels.consent')}
        </Label>
      </div>
      {errors.consent ? (
        <p className="text-sm text-red-600">{t('errors.consent')}</p>
      ) : null}

      {submitError ? (
        <div className="rounded-md bg-red-50 p-3 text-sm text-red-800">
          {submitError}
        </div>
      ) : null}

      <Button type="submit" disabled={isSubmitting} className="w-full">
        {isSubmitting ? t('labels.submitting') : t('labels.submit')}
      </Button>
    </form>
  );
}
