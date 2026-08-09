/**
 * Concatena clases CSS filtrando `false`/`undefined`. Sirve como sustituto
 * mínimo de `clsx`/`classnames`; no queremos añadir la dep sólo para esto.
 */
export function cn(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(' ');
}
