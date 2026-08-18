import type { DashboardMetrics } from './types';
import { LucideIcon } from './LucideIcon';

/**
 * TopProfessionalsList — ranking de profesionales con más ATENDIDAS (30d).
 *
 * Cada fila:
 *   - Avatar-monograma coloreado con el `color` del profesional (o brand teal).
 *   - Nombre + micro-stats (atendidas + no-show).
 *   - Barra proporcional de no-show rate al lado como signal secundario.
 *
 * El color del profesional viene del schema (`Professional.color`) — se usa
 * en la agenda para distinguir. Reciclarlo aquí crea consistencia visual
 * cross-panel.
 */
export interface TopProfessionalsListProps {
  data: DashboardMetrics['topProfessionals'];
  labels: {
    empty: string;
    attendedShort: string; // "att."
    noShowShort: string; // "N/S"
    noShowRateLabel: string; // "no-show"
  };
}

const FALLBACK_COLOR = '#0F2A4A'; // brand navy

export function TopProfessionalsList({
  data,
  labels,
}: TopProfessionalsListProps) {
  if (data.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 py-8 text-center">
        <LucideIcon
          name="Stethoscope"
          className="h-6 w-6 text-gray-300"
          aria-hidden="true"
        />
        <p className="text-sm text-gray-500">{labels.empty}</p>
      </div>
    );
  }

  return (
    <ul className="space-y-3">
      {data.map((prof) => {
        const total = prof.attended + prof.noShow;
        const nsRate = total === 0 ? 0 : prof.noShow / total;
        const color = prof.color ?? FALLBACK_COLOR;

        return (
          <li
            key={prof.id}
            className="grid grid-cols-[auto_1fr_auto] items-center gap-3 rounded-lg px-2 py-2 transition-colors hover:bg-gray-50/70"
          >
            <Avatar name={prof.name} color={color} />
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-gray-900">
                {prof.name}
              </p>
              <p className="text-xs text-gray-500 tabular-nums">
                <span className="font-semibold text-gray-700">
                  {prof.attended}
                </span>{' '}
                {labels.attendedShort}
                <span className="mx-1 text-gray-300">·</span>
                <span className={nsRate > 0.15 ? 'text-rose-600' : ''}>
                  {prof.noShow} {labels.noShowShort}
                </span>
              </p>
            </div>
            {/* Barra vertical acordeón que aumenta con no-show rate — signal
                sutil que llama la atención cuando algo está mal. */}
            <div
              className="flex h-8 w-6 flex-col justify-end overflow-hidden rounded-md bg-gray-100"
              aria-label={`${(nsRate * 100).toFixed(0)}% ${labels.noShowRateLabel}`}
              role="img"
              title={`${(nsRate * 100).toFixed(0)}% ${labels.noShowRateLabel}`}
            >
              <div
                className="w-full bg-gradient-to-t from-rose-500 to-rose-400 transition-[height] duration-700 ease-out-soft"
                style={{ height: `${Math.max(4, nsRate * 100)}%` }}
              />
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function Avatar({ name, color }: { name: string; color: string }) {
  const initials = name
    .split(/\s+/)
    .slice(0, 2)
    .map((s) => s.charAt(0).toUpperCase())
    .join('');

  return (
    <span
      className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-xs font-semibold text-white ring-2 ring-white"
      style={{ backgroundColor: color }}
      aria-hidden="true"
    >
      {initials}
    </span>
  );
}
