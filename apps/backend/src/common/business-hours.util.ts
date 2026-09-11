import { BusinessHour } from '@prisma/client';
import { DateTime } from 'luxon';

/**
 * Lectura del horario de atención de la clínica, en un solo sitio.
 *
 * Lo usan el bloque de hechos del RAG y el mensaje de handoff del bot. Vive
 * aquí para que no haya dos redacciones distintas del mismo horario: verlas
 * discrepar dentro de la misma conversación es peor que no darlo.
 */

const WEEKDAY_NAMES: Record<number, string> = {
  0: 'Domingo',
  1: 'Lunes',
  2: 'Martes',
  3: 'Miércoles',
  4: 'Jueves',
  5: 'Viernes',
  6: 'Sábado',
};

/** Orden de despliegue lunes→domingo (no el orden numérico del campo `weekday`). */
const WEEKDAY_DISPLAY_ORDER = [1, 2, 3, 4, 5, 6, 0];

function formatMinutes(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${h}:${String(m).padStart(2, '0')}`;
}

/**
 * Agrupa días consecutivos (lunes→domingo) con el mismo rango horario:
 * "Lunes a viernes 8:00 a 17:00. Sábado 9:00 a 13:00.". Los días sin filas se
 * omiten (cerrado), no se listan como "cerrado". Soporta turnos partidos
 * (varias filas el mismo día → "9:00 a 13:00 y 15:00 a 18:00").
 *
 * Devuelve `null` si no hay horario que mostrar: el caller decide qué decir.
 */
export function formatSchedule(rows: BusinessHour[]): string | null {
  if (rows.length === 0) return null;

  const byWeekday = new Map<
    number,
    Array<{ startMinutes: number; endMinutes: number }>
  >();
  for (const row of rows) {
    const list = byWeekday.get(row.weekday) ?? [];
    list.push({ startMinutes: row.startMinutes, endMinutes: row.endMinutes });
    byWeekday.set(row.weekday, list);
  }

  const rangeFor = (weekday: number): string | null => {
    const list = byWeekday.get(weekday);
    if (!list || list.length === 0) return null;
    return [...list]
      .sort((a, b) => a.startMinutes - b.startMinutes)
      .map((r) => `${formatMinutes(r.startMinutes)} a ${formatMinutes(r.endMinutes)}`)
      .join(' y ');
  };

  const groups: Array<{ days: number[]; range: string; lastIndex: number }> = [];
  WEEKDAY_DISPLAY_ORDER.forEach((weekday, index) => {
    const range = rangeFor(weekday);
    if (range === null) return; // día cerrado: NO extiende el grupo anterior
    const last = groups[groups.length - 1];
    // Sólo fusiona si el día es CONSECUTIVO al último del grupo (mismo rango Y
    // sin un día cerrado en el medio) — evita que "lunes 9-13, martes cerrado,
    // miércoles 9-13" salga como "lunes a miércoles".
    if (last && last.range === range && last.lastIndex === index - 1) {
      last.days.push(weekday);
      last.lastIndex = index;
    } else {
      groups.push({ days: [weekday], range, lastIndex: index });
    }
  });

  if (groups.length === 0) return null;

  return groups
    .map((g) => {
      // Estilo español: sólo el primer día del tramo va con mayúscula
      // ("Lunes a viernes"); el segundo en minúscula, salvo que el grupo tenga
      // un solo día ("Sábado 9:00 a 13:00.").
      const label =
        g.days.length === 1
          ? WEEKDAY_NAMES[g.days[0]]
          : `${WEEKDAY_NAMES[g.days[0]]} a ${WEEKDAY_NAMES[g.days[g.days.length - 1]].toLowerCase()}`;
      return `${label} ${g.range}.`;
    })
    .join(' ');
}

/**
 * ¿`now` cae dentro del horario de atención?
 *
 * `now` tiene que venir YA en la zona de la clínica: el horario se define en
 * hora local y compararlo contra UTC daría "cerrado" a media mañana en
 * América. Sin filas devuelve `false` — no podemos prometer atención inmediata
 * sobre un horario que nadie cargó.
 */
export function isWithinBusinessHours(
  rows: BusinessHour[],
  now: DateTime,
): boolean {
  if (rows.length === 0) return false;
  // Luxon: 1=lunes … 7=domingo. `BusinessHour.weekday`: 0=domingo … 6=sábado.
  const weekday = now.weekday === 7 ? 0 : now.weekday;
  const minutes = now.hour * 60 + now.minute;
  return rows.some(
    (r) =>
      r.weekday === weekday &&
      minutes >= r.startMinutes &&
      minutes < r.endMinutes,
  );
}
