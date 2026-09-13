'use client';

import { useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { DateTime } from 'luxon';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { fetchAvailability, fetchAvailableDays } from '@/lib/api';
import { queryKeys } from '@/lib/query-keys';
import { todayStartInTZ } from '@/lib/utils';
import { formatSlotTime } from './slot-format';

/** Horizonte del calendario. El backend acepta hasta 60 días. */
export const CALENDAR_DAYS = 60;

interface Props {
  clinicSlug: string;
  serviceId: string;
  professionalId: string;
  timezone: string;
  locale: string;
  /** `startAt` elegido, si lo hay. Marca la hora y decide el día inicial. */
  selected: string | null;
  onSelect: (startAt: string) => void;
  disabled?: boolean;
  /** Qué mostrar si no hay ningún día con hueco en el horizonte. */
  empty: ReactNode;
}

/**
 * Calendario de días con hueco + horas del día elegido (ADR 0024).
 *
 * Sustituye a la lista plana de horarios, que se quedaba con los primeros
 * 12 de un corte de 50: el paciente veía parte de mañana y no podía elegir
 * otro día. Con el bot mandando el link en vez de agendar por chat, esta es la
 * pantalla donde se elige la cita, así que tiene que llegar a cualquier día.
 *
 * Todas las fechas son de calendario en la TZ de la clínica (`YYYY-MM-DD`,
 * como las devuelve el backend). La aritmética de meses con Luxon sobre esas
 * fechas no depende de la zona del navegador.
 *
 * Teclado: en los dos grupos las flechas mueven el foco y Enter/Espacio
 * selecciona, igual que el picker anterior (seleccionar dispara analytics y
 * cambios de estado; recorrer con flechas no debe hacerlo).
 */
export function SlotPicker({
  clinicSlug,
  serviceId,
  professionalId,
  timezone,
  locale,
  selected,
  onSelect,
  disabled = false,
  empty,
}: Props) {
  const t = useTranslations('slotPicker');
  const todayISO = useMemo(() => todayStartInTZ(timezone), [timezone]);

  const daysQuery = useQuery({
    queryKey: queryKeys.availabilityDays(
      clinicSlug,
      serviceId,
      professionalId,
      todayISO,
      CALENDAR_DAYS,
    ),
    queryFn: () =>
      fetchAvailableDays(clinicSlug, {
        serviceId,
        professionalId,
        from: todayISO,
        days: CALENDAR_DAYS,
      }),
    enabled: Boolean(serviceId && professionalId),
  });
  const availableDays = useMemo(() => daysQuery.data ?? [], [daysQuery.data]);
  const availableSet = useMemo(() => new Set(availableDays), [availableDays]);

  // Día que tocó el paciente. Nulo = el del horario elegido o el primero con hueco.
  const [pickedDay, setPickedDay] = useState<string | null>(null);
  const [visibleMonth, setVisibleMonth] = useState<string | null>(null);
  useEffect(() => {
    setPickedDay(null);
    setVisibleMonth(null);
  }, [serviceId, professionalId]);

  const selectedDay = selected
    ? DateTime.fromISO(selected, { zone: timezone }).toISODate()
    : null;
  const activeDay =
    (pickedDay && availableSet.has(pickedDay) ? pickedDay : null) ??
    (selectedDay && availableSet.has(selectedDay) ? selectedDay : null) ??
    availableDays[0] ??
    null;

  const minMonth = todayISO.slice(0, 7);
  const maxMonth = DateTime.fromISO(todayISO)
    .plus({ days: CALENDAR_DAYS - 1 })
    .toFormat('yyyy-MM');
  const month = visibleMonth ?? (activeDay ?? todayISO).slice(0, 7);

  const slotsQuery = useQuery({
    queryKey: queryKeys.availability(
      clinicSlug,
      serviceId,
      professionalId,
      activeDay ?? undefined,
      1,
    ),
    queryFn: () =>
      fetchAvailability(clinicSlug, {
        serviceId,
        professionalId,
        from: activeDay!,
        days: 1,
      }),
    enabled: Boolean(serviceId && professionalId && activeDay),
  });
  const slots = slotsQuery.data ?? [];

  const dayLabel = useCallback(
    (iso: string) =>
      // Mediodía UTC + `timeZone: 'UTC'`: formatea la fecha de calendario tal
      // cual, sin que la zona del navegador la mueva de día.
      new Intl.DateTimeFormat(locale, {
        timeZone: 'UTC',
        weekday: 'long',
        day: 'numeric',
        month: 'long',
      }).format(new Date(`${iso}T12:00:00Z`)),
    [locale],
  );

  const cells = useMemo(() => {
    const first = DateTime.fromISO(`${month}-01`);
    const blanks = first.weekday - 1; // semana de lunes a domingo
    const out: Array<string | null> = Array.from({ length: blanks }, () => null);
    for (let d = 1; d <= first.daysInMonth!; d++) {
      out.push(first.set({ day: d }).toISODate());
    }
    return out;
  }, [month]);

  const weekdayNames = useMemo(() => {
    // 2024-01-01 fue lunes.
    const monday = DateTime.fromISO('2024-01-01').setLocale(locale);
    return Array.from({ length: 7 }, (_, i) => monday.plus({ days: i }).toFormat('ccccc'));
  }, [locale]);

  // Roving tabindex: el día activo si está en el mes visible; si no, el primero
  // con hueco del mes. Sin esto, tras cambiar a un mes sin el día activo no
  // quedaría ningún día alcanzable con Tab.
  const tabbableDay =
    activeDay && cells.includes(activeDay)
      ? activeDay
      : (cells.find((d) => d !== null && availableSet.has(d)) ?? null);

  const monthTitle = DateTime.fromISO(`${month}-01`)
    .setLocale(locale)
    .toFormat('LLLL yyyy');

  function shiftMonth(delta: number) {
    const next = DateTime.fromISO(`${month}-01`)
      .plus({ months: delta })
      .toFormat('yyyy-MM');
    setVisibleMonth(next);
    // Al cambiar de mes se abren las horas del primer día con hueco de ese mes:
    // un calendario sin horas debajo parece que no respondió.
    const firstInMonth = availableDays.find((d) => d.startsWith(next));
    if (firstInMonth) setPickedDay(firstInMonth);
  }

  /** Flechas en la rejilla: ←/→ un día, ↑/↓ una semana, saltando días sin hueco. */
  const onDaysKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    const steps: Record<string, number> = {
      ArrowLeft: -1,
      ArrowRight: 1,
      ArrowUp: -7,
      ArrowDown: 7,
    };
    const step = steps[e.key];
    if (!step) return;
    const buttons = Array.from(
      e.currentTarget.querySelectorAll<HTMLButtonElement>('button[data-day]'),
    );
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (current < 0) return;
    e.preventDefault();
    let next = current + step;
    const unit = Math.sign(step);
    while (next >= 0 && next < buttons.length && buttons[next]!.disabled) {
      next += unit;
    }
    if (next >= 0 && next < buttons.length) buttons[next]!.focus();
  }, []);

  const onSlotsKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    const keys = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'];
    if (!keys.includes(e.key)) return;
    const radios = Array.from(
      e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]:not([disabled])'),
    );
    if (radios.length === 0) return;
    const current = radios.indexOf(document.activeElement as HTMLButtonElement);
    let next = current;
    if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = radios.length - 1;
    else if (e.key === 'ArrowRight' || e.key === 'ArrowDown')
      next = current < 0 ? 0 : (current + 1) % radios.length;
    else next = current <= 0 ? radios.length - 1 : current - 1;
    e.preventDefault();
    radios[next]?.focus();
  }, []);

  if (daysQuery.isLoading) {
    return (
      <div role="status" aria-label={t('loading')} className="space-y-3">
        <div className="h-6 w-40 animate-pulse rounded bg-gray-200" />
        <div className="grid grid-cols-7 gap-1">
          {Array.from({ length: 35 }).map((_, i) => (
            <div key={i} className="h-10 animate-pulse rounded-md bg-gray-100" />
          ))}
        </div>
      </div>
    );
  }
  if (daysQuery.isError) {
    return <p className="text-sm text-red-600">{t('error')}</p>;
  }
  if (availableDays.length === 0) {
    return <>{empty}</>;
  }

  const selectedInDay = Boolean(selected) && slots.some((s) => s.startAt === selected);

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-gray-200 p-3">
        <div className="mb-2 flex items-center justify-between">
          <button
            type="button"
            onClick={() => shiftMonth(-1)}
            disabled={month <= minMonth}
            aria-label={t('previousMonth')}
            className="inline-flex h-9 w-9 items-center justify-center rounded-md text-gray-600 hover:bg-gray-100 focus:outline-none focus:ring-2 focus:ring-brand-500 disabled:cursor-not-allowed disabled:opacity-30"
          >
            <ChevronLeft className="h-5 w-5" aria-hidden="true" />
          </button>
          <p className="text-sm font-semibold capitalize text-gray-900" aria-live="polite">
            {monthTitle}
          </p>
          <button
            type="button"
            onClick={() => shiftMonth(1)}
            disabled={month >= maxMonth}
            aria-label={t('nextMonth')}
            className="inline-flex h-9 w-9 items-center justify-center rounded-md text-gray-600 hover:bg-gray-100 focus:outline-none focus:ring-2 focus:ring-brand-500 disabled:cursor-not-allowed disabled:opacity-30"
          >
            <ChevronRight className="h-5 w-5" aria-hidden="true" />
          </button>
        </div>

        <div className="grid grid-cols-7 gap-1" aria-hidden="true">
          {weekdayNames.map((name, i) => (
            <span key={i} className="py-1 text-center text-xs font-medium uppercase text-gray-500">
              {name}
            </span>
          ))}
        </div>

        <div
          role="group"
          aria-label={t('calendarLabel')}
          className="grid grid-cols-7 gap-1"
          onKeyDown={onDaysKeyDown}
        >
          {cells.map((iso, i) => {
            if (!iso) return <span key={`blank-${i}`} />;
            const available = availableSet.has(iso);
            const isActive = iso === activeDay;
            const isToday = iso === todayISO;
            const label = dayLabel(iso);
            return (
              <button
                key={iso}
                type="button"
                data-day={iso}
                disabled={!available || disabled}
                aria-pressed={isActive}
                aria-label={available ? label : t('dayUnavailable', { day: label })}
                tabIndex={iso === tabbableDay ? 0 : -1}
                onClick={() => setPickedDay(iso)}
                className={`relative h-10 rounded-md text-sm transition-colors focus:outline-none focus:ring-2 focus:ring-brand-500 focus:ring-offset-1 ${
                  isActive
                    ? 'bg-brand-600 font-semibold text-white'
                    : available
                      ? 'font-semibold text-gray-900 hover:bg-brand-50'
                      : 'cursor-not-allowed text-gray-300'
                }`}
              >
                {Number(iso.slice(8, 10))}
                {isToday && !isActive ? (
                  <span
                    aria-hidden="true"
                    className="absolute bottom-1 left-1/2 h-1 w-1 -translate-x-1/2 rounded-full bg-brand-600"
                  />
                ) : null}
              </button>
            );
          })}
        </div>
      </div>

      {activeDay ? (
        <div>
          <p className="mb-2 text-sm font-semibold first-letter:uppercase text-gray-700">
            {dayLabel(activeDay)}
          </p>
          {slotsQuery.isLoading ? (
            <div role="status" aria-label={t('loading')} className="flex flex-wrap gap-2">
              {Array.from({ length: 8 }).map((_, i) => (
                <div key={i} className="h-9 w-16 animate-pulse rounded-md bg-gray-200" />
              ))}
            </div>
          ) : slotsQuery.isError ? (
            <p className="text-sm text-red-600">{t('error')}</p>
          ) : slots.length === 0 ? (
            // El día tenía hueco al pintar el calendario y se llenó después.
            <p className="text-sm text-gray-600">{t('noSlotsDay')}</p>
          ) : (
            <div
              role="radiogroup"
              aria-label={t('hoursLabel', { day: dayLabel(activeDay) })}
              className="flex flex-wrap gap-2"
              onKeyDown={onSlotsKeyDown}
            >
              {slots.map((slot, idx) => {
                const time = formatSlotTime(slot.startAt, timezone, locale);
                const isSelected = selected === slot.startAt;
                const tabbable = selectedInDay ? isSelected : idx === 0;
                return (
                  <button
                    key={slot.startAt}
                    type="button"
                    data-slot={slot.startAt}
                    role="radio"
                    aria-checked={isSelected}
                    aria-label={`${dayLabel(activeDay)} ${time}`}
                    tabIndex={tabbable ? 0 : -1}
                    disabled={disabled}
                    onClick={() => onSelect(slot.startAt)}
                    className={`min-w-[4.5rem] rounded-md border px-3 py-2 text-sm font-medium transition-all focus:outline-none focus:ring-2 focus:ring-brand-500 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60 ${
                      isSelected
                        ? // bg-brand-600 sobre blanco = 4.83:1 (WCAG AA); el outline
                          // no deja la selección solo en el color.
                          'border-brand-700 bg-brand-600 text-white shadow-sm outline outline-2 outline-offset-2 outline-brand-700'
                        : 'border-gray-300 bg-white text-gray-700 hover:border-brand-500 hover:bg-brand-50'
                    }`}
                  >
                    {time}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}
