'use client';

import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { Badge, type AppointmentStatus } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import { Select } from '@/components/ui/select';
import { useToast } from '@/components/ui/toast';
import { fetcher } from '@/lib/auth';
import { cn } from '@/lib/utils';

interface Appointment {
  id: string;
  startAt: string;
  endAt: string;
  status: AppointmentStatus;
  patient: { id: string; name: string; phone: string };
  service: { id: string; name: string; durationMin: number };
  professional: { id: string; name: string };
}

interface Professional {
  id: string;
  name: string;
}

interface AgendaClientProps {
  locale: string;
  date: string;
  view: 'day' | 'week';
  professionalId: string;
  status: string;
  appointments: Appointment[];
  professionals: Professional[];
}

/**
 * FSM válida — coincide con `assertTransition` del backend. Si el backend
 * agrega/quita transiciones, sincronizar acá.
 */
const TRANSITIONS: Record<AppointmentStatus, AppointmentStatus[]> = {
  PENDIENTE: ['CONFIRMADA', 'CANCELADA'],
  CONFIRMADA: ['ATENDIDA', 'CANCELADA', 'NO_SHOW'],
  EN_RIESGO: ['CONFIRMADA', 'CANCELADA', 'NO_SHOW', 'ATENDIDA'],
  ATENDIDA: [],
  CANCELADA: [],
  NO_SHOW: [],
};

export function AgendaClient({
  locale,
  date,
  view,
  professionalId,
  status,
  appointments,
  professionals,
}: AgendaClientProps) {
  const t = useTranslations('panel.agenda');
  const tStatus = useTranslations('panel.dashboard.status');
  const router = useRouter();
  const toast = useToast();

  const [selected, setSelected] = useState<Appointment | null>(null);
  const [busy, setBusy] = useState(false);

  function updateQuery(patch: Record<string, string | undefined>) {
    const qs = new URLSearchParams();
    const merged = {
      date,
      view,
      professionalId: professionalId || undefined,
      status: status || undefined,
      ...patch,
    };
    for (const [k, v] of Object.entries(merged)) {
      if (v) qs.set(k, v);
    }
    router.push(`?${qs.toString()}`);
  }

  async function changeStatus(next: AppointmentStatus) {
    if (!selected) return;
    setBusy(true);
    const res = await fetcher(`/api/appointments/${selected.id}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ status: next }),
    });
    setBusy(false);
    if (res.ok) {
      toast.push(t('statusChanged'), 'success');
      setSelected(null);
      router.refresh();
      return;
    }
    // Race: otro operador movió la cita → 422 (FSM ilegal en la DB actual).
    // Refetcheamos, cerramos modal y avisamos. El usuario ve la data fresca.
    if (res.status === 422) {
      toast.push(t('statusRaceRefresh'), 'info');
      setSelected(null);
      router.refresh();
      return;
    }
    // Cualquier otro error (500, network) → toast genérico, modal queda abierto.
    toast.push(t('statusChangeFailed'), 'error');
  }

  const shiftDay = (delta: number) => {
    // UTC-anchored: partimos de un ms UTC calculado a mano → determinístico,
    // sin drift TZ del navegador. Ver Nit-A5.
    updateQuery({ date: shiftDayISO(date, delta) });
  };

  return (
    <>
      <div className="flex flex-wrap items-center gap-3 rounded-md border border-gray-200 bg-white p-3">
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            className="h-8 px-2"
            onClick={() => shiftDay(view === 'week' ? -7 : -1)}
          >
            ‹
          </Button>
          <input
            type="date"
            value={date}
            onChange={(e) => updateQuery({ date: e.target.value })}
            className="h-8 rounded-md border border-gray-300 px-2 text-sm"
          />
          <Button
            variant="ghost"
            className="h-8 px-2"
            onClick={() => shiftDay(view === 'week' ? 7 : 1)}
          >
            ›
          </Button>
        </div>

        <div className="flex items-center gap-1">
          <Button
            variant={view === 'day' ? 'primary' : 'ghost'}
            className="h-8 px-3"
            onClick={() => updateQuery({ view: 'day' })}
          >
            {t('viewDay')}
          </Button>
          <Button
            variant={view === 'week' ? 'primary' : 'ghost'}
            className="h-8 px-3"
            onClick={() => updateQuery({ view: 'week' })}
          >
            {t('viewWeek')}
          </Button>
        </div>

        <div className="ml-auto flex flex-wrap items-center gap-2">
          <Select
            className="h-8 w-auto text-sm"
            value={professionalId}
            onChange={(e) =>
              updateQuery({ professionalId: e.target.value || undefined })
            }
          >
            <option value="">{t('filters.allProfessionals')}</option>
            {professionals.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
          <Select
            className="h-8 w-auto text-sm"
            value={status}
            onChange={(e) =>
              updateQuery({ status: e.target.value || undefined })
            }
          >
            <option value="">{t('filters.allStatuses')}</option>
            {(
              [
                'PENDIENTE',
                'CONFIRMADA',
                'EN_RIESGO',
                'ATENDIDA',
                'CANCELADA',
                'NO_SHOW',
              ] as const
            ).map((s) => (
              <option key={s} value={s}>
                {tStatus(s)}
              </option>
            ))}
          </Select>
        </div>
      </div>

      {view === 'day' ? (
        <DayView
          appointments={appointments}
          locale={locale}
          onSelect={setSelected}
          emptyLabel={t('empty')}
        />
      ) : (
        <WeekView
          date={date}
          appointments={appointments}
          locale={locale}
          onSelect={setSelected}
        />
      )}

      <Modal
        open={selected !== null}
        onClose={() => setSelected(null)}
        title={t('detailTitle')}
      >
        {selected ? (
          <div className="space-y-4">
            <div className="space-y-1 text-sm">
              <p>
                <span className="text-gray-500">{t('detail.patient')}:</span>{' '}
                <span className="font-medium">{selected.patient.name}</span>
              </p>
              <p>
                <span className="text-gray-500">{t('detail.phone')}:</span>{' '}
                <span className="tabular-nums">{selected.patient.phone}</span>
              </p>
              <p>
                <span className="text-gray-500">{t('detail.service')}:</span>{' '}
                {selected.service.name} ({selected.service.durationMin} min)
              </p>
              <p>
                <span className="text-gray-500">{t('detail.professional')}:</span>{' '}
                {selected.professional.name}
              </p>
              <p>
                <span className="text-gray-500">{t('detail.time')}:</span>{' '}
                {formatDateTime(selected.startAt, locale)}
              </p>
              <p>
                <span className="text-gray-500">{t('detail.status')}:</span>{' '}
                <Badge variant={selected.status}>{tStatus(selected.status)}</Badge>
              </p>
            </div>

            <div className="border-t border-gray-100 pt-3">
              <p className="mb-2 text-xs font-medium uppercase tracking-wide text-gray-500">
                {t('detail.transitions')}
              </p>
              <div className="flex flex-wrap gap-2">
                {TRANSITIONS[selected.status].length === 0 ? (
                  <p className="text-sm text-gray-500">
                    {t('detail.noTransitions')}
                  </p>
                ) : (
                  TRANSITIONS[selected.status].map((next) => (
                    <Button
                      key={next}
                      variant="primary"
                      className="h-9 px-3 text-sm"
                      disabled={busy}
                      onClick={() => changeStatus(next)}
                    >
                      {tStatus(next)}
                    </Button>
                  ))
                )}
              </div>
            </div>
          </div>
        ) : null}
      </Modal>
    </>
  );
}

function DayView({
  appointments,
  locale,
  onSelect,
  emptyLabel,
}: {
  appointments: Appointment[];
  locale: string;
  onSelect: (a: Appointment) => void;
  emptyLabel: string;
}) {
  const tStatus = useTranslations('panel.dashboard.status');

  if (appointments.length === 0) {
    return (
      <div className="rounded-md border border-gray-200 bg-white p-8 text-center text-sm text-gray-500">
        {emptyLabel}
      </div>
    );
  }

  return (
    <ul className="divide-y divide-gray-100 rounded-md border border-gray-200 bg-white">
      {appointments.map((a) => (
        <li key={a.id}>
          <button
            type="button"
            onClick={() => onSelect(a)}
            className="flex w-full items-center gap-4 px-4 py-3 text-left hover:bg-gray-50"
          >
            <div className="w-20 shrink-0 tabular-nums text-sm text-gray-900">
              {formatTime(a.startAt, locale)}
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-gray-900">
                {a.patient.name}
              </p>
              <p className="truncate text-xs text-gray-500">
                {a.service.name} · {a.professional.name}
              </p>
            </div>
            <Badge variant={a.status} className="shrink-0">
              {tStatus(a.status)}
            </Badge>
          </button>
        </li>
      ))}
    </ul>
  );
}

function WeekView({
  date,
  appointments,
  locale,
  onSelect,
}: {
  date: string;
  appointments: Appointment[];
  locale: string;
  onSelect: (a: Appointment) => void;
}) {
  const tStatus = useTranslations('panel.dashboard.status');

  // 7 columnas — desde `date` hasta +6. UTC-anchored (Nit-A5).
  const days = useMemo(() => {
    return Array.from({ length: 7 }, (_, i) => shiftDayISO(date, i));
  }, [date]);

  const byDay = useMemo(() => {
    const map = new Map<string, Appointment[]>();
    for (const d of days) map.set(d, []);
    for (const a of appointments) {
      const key = a.startAt.slice(0, 10);
      const bucket = map.get(key);
      if (bucket) bucket.push(a);
    }
    return map;
  }, [appointments, days]);

  return (
    <div className="overflow-x-auto rounded-md border border-gray-200 bg-white">
      <div className="grid min-w-[840px] grid-cols-7 divide-x divide-gray-100">
        {days.map((d) => {
          const items = byDay.get(d) ?? [];
          return (
            <div key={d} className="flex min-h-[240px] flex-col">
              <div className="border-b border-gray-100 bg-gray-50 px-2 py-1.5 text-xs font-medium text-gray-700">
                {formatWeekdayShort(d, locale)}
              </div>
              <div className="flex-1 space-y-1 p-1">
                {items.length === 0 ? (
                  <p className="p-1 text-xs text-gray-400">—</p>
                ) : (
                  items.map((a) => (
                    <button
                      key={a.id}
                      type="button"
                      onClick={() => onSelect(a)}
                      className={cn(
                        'block w-full rounded-md border px-2 py-1 text-left text-xs hover:opacity-90',
                        badgeBgFor(a.status),
                      )}
                    >
                      <p className="tabular-nums font-medium">
                        {formatTime(a.startAt, locale)}
                      </p>
                      <p className="truncate">{a.patient.name}</p>
                      <p className="truncate opacity-75">
                        {tStatus(a.status)}
                      </p>
                    </button>
                  ))
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function badgeBgFor(status: AppointmentStatus): string {
  switch (status) {
    case 'PENDIENTE':
      return 'bg-yellow-50 border-yellow-300 text-yellow-900';
    case 'CONFIRMADA':
      return 'bg-green-50 border-green-300 text-green-900';
    case 'EN_RIESGO':
      return 'bg-orange-50 border-orange-300 text-orange-900';
    case 'ATENDIDA':
      return 'bg-blue-50 border-blue-300 text-blue-900';
    case 'CANCELADA':
      return 'bg-gray-50 border-gray-300 text-gray-700';
    case 'NO_SHOW':
      return 'bg-red-50 border-red-300 text-red-900';
  }
}

function formatTime(iso: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(iso));
}

function formatDateTime(iso: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    weekday: 'short',
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(iso));
}

function formatWeekdayShort(dateStr: string, locale: string): string {
  // UTC-anchored: parseamos el YYYY-MM-DD a un ms UTC determinístico, así el
  // Intl.DateTimeFormat renderiza el weekday correcto en cualquier browser TZ.
  // Ver comentario general de shiftDayISO (Nit-A5).
  const [y, m, d] = dateStr.split('-').map(Number);
  const ms = Date.UTC(y!, (m ?? 1) - 1, d ?? 1);
  return new Intl.DateTimeFormat(locale, {
    weekday: 'short',
    day: '2-digit',
    month: 'short',
    timeZone: 'UTC',
  }).format(new Date(ms));
}

/**
 * Suma `delta` días a `YYYY-MM-DD` sin tocar `new Date()` naive de la máquina.
 *
 * Estrategia: convertimos a ms UTC con `Date.UTC(...)` — es determinístico, no
 * depende de la TZ del browser (a diferencia de `new Date('2026-08-09')` que
 * en algunos navegadores parsea como local). Después de sumar `delta*86_400_000`
 * ms, extraemos el YYYY-MM-DD via `toISOString().slice(0, 10)`.
 *
 * Nota: usamos `new Date(ms)` con `ms` proveniente de `Date.UTC()` — esto NO
 * es "Date naive de la máquina". El principio de la regla es evitar la TZ
 * local del sistema; anclamos todo a UTC.
 */
function shiftDayISO(dateISO: string, delta: number): string {
  const [y, m, d] = dateISO.split('-').map(Number);
  const ms = Date.UTC(y!, (m ?? 1) - 1, d ?? 1) + delta * 86_400_000;
  return new Date(ms).toISOString().slice(0, 10);
}
