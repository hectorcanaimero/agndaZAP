/**
 * Presets de horarios semanales para el step 4 del wizard.
 *
 * Paradox of choice: 3 opciones (no 7, no 15). Cada preset resuelve un caso
 * frecuente en clínicas latam. El user puede saltar a "personalizar" para
 * armar un schedule custom, pero por default apuntamos al comercial clásico.
 *
 * Formato: `weekday` (0=domingo ... 6=sábado, matchea AvailabilityService del
 * backend). `startMinutes`/`endMinutes` desde medianoche (540 = 09:00).
 */

export interface HourRow {
  weekday: number;
  startMinutes: number;
  endMinutes: number;
}

export type HourPresetKey =
  | 'weekdays-9-18'
  | 'saturday-included'
  | 'split-shift'
  | 'custom';

export interface HourPreset {
  key: HourPresetKey;
  rows: HourRow[];
}

const wk = (weekday: number, start: number, end: number): HourRow => ({
  weekday,
  startMinutes: start,
  endMinutes: end,
});

/** L-V (1-5) de 9:00 a 18:00. Es el default checked. */
const WEEKDAYS_9_18: HourRow[] = [1, 2, 3, 4, 5].map((d) =>
  wk(d, 9 * 60, 18 * 60),
);

/** L-S (1-6) de 9:00 a 18:00. */
const SATURDAY_INCLUDED: HourRow[] = [1, 2, 3, 4, 5, 6].map((d) =>
  wk(d, 9 * 60, 18 * 60),
);

/** L-V (1-5) turno partido: 9-13 + 15-19. */
const SPLIT_SHIFT: HourRow[] = [1, 2, 3, 4, 5].flatMap((d) => [
  wk(d, 9 * 60, 13 * 60),
  wk(d, 15 * 60, 19 * 60),
]);

export const HOUR_PRESETS: Record<Exclude<HourPresetKey, 'custom'>, HourPreset> =
  {
    'weekdays-9-18': { key: 'weekdays-9-18', rows: WEEKDAYS_9_18 },
    'saturday-included': { key: 'saturday-included', rows: SATURDAY_INCLUDED },
    'split-shift': { key: 'split-shift', rows: SPLIT_SHIFT },
  };
