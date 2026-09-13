'use client';

import { track } from '@/lib/analytics';

import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Calendar, MessageSquare, Stethoscope, User } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/routing';
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
import { Textarea } from '@/components/ui/textarea';
import {
  createAppointment,
  type CreateAppointmentPayload,
  type CreateAppointmentResponse,
} from '@/lib/api';
import { formatSlotTime } from './slot-format';
import { useScheduleSelection } from './ScheduleSelection';
import { SlotPicker } from './SlotPicker';

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

/**
 * Prefill del form cuando el paciente llegó desde el link WA `?t=<token>`.
 *
 * - `token`: viaja tal cual al POST para que el backend consuma la sesión y
 *   ate la cita a la Conversation origen.
 * - `phoneEditable`: `false` (default) → el input phone queda readonly con
 *   el valor pre-cargado. Evita que el paciente cambie el número y rompa el
 *   linkeo WA↔cita. `true` cuando el bot no conocía el teléfono (Conversation
 *   llegó como `@lid`) — el input queda editable como required normal.
 */
export interface SchedulePrefill {
  token: string;
  name: string;
  phone: string;
  phoneEditable: boolean;
}

interface ScheduleFormProps {
  clinicSlug: string;
  timezone: string;
  services: Service[];
  professionals: Professional[];
  locale: string;
  prefill?: SchedulePrefill;
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
  step,
  title,
  description,
}: {
  icon: React.ComponentType<{ className?: string; 'aria-hidden'?: boolean }>;
  /** Etiqueta "Paso N de 3" — indicador visual, no es un wizard. */
  step: string;
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
        <h2 className="text-sm font-semibold text-gray-900">
          <span className="font-medium text-brand-700">{step}</span>
          <span aria-hidden="true" className="mx-1.5 text-gray-300">
            ·
          </span>
          {title}
        </h2>
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
 * - Cuando cambian serviceId y professionalId, `SlotPicker` pide calendario y horas.
 * - `professional` se filtra por `service.professionals` (multi-tenant cliente).
 * - `honeypot` está en el DOM pero oculto con `sr-only` y `aria-hidden` +
 *   `tabIndex={-1}` para que humanos no lo llenen y assistive tech lo ignore.
 * - Horario: `SlotPicker` (calendario de días con hueco + horas del día).
 * - 409 → refetch de calendario y horas + mensaje de "elige otro" + foco al
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
  const { clinicSlug, timezone, services, professionals, locale, prefill } =
    props;
  const t = useTranslations('form');
  const router = useRouter();
  const qc = useQueryClient();
  const { setSelection } = useScheduleSelection();

  // El teléfono va readonly solo cuando el prefill vino con phone conocido
  // (`phoneEditable === false`). En el caso @lid el phone viene vacío y
  // `phoneEditable === true` → input editable como required normal.
  const phoneReadOnly = Boolean(prefill && !prefill.phoneEditable);

  const {
    register,
    handleSubmit,
    watch,
    setValue,
    formState: { errors, isSubmitting },
  } = useForm<ScheduleFormValues>({
    resolver: zodResolver(scheduleSchema),
    defaultValues: {
      name: prefill?.name ?? '',
      phone: prefill?.phone ?? '',
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

  // Publica la elección actual (etiquetas ya formateadas) para el resumen de
  // la sidebar. Sin PII: nombres de servicio/profesional son datos públicos.
  useEffect(() => {
    const service = services.find((s) => s.id === serviceId)?.name ?? null;
    const professional =
      professionals.find((p) => p.id === professionalId)?.name ?? null;
    const when = selectedSlot
      ? new Intl.DateTimeFormat(locale, {
          timeZone: timezone,
          weekday: 'short',
          day: '2-digit',
          month: 'short',
          hour: '2-digit',
          minute: '2-digit',
          hourCycle: 'h23',
        }).format(new Date(selectedSlot))
      : null;
    setSelection({ service, professional, when });
  }, [
    serviceId,
    professionalId,
    selectedSlot,
    services,
    professionals,
    locale,
    timezone,
    setSelection,
  ]);

  /**
   * Tras un 409 el horario elegido ya no existe: se invalidan el calendario y
   * las horas de la clínica (todos los días cacheados), no solo el día actual,
   * porque ese día pudo quedarse sin huecos.
   */
  const refetchSlots = useCallback(async () => {
    setValue('startAtISO', '');
    await Promise.all([
      qc.invalidateQueries({ queryKey: ['availability', clinicSlug] }),
      qc.invalidateQueries({ queryKey: ['availability-days', clinicSlug] }),
    ]);
  }, [qc, clinicSlug, setValue]);

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
      // Token del link WA (undefined si el paciente entró por link público).
      token: prefill?.token,
    });

    if (result.ok) {
      track('appointment_created', {
        clinic: clinicSlug,
        source: prefill?.token ? 'whatsapp' : 'web',
      });
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
      //
      // El `manageUrl` viaja por el mismo canal y por una razón más fuerte: es
      // un token bearer. En la query string quedaría en el Referer, en el
      // historial y en los logs del CDN, y con él cualquiera puede cancelar la
      // cita. Puede no venir (si Redis falló el backend crea la cita igual sin
      // emitir token), y entonces /gracias simplemente no muestra el bloque.
      if (typeof window !== 'undefined') {
        try {
          const firstName = values.name.trim().split(/\s+/)[0] ?? '';
          window.sessionStorage.setItem('agz.thanks.name', firstName);
          if (result.data.manageUrl) {
            window.sessionStorage.setItem(
              'agz.thanks.manageUrl',
              result.data.manageUrl,
            );
          }
        } catch {
          // sessionStorage puede fallar en modo privado / algunas WebViews.
          // No es crítico — la página /gracias muestra un fallback.
        }
      }
      // start/end (ISO) alimentan el .ics; service/professional son IDs
      // públicos de la clínica que /gracias resuelve a nombre; appt es el id
      // opaco de la cita (UID estable del .ics). Sin PII.
      const qs = new URLSearchParams({
        date: dateFmt,
        time: timeFmt,
        start: startISO,
        end: result.data.endAt,
        appt: result.data.id,
        service: values.serviceId,
        professional: values.professionalId,
      });
      router.push(`/${locale}/agendar/${clinicSlug}/gracias?${qs.toString()}`);
      return;
    }

    if (result.status === 409) {
      setSubmitError(t('errors.slotTaken'));
      // El slot elegido ya no existe: lo soltamos ANTES del refetch para que
      // el roving tabindex vuelva al primer radio (si quedara apuntando a un
      // startAt ausente, todos los radios tendrían tabIndex=-1).
      setValue('startAtISO', '');
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
          step={t('steps.label', { step: 1, total: 3 })}
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
          step={t('steps.label', { step: 2, total: 3 })}
          title={t('sections.slot.title')}
          description={t('sections.slot.description')}
        />

        <div className="space-y-2">
          {!serviceId || !professionalId ? (
            <p className="text-sm text-gray-500">{t('chooseCombination')}</p>
          ) : (
            <SlotPicker
              clinicSlug={clinicSlug}
              serviceId={serviceId}
              professionalId={professionalId}
              timezone={timezone}
              locale={locale}
              selected={selectedSlot || null}
              onSelect={(startAt) => {
                setValue('startAtISO', startAt);
                track('slot_selected', { clinic: clinicSlug });
              }}
              // Deshabilitar TODOS los slots durante submit — evita que el
              // paciente cambie de slot mid-flight y termine con estado
              // inconsistente cliente/servidor.
              disabled={submitting}
              empty={
                // Empty state con CTA — no dejar al paciente en un callejón.
                <div className="rounded-md border border-gray-200 bg-gray-50 p-4 text-center">
                  <p className="text-sm text-gray-700">{t('emptyDescription')}</p>
                  {hasMultipleProfessionals ? (
                    <div className="mt-3 flex flex-wrap justify-center gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={handleChangeProfessional}
                      >
                        {t('tryOtherProfessional')}
                      </Button>
                    </div>
                  ) : null}
                </div>
              }
            />
          )}
          {errors.startAtISO ? (
            <p id="slot-error" className="text-sm text-red-600">
              {t('errors.slotRequired')}
            </p>
          ) : null}
        </div>
      </section>

      {/* Sección 3 — Datos del paciente */}
      <section className="space-y-4">
        <SectionHeader
          icon={User}
          step={t('steps.label', { step: 3, total: 3 })}
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
            readOnly={phoneReadOnly}
            aria-readonly={phoneReadOnly}
            // `readOnly` no cambia el color por default — bajamos opacidad y
            // cursor para señalizar visualmente que no es editable. Se sigue
            // pudiendo copiar/paste (a diferencia de `disabled`, que además
            // sacaría el valor del submit).
            className={
              phoneReadOnly
                ? 'bg-gray-50 text-gray-600 cursor-not-allowed'
                : undefined
            }
            {...register('phone')}
          />
          <p className="text-xs text-gray-500">
            {phoneReadOnly ? t('hints.phoneFromWhatsapp') : t('hints.phone')}
          </p>
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
            {/* ADR 0004 §7: el consent nombra explícitamente a los proveedores
                de IA de terceros y linkea a /seguridad. */}
            {t.rich('labels.consent', {
              link: (chunks) => (
                <Link
                  href="/seguridad"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline underline-offset-2 hover:text-gray-900"
                >
                  {chunks}
                </Link>
              ),
            })}
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
