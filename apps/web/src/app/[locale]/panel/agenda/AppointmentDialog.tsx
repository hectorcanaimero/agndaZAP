'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import { Calendar, Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
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
import { ApiError, apiMutation, apiQuery } from '@/lib/query-fn';
import { cn } from '@/lib/utils';

/**
 * Adelanta un ISO string N días manteniendo la hora local en la TZ dada.
 * Sin Luxon en el web (dep del backend); usamos Date + Intl y sumamos ms.
 * Preciso a segundos, suficiente para navegar por semanas en el picker.
 */
function shiftISOByDays(iso: string, days: number): string {
  const d = new Date(iso);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString();
}

/** Inicio del día en la TZ pasada, expresado en ISO UTC. */
function startOfDayInTZ(iso: string, timeZone: string): string {
  // Toma la fecha visible en la TZ (YYYY-MM-DD) y arma medianoche en esa TZ.
  // Aproximación aceptable: usamos la fecha calendaria y le sumamos T00 en UTC.
  // Para el picker basta con quedar en el mismo día calendario del usuario.
  const dayKey = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(iso));
  return `${dayKey}T00:00:00.000Z`;
}

/* ─────────────────────────── Types ─────────────────────────── */

export interface AppointmentDialogService {
  id: string;
  name: string;
  durationMin: number;
  active: boolean;
}

export interface AppointmentDialogProfessional {
  id: string;
  name: string;
  active: boolean;
  /** IDs de servicios que atiende. Filtramos el select de servicio al elegir profesional. */
  serviceIds: string[];
}

export interface AppointmentForReschedule {
  id: string;
  startAt: string;
  patient: { id: string; name: string; phone: string };
  service: { id: string; name: string; durationMin: number };
  professional: { id: string; name: string };
}

interface Slot {
  startAt: string;
  endAt: string;
}

type Mode = 'create' | 'reschedule';

interface BaseProps {
  open: boolean;
  onClose: () => void;
  onSuccess: () => void;
  locale: string;
  timezone: string;
}

type Props = BaseProps &
  (
    | {
        mode: 'create';
        services: AppointmentDialogService[];
        professionals: AppointmentDialogProfessional[];
        /** Fecha visible en la agenda al abrir el dialog (YYYY-MM-DD). Prefill del picker. */
        initialDate: string;
        appointment?: never;
      }
    | {
        mode: 'reschedule';
        appointment: AppointmentForReschedule;
        services?: never;
        professionals?: never;
        initialDate?: never;
      }
  );

/* ─────────────────────────── Component ─────────────────────────── */

/**
 * Dialog dual-mode:
 * - `create`: form completo (paciente + servicio + profesional + slot + consent).
 * - `reschedule`: slot picker con paciente/servicio/profesional readonly (para
 *   cambiar esos hay que crear una cita nueva; regla del backend).
 *
 * El slot picker fetchea `/api/appointments/slots` con 7 días desde `pickerFrom`.
 * En `reschedule`, pasa `excludeAppointmentId` para que el slot actual de la
 * propia cita no bloquee la reprogramación al mismo día/hora que ya tenía.
 */
export function AppointmentDialog(props: Props) {
  const t = useTranslations('panel.agenda.dialog');
  const tCommon = useTranslations('common');

  // Narrowing explícito: TS no propaga bien el discriminant a través del useMemo
  // ni las mutations. Extraemos locales una vez y trabajamos con ellos.
  const mode: Mode = props.mode;
  const appointment = props.mode === 'reschedule' ? props.appointment : null;
  const availableServicesInput =
    props.mode === 'create' ? props.services : [];
  const availableProfessionalsInput =
    props.mode === 'create' ? props.professionals : [];
  const initialDate = props.mode === 'create' ? props.initialDate : null;

  /* ─────── Form state ─────── */

  const [serviceId, setServiceId] = useState(appointment?.service.id ?? '');
  const [professionalId, setProfessionalId] = useState(
    appointment?.professional.id ?? '',
  );
  const [startAtISO, setStartAtISO] = useState<string>('');
  const [name, setName] = useState(appointment?.patient.name ?? '');
  const [phone, setPhone] = useState(appointment?.patient.phone ?? '');
  const [notes, setNotes] = useState('');
  const [consent, setConsent] = useState(false);
  const [honeypot, setHoneypot] = useState(''); // spam guard

  // Prefill del picker: create usa initialDate (día visible); reschedule usa el
  // día actual de la cita para que el operador vea el contexto natural.
  const pickerFromISO = useMemo(() => {
    const seed = appointment
      ? appointment.startAt
      : initialDate
        ? `${initialDate}T12:00:00.000Z`
        : new Date().toISOString();
    return startOfDayInTZ(seed, props.timezone);
  }, [appointment, initialDate, props.timezone]);

  const [pickerFrom, setPickerFrom] = useState(pickerFromISO);

  // Cuando cambian los props (ej. usuario abre reschedule sobre otra cita), reset.
  useEffect(() => {
    setPickerFrom(pickerFromISO);
    setStartAtISO('');
  }, [pickerFromISO]);

  /* ─────── Slot picker query ─────── */

  const canFetchSlots = Boolean(serviceId && professionalId && pickerFrom);
  const excludeId = appointment?.id;

  const slotsQuery = useQuery({
    queryKey: [
      'agenda-slots',
      serviceId,
      professionalId,
      pickerFrom,
      excludeId ?? null,
    ],
    queryFn: () => {
      const qs = new URLSearchParams({
        serviceId,
        professionalId,
        from: pickerFrom,
        days: '7',
      });
      if (excludeId) qs.set('excludeAppointmentId', excludeId);
      return apiQuery<Slot[]>(`/api/appointments/slots?${qs.toString()}`);
    },
    enabled: canFetchSlots,
    staleTime: 30_000,
  });

  // Reset del slot elegido si el usuario cambia service/prof (los slots viejos
  // ya no aplican al nuevo combo).
  useEffect(() => {
    setStartAtISO('');
  }, [serviceId, professionalId]);

  /* ─────── Mutations ─────── */

  const createMutation = useMutation({
    mutationFn: (payload: {
      phone: string;
      name: string;
      consent: true;
      serviceId: string;
      professionalId: string;
      startAtISO: string;
      notes?: string;
    }) =>
      apiMutation<unknown, typeof payload>(
        '/api/appointments',
        'POST',
        payload,
      ),
    onSuccess: () => {
      toast.success(t('createOk'));
      props.onSuccess();
      props.onClose();
    },
    onError: (err) => {
      if (err instanceof ApiError && err.status === 409) {
        toast.error(t('slotTakenReload'));
        // Slot ya no disponible — recargamos para que aparezcan los nuevos.
        void slotsQuery.refetch();
        setStartAtISO('');
        return;
      }
      toast.error(t('createFailed'));
    },
  });

  const rescheduleMutation = useMutation({
    mutationFn: (payload: { startAtISO: string }) =>
      apiMutation<unknown, typeof payload>(
        `/api/appointments/${appointment?.id ?? ''}/reschedule`,
        'PATCH',
        payload,
      ),
    onSuccess: () => {
      toast.success(t('rescheduleOk'));
      props.onSuccess();
      props.onClose();
    },
    onError: (err) => {
      if (err instanceof ApiError && err.status === 409) {
        toast.error(t('slotTakenReload'));
        void slotsQuery.refetch();
        setStartAtISO('');
        return;
      }
      toast.error(t('rescheduleFailed'));
    },
  });

  const busy = createMutation.isPending || rescheduleMutation.isPending;

  /* ─────── Servicios/profesionales cross-filter (solo modo create) ─────── */

  const availableServices = useMemo(() => {
    if (mode !== 'create') return [];
    if (!professionalId) return availableServicesInput.filter((s) => s.active);
    const prof = availableProfessionalsInput.find(
      (p) => p.id === professionalId,
    );
    if (!prof) return [];
    return availableServicesInput.filter(
      (s) => s.active && prof.serviceIds.includes(s.id),
    );
  }, [mode, availableServicesInput, availableProfessionalsInput, professionalId]);

  const availableProfessionals = useMemo(() => {
    if (mode !== 'create') return [];
    if (!serviceId) return availableProfessionalsInput.filter((p) => p.active);
    return availableProfessionalsInput.filter(
      (p) => p.active && p.serviceIds.includes(serviceId),
    );
  }, [mode, availableProfessionalsInput, serviceId]);

  /* ─────── Submit ─────── */

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    // Honeypot: si viene lleno, es bot — silenciamos sin toast (no dar señal).
    if (honeypot) return;
    if (!startAtISO) return;
    if (mode === 'create') {
      // Validación mínima cliente. El backend re-valida con el DTO (source of truth).
      if (!name.trim() || name.trim().length < 2) {
        toast.error(t('errName'));
        return;
      }
      if (!/^\+?[1-9]\d{7,14}$/.test(phone.trim())) {
        toast.error(t('errPhone'));
        return;
      }
      if (!serviceId || !professionalId) {
        toast.error(t('errServiceOrProfessional'));
        return;
      }
      if (!consent) {
        toast.error(t('errConsent'));
        return;
      }
      createMutation.mutate({
        phone: phone.trim(),
        name: name.trim(),
        consent: true,
        serviceId,
        professionalId,
        startAtISO,
        notes: notes.trim() || undefined,
      });
    } else {
      rescheduleMutation.mutate({ startAtISO });
    }
  }

  /* ─────── Slot rendering ─────── */

  const slots = slotsQuery.data ?? [];

  const groupedSlots = useMemo(() => {
    const byDay = new Map<string, { label: string; slots: Slot[] }>();
    const dayLabelFmt = new Intl.DateTimeFormat(props.locale, {
      timeZone: props.timezone,
      weekday: 'short',
      day: '2-digit',
      month: 'short',
    });
    const keyFmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: props.timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    for (const s of slots) {
      const d = new Date(s.startAt);
      const key = keyFmt.format(d);
      const bucket = byDay.get(key) ?? {
        label: dayLabelFmt.format(d),
        slots: [],
      };
      bucket.slots.push(s);
      byDay.set(key, bucket);
    }
    return Array.from(byDay.entries()).map(([key, v]) => ({ key, ...v }));
  }, [slots, props.locale, props.timezone]);

  const timeFmt = useMemo(
    () =>
      new Intl.DateTimeFormat(props.locale, {
        timeZone: props.timezone,
        hour: '2-digit',
        minute: '2-digit',
      }),
    [props.locale, props.timezone],
  );

  function shiftPickerWeek(dir: -1 | 1) {
    setPickerFrom(shiftISOByDays(pickerFrom, dir * 7));
  }

  /* ─────── Render ─────── */

  return (
    <Dialog
      open={props.open}
      onOpenChange={(o) => {
        if (!o && !busy) props.onClose();
      }}
    >
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {mode === 'create' ? t('createTitle') : t('rescheduleTitle')}
          </DialogTitle>
        </DialogHeader>

        <form onSubmit={onSubmit} className="space-y-4">
          {/* Honeypot invisible — bots suelen llenar todos los input */}
          <input
            type="text"
            tabIndex={-1}
            autoComplete="off"
            aria-hidden="true"
            value={honeypot}
            onChange={(e) => setHoneypot(e.target.value)}
            className="sr-only"
          />

          {mode === 'create' ? (
            <>
              {/* Paciente */}
              <div className="grid gap-2 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="ap-name">{t('patientName')}</Label>
                  <Input
                    id="ap-name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    minLength={2}
                    maxLength={80}
                    required
                    disabled={busy}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="ap-phone">{t('patientPhone')}</Label>
                  <Input
                    id="ap-phone"
                    type="tel"
                    inputMode="tel"
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    placeholder="+54 9 11 5555 5555"
                    required
                    disabled={busy}
                  />
                </div>
              </div>

              {/* Servicio + Profesional */}
              <div className="grid gap-2 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="ap-service">{t('service')}</Label>
                  <Select
                    value={serviceId}
                    onValueChange={setServiceId}
                    disabled={busy}
                  >
                    <SelectTrigger id="ap-service">
                      <SelectValue placeholder={t('servicePlaceholder')} />
                    </SelectTrigger>
                    <SelectContent>
                      {availableServices.map((s) => (
                        <SelectItem key={s.id} value={s.id}>
                          {s.name} · {s.durationMin} min
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="ap-professional">{t('professional')}</Label>
                  <Select
                    value={professionalId}
                    onValueChange={setProfessionalId}
                    disabled={busy}
                  >
                    <SelectTrigger id="ap-professional">
                      <SelectValue
                        placeholder={t('professionalPlaceholder')}
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
                </div>
              </div>

              {/* Notas */}
              <div className="space-y-1.5">
                <Label htmlFor="ap-notes">
                  {t('notes')}{' '}
                  <span className="text-xs text-muted-foreground">
                    ({t('optional')})
                  </span>
                </Label>
                <Textarea
                  id="ap-notes"
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  maxLength={500}
                  rows={2}
                  disabled={busy}
                />
              </div>
            </>
          ) : (
            appointment && (
              /* Reschedule: paciente/servicio/profesional readonly */
              <div className="rounded-md border border-border bg-muted/40 p-3 text-sm">
                <p className="font-medium text-foreground">
                  {appointment.patient.name}
                </p>
                <p className="tabular-nums text-muted-foreground">
                  {appointment.patient.phone}
                </p>
                <p className="mt-2 text-muted-foreground">
                  {appointment.service.name} ·{' '}
                  {appointment.service.durationMin} min ·{' '}
                  {appointment.professional.name}
                </p>
              </div>
            )
          )}

          {/* Slot picker */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label className="flex items-center gap-1.5">
                <Calendar className="h-4 w-4" aria-hidden="true" />
                {t('slotPickerLabel')}
              </Label>
              <div className="flex items-center gap-1">
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => shiftPickerWeek(-1)}
                  disabled={busy || slotsQuery.isFetching}
                >
                  ‹ {t('prevWeek')}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => shiftPickerWeek(1)}
                  disabled={busy || slotsQuery.isFetching}
                >
                  {t('nextWeek')} ›
                </Button>
              </div>
            </div>

            {!canFetchSlots ? (
              <p className="rounded-md border border-dashed border-border p-3 text-center text-xs text-muted-foreground">
                {t('slotsHint')}
              </p>
            ) : slotsQuery.isLoading ? (
              <div className="space-y-2">
                <Skeleton className="h-16 w-full" />
                <Skeleton className="h-16 w-full" />
              </div>
            ) : slotsQuery.isError ? (
              <p className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-center text-xs text-destructive">
                {t('slotsError')}
              </p>
            ) : groupedSlots.length === 0 ? (
              <p className="rounded-md border border-dashed border-border p-3 text-center text-xs text-muted-foreground">
                {t('noSlots')}
              </p>
            ) : (
              <div
                className="max-h-64 space-y-3 overflow-y-auto rounded-md border border-border p-2"
                role="listbox"
                aria-label={t('slotPickerLabel')}
              >
                {groupedSlots.map((day) => (
                  <div key={day.key}>
                    <p className="mb-1 text-xs font-medium capitalize text-muted-foreground">
                      {day.label}
                    </p>
                    <div className="flex flex-wrap gap-1.5">
                      {day.slots.map((s) => {
                        const selected = s.startAt === startAtISO;
                        return (
                          <button
                            key={s.startAt}
                            type="button"
                            role="option"
                            aria-selected={selected}
                            disabled={busy}
                            onClick={() => setStartAtISO(s.startAt)}
                            className={cn(
                              'rounded-md border px-2 py-1 text-xs tabular-nums transition-colors',
                              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                              selected
                                ? 'border-brand-600 bg-brand-600 text-white'
                                : 'border-border bg-background hover:bg-accent hover:text-accent-foreground',
                            )}
                          >
                            {timeFmt.format(new Date(s.startAt))}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Consent (solo create) */}
          {mode === 'create' && (
            <div className="flex items-start gap-2 rounded-md border border-border bg-muted/40 p-3">
              <Checkbox
                id="ap-consent"
                checked={consent}
                onCheckedChange={(v) => setConsent(v === true)}
                disabled={busy}
                aria-required="true"
              />
              <Label
                htmlFor="ap-consent"
                className="text-xs font-normal leading-snug"
              >
                {t('consentLabel')}
              </Label>
            </div>
          )}

          {/* Actions */}
          <div className="flex justify-end gap-2 border-t border-border pt-3">
            <Button
              type="button"
              variant="outline"
              onClick={props.onClose}
              disabled={busy}
            >
              {tCommon('cancel')}
            </Button>
            <Button type="submit" disabled={busy || !startAtISO}>
              {busy ? (
                <>
                  <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                  {t('submitting')}
                </>
              ) : mode === 'create' ? (
                t('createSubmit')
              ) : (
                t('rescheduleSubmit')
              )}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
