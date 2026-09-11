'use client';

import { useQuery } from '@tanstack/react-query';
import {
  AlertCircle,
  CalendarClock,
  CalendarCheck2,
  CheckCircle2,
  Loader2,
  MapPin,
  Stethoscope,
  User,
} from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import {
  cancelManagedAppointment,
  fetchAvailability,
  rescheduleManagedAppointment,
  type AppointmentStatus,
  type ManagedAppointmentData,
  type Slot,
} from '@/lib/api';
import { todayStartInTZ } from '@/lib/utils';
import {
  formatAppointmentWhen,
  formatSlotTime,
  groupSlotsByDay,
} from '../slot-format';

interface Props {
  clinicSlug: string;
  locale: string;
  token: string;
  initial: ManagedAppointmentData;
}

/** Estados en los que la cita ya no admite gestión. */
const CLOSED_STATUSES: ReadonlySet<AppointmentStatus> = new Set([
  'CANCELADA',
  'ATENDIDA',
  'NO_SHOW',
]);

/**
 * Estados que sabemos traducir. Se comprueba antes de llamar a `t()` porque
 * next-intl tipa las claves y no tiene fallback: un estado inesperado
 * renderizaría un error en medio de la página.
 */
const KNOWN_STATUSES = [
  'PENDIENTE',
  'CONFIRMADA',
  'EN_RIESGO',
  'ATENDIDA',
  'CANCELADA',
  'NO_SHOW',
] as const;

type KnownStatus = (typeof KNOWN_STATUSES)[number];

function isKnownStatus(status: string): status is KnownStatus {
  return (KNOWN_STATUSES as readonly string[]).includes(status);
}

/**
 * Gestión de la cita: ver, cancelar y cambiar horario.
 *
 * Decisiones que no se ven en el código:
 *
 * - `canCancel`/`canReschedule` del GET son una **pista para pintar la UI, no
 *   una garantía**: la clínica puede marcar la cita ATENDIDA entre que se
 *   renderiza la página y el clic. Por eso el 409 se maneja igual en las dos
 *   acciones, y al recibirlo pedimos la verdad al server en vez de adivinarla.
 * - Reagendar es **in-place**: el `id` de la cita no cambia. El éxito se
 *   detecta por el 200 y el nuevo `startAtISO`, nunca comparando ids.
 * - El token viejo se invalida al reagendar. Si no conseguimos uno nuevo, la
 *   página queda inservible en cuanto se recargue: lo decimos y **bloqueamos
 *   las acciones**, en vez de dejar botones que sólo pueden dar 404.
 * - El backend limita a 10/min por slug+ip: nada de polling ni reintentos
 *   automáticos (`retry: false`).
 */
export function ManageAppointmentClient({
  clinicSlug,
  locale,
  token,
  initial,
}: Props) {
  const t = useTranslations('manage');
  const router = useRouter();

  const [data, setData] = useState(initial);
  const [activeToken, setActiveToken] = useState(token);
  const [mode, setMode] = useState<'view' | 'reschedule'>('view');
  const [confirmCancelOpen, setConfirmCancelOpen] = useState(false);
  const [pendingSlot, setPendingSlot] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [linkLost, setLinkLost] = useState(false);
  const feedbackRef = useRef<HTMLDivElement>(null);

  /**
   * El server component es la fuente de verdad. React conserva el state del
   * client entre re-renders del server, así que sin esto un `router.refresh()`
   * (el que disparamos tras un 409) no cambiaría NADA en pantalla: diríamos
   * "actualizamos la página" mostrando los datos viejos.
   */
  useEffect(() => {
    setData(initial);
  }, [initial]);

  useEffect(() => {
    setActiveToken(token);
  }, [token]);

  const { appointment, clinic, patient } = data;
  const { timezone } = clinic;
  const closed = CLOSED_STATUSES.has(appointment.status);
  const canCancel = data.canCancel && !closed && !linkLost;
  const canReschedule = data.canReschedule && !closed && !linkLost;

  const whenLabel = useMemo(
    () => formatAppointmentWhen(appointment.startAtISO, timezone, locale),
    [appointment.startAtISO, timezone, locale],
  );

  /** Mueve el foco al banner para que un lector de pantalla lo anuncie. */
  const focusFeedback = useCallback(() => {
    feedbackRef.current?.focus();
    feedbackRef.current?.scrollIntoView({ block: 'nearest' });
  }, []);

  // `from` en la TZ de la clínica, NUNCA la del navegador: con
  // `new Date().toISOString()` un paciente en Caracas a las 21:00 pediría los
  // slots de mañana y perdería los de hoy. Mismo helper que usa ScheduleForm.
  const fromDay = todayStartInTZ(timezone);

  const slotsQuery = useQuery({
    queryKey: [
      'manage-availability',
      clinicSlug,
      appointment.serviceId,
      appointment.professionalId,
      fromDay,
    ],
    enabled: mode === 'reschedule',
    retry: false,
    queryFn: () =>
      fetchAvailability(clinicSlug, {
        serviceId: appointment.serviceId,
        professionalId: appointment.professionalId,
        from: fromDay,
        days: 14,
      }),
  });

  const slots: Slot[] = slotsQuery.data ?? [];
  const grouped = useMemo(
    () => groupSlotsByDay(slots, timezone, locale),
    [slots, timezone, locale],
  );

  /**
   * Traduce los códigos que el contrato distingue. El 404 merece su propio
   * mensaje: significa que el token murió, y "inténtalo de nuevo" invitaría a
   * un reintento que no puede funcionar nunca.
   */
  function messageForStatus(status: number): string {
    if (status === 409) return t('errors.conflict');
    if (status === 429) return t('errors.rateLimit');
    if (status === 404) return t('errors.linkExpired');
    return t('errors.generic');
  }

  async function onCancel() {
    setError(null);
    setBusy(true);
    const res = await cancelManagedAppointment(clinicSlug, activeToken);
    setBusy(false);
    // Cerrar es responsabilidad del caller: `ConfirmDialog` hace
    // `preventDefault` para poder mostrar el estado "…". Si no cerráramos, el
    // banner de error quedaría detrás del overlay y el botón de confirmar
    // volvería a estar activo sobre una cita ya cancelada.
    setConfirmCancelOpen(false);

    if (res.ok) {
      setData((prev) => ({
        ...prev,
        appointment: { ...prev.appointment, status: res.data.status },
        canCancel: false,
        canReschedule: false,
      }));
      setMode('view');
      setNotice(t('cancel.success'));
      focusFeedback();
      return;
    }

    setError(messageForStatus(res.status));
    if (res.status === 404) setLinkLost(true);
    // Tras un 409 no inventamos el estado nuevo: lo pedimos al server, y el
    // efecto de arriba lo baja al state.
    if (res.status === 409) router.refresh();
    focusFeedback();
  }

  async function onConfirmReschedule() {
    const startAtISO = pendingSlot;
    if (!startAtISO) return;

    setError(null);
    setBusy(true);
    const res = await rescheduleManagedAppointment(
      clinicSlug,
      activeToken,
      startAtISO,
    );
    setBusy(false);
    setPendingSlot(null);

    if (!res.ok) {
      // Los dos 409 posibles piden respuestas OPUESTAS, así que no se pueden
      // tratar igual: con el slot ocupado hay que devolver al paciente al
      // selector, y con el cupo agotado hay que quitárselo — insistir con otro
      // horario no lleva a ningún lado, y decirle "ese horario ya no está
      // disponible" sería además falso.
      //
      // Se distingue por `code` y no por el texto: el copy se reescribe por
      // tono y por traducción. Si el backend no lo manda (anterior a #73), el
      // 409 se sigue leyendo como slot ocupado, que es el caso frecuente.
      const limitReached = res.status === 409 && res.code === 'RESCHEDULE_LIMIT';

      if (limitReached) {
        setError(t('reschedule.limitReached'));
        setData((prev) => ({ ...prev, canReschedule: false }));
        setMode('view');
      } else {
        setError(
          res.status === 409
            ? t('reschedule.slotTaken')
            : messageForStatus(res.status),
        );
        // El slot se ocupó mientras elegía: recargamos la disponibilidad para
        // no dejarle a la vista un horario que ya no existe.
        if (res.status === 409) void slotsQuery.refetch();
      }
      if (res.status === 404) setLinkLost(true);
      focusFeedback();
      return;
    }

    // El POST ya nos dice si al paciente le queda cupo, así que actualizamos
    // `canReschedule` con eso en vez de pedir otra vez el GET. Sin esto, quien
    // acaba de gastar su último cambio seguiría viendo el botón y sólo se
    // enteraría al elegir un horario y comerse el rechazo.
    // Ojo: la cita vuelve a PENDIENTE, el backend limpia `confirmedAt`.
    const spent = res.data.canReschedule === false;
    setData((prev) => ({
      ...prev,
      appointment: res.data.appointment,
      canReschedule: res.data.canReschedule ?? prev.canReschedule,
    }));
    setMode('view');
    setNotice(
      spent ? t('reschedule.successLastOne') : t('reschedule.success'),
    );
    // La foto de disponibilidad quedó vieja (su slot nuevo figura libre y el
    // viejo ocupado). Sin esto, reabrir "cambiar horario" dentro del staleTime
    // muestra datos que ya no son ciertos.
    void slotsQuery.refetch();

    // El token viejo ya no vale. Con uno nuevo reescribimos la URL —vía router,
    // para que el server component rehidrate con él— y así un refresh sigue
    // funcionando. Si no lo conseguimos, la cita SÍ se movió, pero la página
    // muere al recargar: hay que decirlo y bloquear las acciones.
    const fresh = extractToken(res.data.manageUrl);
    if (fresh) {
      setLinkLost(false);
      setActiveToken(fresh);
      router.replace(`?t=${encodeURIComponent(fresh)}`, { scroll: false });
    } else {
      setLinkLost(true);
    }
    focusFeedback();
  }

  const summaryRows = [
    { key: 'service', Icon: Stethoscope, value: appointment.serviceName },
    { key: 'professional', Icon: User, value: appointment.professionalName },
    { key: 'when', Icon: CalendarClock, value: whenLabel },
    { key: 'address', Icon: MapPin, value: clinic.address },
  ] as const;

  const pendingSlotLabel = pendingSlot
    ? formatAppointmentWhen(pendingSlot, timezone, locale)
    : '';

  return (
    <div className="space-y-4">
      <header>
        <h1 className="text-2xl font-bold tracking-tight text-gray-900 md:text-3xl">
          {t('title')}
        </h1>
        <p className="mt-1 text-sm text-gray-600">
          {t('subtitle', { clinic: clinic.name, name: patient.name })}
        </p>
      </header>

      {/* `tabIndex={-1}` para poder enfocarlo tras cada acción y que un lector
          de pantalla lo anuncie. El `role="alert"` del error va FUERA del
          `aria-live` para no duplicar el anuncio. */}
      <div ref={feedbackRef} tabIndex={-1} className="space-y-2 outline-none">
        <div aria-live="polite">
          {notice ? (
            <div className="flex items-start gap-2 rounded-lg border border-green-200 bg-green-50 p-3 text-sm text-green-800">
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              <p>{notice}</p>
            </div>
          ) : null}
        </div>
        {error ? (
          <div
            role="alert"
            className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800"
          >
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            <p>{error}</p>
          </div>
        ) : null}
        {linkLost ? (
          <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
            {t('reschedule.linkLost')}
          </div>
        ) : null}
      </div>

      <Card className="shadow-sm">
        <CardContent className="p-6">
          <dl className="space-y-3">
            {summaryRows.map(({ key, Icon, value }) =>
              value ? (
                <div key={key} className="flex items-start gap-3">
                  <Icon
                    className="mt-0.5 h-4 w-4 shrink-0 text-gray-400"
                    aria-hidden="true"
                  />
                  <div className="min-w-0">
                    <dt className="text-xs text-gray-500">{t(`summary.${key}`)}</dt>
                    <dd className="font-medium text-gray-900">{value}</dd>
                  </div>
                </div>
              ) : null,
            )}
          </dl>

          <p className="mt-4 border-t border-gray-100 pt-4 text-xs text-gray-500">
            {t('statusLabel')}:{' '}
            <span className="font-medium text-gray-700">
              {isKnownStatus(appointment.status)
                ? t(`status.${appointment.status}`)
                : appointment.status}
            </span>
          </p>
        </CardContent>
      </Card>

      {closed ? (
        <Card className="shadow-sm">
          <CardContent className="p-6 text-sm text-gray-600">
            <p>{t('closed')}</p>
          </CardContent>
        </Card>
      ) : mode === 'view' ? (
        <div className="flex flex-col gap-2 sm:flex-row">
          {canReschedule ? (
            <Button
              type="button"
              onClick={() => {
                setError(null);
                setNotice(null);
                setMode('reschedule');
              }}
              className="sm:flex-1"
            >
              <CalendarCheck2 className="mr-2 h-4 w-4" aria-hidden="true" />
              {t('reschedule.button')}
            </Button>
          ) : null}
          {canCancel ? (
            <Button
              type="button"
              variant="outline"
              onClick={() => setConfirmCancelOpen(true)}
              className="sm:flex-1"
            >
              {t('cancel.button')}
            </Button>
          ) : null}
        </div>
      ) : (
        <Card className="shadow-sm">
          <CardContent className="p-6">
            <div className="flex items-center justify-between gap-4">
              <h2 className="text-base font-semibold text-gray-900">
                {t('reschedule.title')}
              </h2>
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  setMode('view');
                  setError(null);
                  setNotice(null);
                }}
              >
                {t('reschedule.back')}
              </Button>
            </div>

            <div className="mt-4">
              {slotsQuery.isLoading ? (
                <p className="flex items-center gap-2 text-sm text-gray-500">
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                  {t('reschedule.loading')}
                </p>
              ) : slotsQuery.isError ? (
                <p className="text-sm text-red-600">{t('errors.generic')}</p>
              ) : grouped.length === 0 ? (
                <p className="text-sm text-gray-600">{t('reschedule.noSlots')}</p>
              ) : (
                <div className="space-y-4">
                  {grouped.map((group) => (
                    <div key={group.dayLabel}>
                      <p className="text-xs font-medium uppercase tracking-wide text-gray-500">
                        {group.dayLabel}
                      </p>
                      <div className="mt-2 flex flex-wrap gap-2">
                        {group.slots.map((slot) => {
                          const time = formatSlotTime(
                            slot.startAt,
                            timezone,
                            locale,
                          );
                          return (
                            <button
                              key={slot.startAt}
                              type="button"
                              // Mismo atributo que el picker de `ScheduleForm`
                              // (allí sin valor), para que `button[data-slot]`
                              // sirva de locator en los dos E2E.
                              data-slot={slot.startAt}
                              // Sin el día, un lector de pantalla oye una lista
                              // de horas sueltas sin saber de qué fecha son.
                              aria-label={`${group.dayLabel} ${time}`}
                              disabled={busy}
                              onClick={() => setPendingSlot(slot.startAt)}
                              className="inline-flex h-9 min-w-[4.5rem] items-center justify-center rounded-md border border-gray-300 bg-white px-3 text-sm font-medium text-gray-800 transition-colors hover:border-brand-500 hover:bg-brand-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1 disabled:cursor-not-allowed disabled:opacity-50"
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
            </div>
          </CardContent>
        </Card>
      )}

      <ConfirmDialog
        open={confirmCancelOpen}
        onClose={() => setConfirmCancelOpen(false)}
        onConfirm={onCancel}
        variant="destructive"
        title={t('cancel.confirmTitle')}
        description={t('cancel.confirmDescription', { when: whenLabel })}
        confirmLabel={t('cancel.confirmLabel')}
      />

      {/* Mover la cita libera el slot actual e invalida el link: es
          irreversible desde el lado del paciente, así que se confirma igual que
          cancelar. En móvil, un toque accidental en la lista de horarios no
          puede mover la cita. */}
      <ConfirmDialog
        open={pendingSlot !== null}
        onClose={() => setPendingSlot(null)}
        onConfirm={onConfirmReschedule}
        title={t('reschedule.confirmTitle')}
        description={t('reschedule.confirmDescription', {
          when: pendingSlotLabel,
        })}
        confirmLabel={t('reschedule.confirmLabel')}
      />
    </div>
  );
}

/**
 * Saca el `?t=` del `manageUrl`. Devuelve `null` ante cualquier problema —URL
 * relativa, sin token, malformada— y el caller lo trata igual que si el
 * backend no hubiera mandado link: avisar y bloquear. Tragarse el fallo en
 * silencio dejaría una página aparentemente sana con un token muerto.
 */
function extractToken(manageUrl: string | undefined): string | null {
  if (!manageUrl) return null;
  try {
    const base =
      typeof window === 'undefined' ? undefined : window.location.origin;
    return new URL(manageUrl, base).searchParams.get('t');
  } catch {
    return null;
  }
}
