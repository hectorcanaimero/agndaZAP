'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Calendar, MessageSquare, Stethoscope, User } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
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
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import {
  createAppointment,
  fetchAvailability,
  type CreateAppointmentPayload,
  type CreateAppointmentResponse,
  type Slot,
} from '@/lib/api';
import { queryKeys } from '@/lib/query-keys';
import { todayStartInTZ } from '@/lib/utils';

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
 * Skeleton de slots — 3 filas × 4 buttons con `animate-pulse`.
 *
 * Motivo: en redes lentas (mobile 3G, típico LATAM) el fetch de disponibilidad
 * es 2-4s. Mostrar "…" durante ese lapso es UX muerto. El skeleton comunica
 * "estamos calculando" y da estabilidad visual al layout (evita CLS cuando
 * llegan los slots reales).
 *
 * `aria-live="polite"` + `aria-busy="true"` para que screen readers anuncien
 * "cargando" sin interrumpir la navegación.
 */
function SlotsSkeleton({ ariaLabel }: { ariaLabel: string }) {
  return (
    <div
      className="space-y-2"
      role="status"
      aria-live="polite"
      aria-busy="true"
      aria-label={ariaLabel}
    >
      {[0, 1, 2].map((row) => (
        <div key={row} className="flex gap-2">
          {[0, 1, 2, 3].map((col) => (
            <Skeleton key={col} className="h-9 w-16 rounded-md" />
          ))}
        </div>
      ))}
    </div>
  );
}

/**
 * Spinner inline SVG (sin dep). Se usa dentro del botón submit durante
 * `isSubmitting` para comunicar "confirmando" — más claro que sólo bajar la
 * opacidad del botón (que es lo que hace `disabled:opacity-70` heredado).
 */
function SubmitSpinner() {
  return (
    <svg
      className="h-4 w-4 animate-spin"
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
    >
      <circle
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        strokeWidth="4"
        fill="none"
        opacity="0.25"
      />
      <path
        d="M4 12a8 8 0 018-8"
        stroke="currentColor"
        strokeWidth="4"
        fill="none"
      />
    </svg>
  );
}

/**
 * Section header — icono + título + descripción para agrupar visualmente los
 * "pasos" del form (Servicio, Horario, Datos). No es un stepper real, sólo
 * ayuda visual para dividir el formulario largo.
 */
function SectionHeader({
  icon: Icon,
  title,
  description,
}: {
  icon: React.ComponentType<{ className?: string; 'aria-hidden'?: boolean }>;
  title: string;
  description?: string;
}) {
  return (
    <div className="flex items-start gap-3 border-b border-gray-100 pb-3">
      <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand-50">
        <Icon
          className="h-4 w-4 text-brand-700"
          aria-hidden={true}
        />
      </div>
      <div>
        <h2 className="text-sm font-semibold text-gray-900">{title}</h2>
        {description ? (
          <p className="text-xs text-gray-500">{description}</p>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Client component del formulario de agendamiento.
 *
 * Reglas:
 * - Cuando cambian serviceId y professionalId, refetch de slots (useQuery).
 * - `professional` se filtra por `service.professionals` (multi-tenant cliente).
 * - `honeypot` está en el DOM pero oculto con `sr-only` y `aria-hidden` +
 *   `tabIndex={-1}` para que humanos no lo llenen y assistive tech lo ignore.
 * - 409 → refetch de slots automático + mensaje de "elegí otro" + foco al
 *   primer slot reofrecido (WCAG 2.4.3 Focus Order).
 * - 429 → mensaje "probá en un minuto".
 * - 201 → redirect a /gracias con query params.
 * - Doble submit lock: `mutation.isPending` + `isSubmitting` + `disabled` nativo
 *   de rhf. Verificado con throttling 3G: 1 request por submit.
 *
 * Fetching: useQuery para availability, useMutation para el submit. NO usamos
 * optimistic UI acá — el submit es único, crítico, y el paciente necesita
 * confirmación real del server antes del redirect a /gracias.
 */
export function ScheduleForm(props: ScheduleFormProps) {
  const { clinicSlug, timezone, services, professionals, locale } = props;
  const t = useTranslations('form');
  const router = useRouter();
  const qc = useQueryClient();

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
  const consent = watch('consent');

  const [submitError, setSubmitError] = useState<string | null>(null);
  // Empty-state CTA: si no hay slots en 7 días, el paciente puede pedir 14.
  // Se resetea a false cuando cambia el serviceId/professionalId (nuevo fetch
  // "por defecto" arranca con 7).
  const [expandedRange, setExpandedRange] = useState(false);

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
    }
  }, [availableProfessionals, professionalId, setValue]);

  // Reset del rango expandido cuando cambia service/professional — nuevo par,
  // arrancamos de nuevo con 7 días.
  useEffect(() => {
    setExpandedRange(false);
  }, [serviceId, professionalId]);

  /*
   * Availability con useQuery. La `queryKey` incluye clinicSlug, serviceId,
   * professionalId y expandedRange (via days) — cambiar cualquiera dispara
   * un nuevo fetch. Cuando falta service o professional, `enabled: false`
   * mantiene el fetch dormido.
   *
   * `todayISO` derivado con `todayStartInTZ(timezone)` — TZ de la clínica,
   * no del navegador (anti-drift).
   */
  const todayISO = useMemo(() => todayStartInTZ(timezone), [timezone]);
  const days = expandedRange ? 14 : 7;

  const slotsQuery = useQuery({
    queryKey: queryKeys.availability(
      clinicSlug,
      serviceId || undefined,
      professionalId || undefined,
      todayISO,
      days,
    ),
    queryFn: async () => {
      const data = await fetchAvailability(clinicSlug, {
        serviceId,
        professionalId,
        from: todayISO,
        days,
      });
      return data.slice(0, 12);
    },
    enabled: Boolean(serviceId && professionalId),
  });

  const slots: Slot[] = slotsQuery.data ?? [];
  const slotsLoading = slotsQuery.isFetching && slotsQuery.isLoading;
  const slotsError = slotsQuery.isError ? t('errors.genericError') : null;

  const groupedSlots = useMemo(
    () => groupSlotsByDay(slots, timezone, locale),
    [slots, timezone, locale],
  );

  // Cuando el paciente elige un slot nuevo, limpiar cualquier submitError
  // stale (típicamente "slot tomado" post-409): la nueva elección invalida
  // el mensaje anterior y evita confundir al usuario mientras vuelve a enviar.
  useEffect(() => {
    if (selectedSlot && submitError) {
      setSubmitError(null);
    }
    // Sólo depende de selectedSlot — submitError como dep provocaría loop si
    // el setSubmitError re-renderea antes de que el usuario cambie de slot.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedSlot]);

  const refetchSlots = useCallback(async () => {
    if (!serviceId || !professionalId) return;
    await qc.invalidateQueries({
      queryKey: queryKeys.availability(
        clinicSlug,
        serviceId,
        professionalId,
        todayISO,
        days,
      ),
    });
    setValue('startAtISO', '');
  }, [qc, clinicSlug, serviceId, professionalId, todayISO, days, setValue]);

  // CTAs del empty state (no slots en 7 días).
  const handleNextWeek = useCallback(() => {
    // El useQuery re-observa `expandedRange` via queryKey → dispara fetch con days=14.
    setExpandedRange(true);
  }, []);

  const handleChangeProfessional = useCallback(() => {
    // Forzar re-selección: limpiar el profesional actual + slot elegido.
    setValue('professionalId', '');
    setValue('startAtISO', '');
  }, [setValue]);

  /*
   * Submit como useMutation. No usamos optimistic UI — el paciente necesita
   * confirmación real del server (id + startAt oficial) antes del redirect.
   * El discriminated union de `createAppointment` viaja como Result para no
   * romper el shape que el resto del handler esperaba.
   */
  const submitMutation = useMutation({
    mutationFn: (
      payload: CreateAppointmentPayload,
    ): Promise<CreateAppointmentResponse> =>
      createAppointment(clinicSlug, payload),
  });

  async function onSubmit(values: ScheduleFormValues) {
    // Doble submit lock (defensa en profundidad):
    // rhf ya deshabilita el botón cuando isSubmitting=true; también miramos
    // mutation.isPending. Este early-return es cinturón + tirantes para redes
    // lentas / doble-tap mobile.
    if (isSubmitting || submitMutation.isPending) return;

    setSubmitError(null);
    const result = await submitMutation.mutateAsync({
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
      // Foco al primer slot reofrecido — WCAG 2.4.3 Focus Order + reduce
      // fricción cognitiva: el paciente no tiene que "cazar" con el mouse
      // qué cambió en la pantalla. `requestAnimationFrame` espera al próximo
      // paint para que el DOM ya tenga los nuevos buttons montados.
      if (typeof window !== 'undefined') {
        window.requestAnimationFrame(() => {
          const firstSlot =
            document.querySelector<HTMLButtonElement>('[data-slot]');
          firstSlot?.focus();
        });
      }
      return;
    }
    if (result.status === 429) {
      setSubmitError(t('errors.rateLimit'));
      return;
    }
    setSubmitError(t('errors.genericError'));
  }

  const hasMultipleProfessionals = availableProfessionals.length >= 2;
  const submitting = isSubmitting || submitMutation.isPending;

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-6" noValidate>
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

      {/* Sección 1 — Servicio */}
      <section className="space-y-4">
        <SectionHeader
          icon={Stethoscope}
          title={t('sections.service.title')}
          description={t('sections.service.description')}
        />

        <div className="space-y-2">
          <Label htmlFor="serviceId">{t('labels.service')}</Label>
          {/*
            Radix Select — no acepta `register` de rhf (que asume <select> nativo
            con `onChange`+event). Usamos `value` + `onValueChange` cableados a
            `watch()`/`setValue()`. Reseteamos el startAtISO cuando cambia el
            servicio (el useEffect ya lo hace vía availableProfessionals, pero
            por claridad).
          */}
          <Select
            value={serviceId}
            onValueChange={(v) =>
              setValue('serviceId', v, { shouldValidate: true })
            }
          >
            <SelectTrigger id="serviceId">
              <SelectValue placeholder={t('placeholders.selectService')} />
            </SelectTrigger>
            <SelectContent>
              {services.map((s) => (
                <SelectItem key={s.id} value={s.id}>
                  {s.name} ({s.durationMin} min)
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {errors.serviceId ? (
            <p className="text-sm text-red-600">{t('errors.required')}</p>
          ) : null}
        </div>

        <div className="space-y-2">
          <Label htmlFor="professionalId">{t('labels.professional')}</Label>
          <Select
            value={professionalId}
            onValueChange={(v) =>
              setValue('professionalId', v, { shouldValidate: true })
            }
            disabled={!serviceId}
          >
            <SelectTrigger id="professionalId">
              <SelectValue
                placeholder={t('placeholders.selectProfessional')}
              />
            </SelectTrigger>
            <SelectContent>
              {availableProfessionals.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {!serviceId ? (
            <p className="text-xs text-gray-500">
              {t('hints.selectServiceFirst')}
            </p>
          ) : null}
          {errors.professionalId ? (
            <p className="text-sm text-red-600">{t('errors.required')}</p>
          ) : null}
        </div>
      </section>

      {/* Sección 2 — Horario */}
      <section className="space-y-3">
        <SectionHeader
          icon={Calendar}
          title={t('sections.slot.title')}
          description={t('sections.slot.description')}
        />

        <div className="space-y-2">
          <Label className="sr-only">{t('labels.slot')}</Label>
          {!serviceId || !professionalId ? (
            <p className="text-sm text-gray-500">{t('chooseCombination')}</p>
          ) : slotsLoading ? (
            <SlotsSkeleton ariaLabel={t('loadingSlotsAria')} />
          ) : slotsError ? (
            <p className="text-sm text-red-600">{slotsError}</p>
          ) : slots.length === 0 ? (
            // Empty state con CTAs — no dejar al paciente en un callejón.
            // "Probar próxima semana" = bump a 14 días (útil si la clínica
            // está muy ocupada). "Cambiar profesional" sólo si hay ≥2 opciones.
            <div className="rounded-md border border-gray-200 bg-gray-50 p-4 text-center">
              <p className="text-sm text-gray-700">{t('emptyDescription')}</p>
              <div className="mt-3 flex flex-wrap justify-center gap-2">
                {!expandedRange ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={handleNextWeek}
                    className="border-brand-600 text-brand-700 hover:bg-brand-50"
                  >
                    {t('tryNextWeek')}
                  </Button>
                ) : null}
                {hasMultipleProfessionals ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={handleChangeProfessional}
                  >
                    {t('tryOtherProfessional')}
                  </Button>
                ) : null}
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              {groupedSlots.map((group) => (
                <div key={group.dayLabel}>
                  <p className="mb-2 text-sm font-semibold text-gray-700">
                    {group.dayLabel}
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {group.slots.map((slot) => {
                      const time = formatSlotTime(
                        slot.startAt,
                        timezone,
                        locale,
                      );
                      const isSelected = selectedSlot === slot.startAt;
                      return (
                        <button
                          key={slot.startAt}
                          type="button"
                          data-slot
                          aria-pressed={isSelected}
                          // Deshabilitar TODOS los slots durante submit — evita
                          // que el paciente cambie de slot mid-flight y termine
                          // con estado inconsistente cliente/servidor.
                          disabled={submitting}
                          onClick={() => setValue('startAtISO', slot.startAt)}
                          className={`rounded-md border px-3 py-2 text-sm font-medium transition-all focus:outline-none focus:ring-2 focus:ring-brand-500 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60 ${
                            isSelected
                              ? // bg-brand-600 sobre text-white = 4.83:1 → WCAG AA
                                // (bg-brand-500 daba 2.83:1 → falla). Outline extra
                                // para daltónicos: no dependemos sólo del color.
                                'border-brand-700 bg-brand-600 text-white shadow-sm outline outline-2 outline-offset-2 outline-brand-700'
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
      </section>

      {/* Sección 3 — Datos del paciente */}
      <section className="space-y-4">
        <SectionHeader
          icon={User}
          title={t('sections.patient.title')}
          description={t('sections.patient.description')}
        />

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
          <Label htmlFor="notes" className="flex items-center gap-1.5">
            <MessageSquare
              className="h-3.5 w-3.5 text-gray-400"
              aria-hidden="true"
            />
            {t('labels.notes')}
          </Label>
          <Textarea
            id="notes"
            placeholder={t('placeholders.notes')}
            {...register('notes')}
          />
        </div>
      </section>

      {/* Consent + submit */}
      <div className="space-y-4 border-t border-gray-100 pt-4">
        <div className="flex items-start gap-3">
          {/*
            Radix Checkbox shadcn — controlled via watch/setValue porque rhf
            register() no funciona con Radix (asume checkbox nativo con
            `event.target.checked`). Wire consent → boolean estricto.
          */}
          <Checkbox
            id="consent"
            checked={consent === true}
            onCheckedChange={(v) =>
              setValue('consent', v === true ? true : (undefined as never), {
                shouldValidate: true,
              })
            }
            className="mt-0.5"
          />
          <Label
            htmlFor="consent"
            className="cursor-pointer text-sm font-normal leading-relaxed text-gray-700"
          >
            {t('labels.consent')}
          </Label>
        </div>
        {errors.consent ? (
          <p className="text-sm text-red-600">{t('errors.consent')}</p>
        ) : null}

        {submitError ? (
          // role="alert" + aria-live="assertive" → screen readers anuncian el
          // error como interrupción. WCAG 4.1.3 (Status Messages). Antes era
          // un <div> sin rol y NVDA/VoiceOver no lo anunciaban.
          <div
            role="alert"
            aria-live="assertive"
            className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-900"
          >
            {submitError}
          </div>
        ) : null}

        <Button
          type="submit"
          disabled={submitting}
          className="w-full"
          size="lg"
        >
          {submitting ? (
            <span className="flex items-center justify-center gap-2">
              <SubmitSpinner />
              {t('submitting')}
            </span>
          ) : (
            t('submit')
          )}
        </Button>
      </div>
    </form>
  );
}
