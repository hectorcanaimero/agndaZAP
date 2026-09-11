import type { Slot } from '@/lib/api';

/**
 * Formateo de slots compartido entre el form de agendamiento
 * (`ScheduleForm`) y la página de gestión de cita (`cita/`).
 *
 * Vive aparte porque son funciones puras sin JSX ni estado: el selector de
 * horarios del form está acoplado a `react-hook-form` y no se puede reutilizar
 * tal cual, pero el formateo sí, y duplicarlo sería la vía rápida a que las
 * dos páginas muestren la misma hora distinta.
 */

/**
 * Agrupa slots por fecha local (YYYY-MM-DD en la TZ de la clínica) para render
 * en columnas por día. Usamos `Intl.DateTimeFormat` con la TZ correcta — no
 * `Date.toLocaleDateString` del user agent, porque queremos la fecha desde la
 * perspectiva de la clínica.
 */
export function groupSlotsByDay(
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

export function formatSlotTime(
  iso: string,
  timezone: string,
  locale: string,
): string {
  return new Intl.DateTimeFormat(locale, {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(iso));
}

/** Fecha y hora larga, para el resumen de la cita ("lun, 15 sep, 14:30"). */
export function formatAppointmentWhen(
  iso: string,
  timezone: string,
  locale: string,
): string {
  return new Intl.DateTimeFormat(locale, {
    timeZone: timezone,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(iso));
}
