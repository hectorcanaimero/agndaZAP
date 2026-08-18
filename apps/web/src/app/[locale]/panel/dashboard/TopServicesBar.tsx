import type { DashboardMetrics } from './types';
import { LucideIcon } from './LucideIcon';

/**
 * TopServicesBar — ranking de servicios más atendidos (30d).
 *
 * Implementación: HTML puro (no recharts) — barras horizontales con `width%`.
 * Motivo:
 *   - Recharts para 5 filas horizontales es overkill y menos accesible.
 *   - Con HTML podemos meter texto sobrepuesto (nombre + count + revenue) sin
 *     pelearnos con el layout del axis de recharts.
 *   - Server component: sin bundle JS extra.
 *
 * Cada fila tiene:
 *   - Rank número (chip 01, 02...) — le da personalidad editorial.
 *   - Nombre del servicio (truncated).
 *   - Barra teal proporcional (max = top1).
 *   - Count + revenue en tabular.
 */
export interface TopServicesBarProps {
  data: DashboardMetrics['topServices'];
  labels: {
    empty: string;
    countLabel: string; // "citas atendidas"
    currencyCode: string; // ISO 4217 — viene de `clinic.currency` (config por tenant); default USD
  };
  locale: string;
}

export function TopServicesBar({ data, labels, locale }: TopServicesBarProps) {
  if (data.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 py-8 text-center">
        <LucideIcon
          name="Sparkles"
          className="h-6 w-6 text-gray-300"
          aria-hidden="true"
        />
        <p className="text-sm text-gray-500">{labels.empty}</p>
      </div>
    );
  }

  const max = data.reduce((acc, d) => Math.max(acc, d.count), 0) || 1;
  const currencyFormatter = new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: labels.currencyCode,
    maximumFractionDigits: 0,
  });

  return (
    <ol className="space-y-3">
      {data.map((row, idx) => {
        const pct = (row.count / max) * 100;
        return (
          <li key={row.id}>
            <div className="mb-1 flex items-center justify-between gap-3">
              <div className="flex min-w-0 items-center gap-2">
                <span
                  className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-gray-100 text-[10px] font-bold tabular-nums text-gray-500"
                  aria-hidden="true"
                >
                  {String(idx + 1).padStart(2, '0')}
                </span>
                <span className="truncate text-sm font-medium text-gray-900">
                  {row.name}
                </span>
              </div>
              <span className="shrink-0 text-xs text-gray-500 tabular-nums">
                <span className="font-semibold text-gray-900">{row.count}</span>
                <span className="mx-1 text-gray-300">·</span>
                {currencyFormatter.format(row.revenueCents / 100)}
              </span>
            </div>
            <div
              className="h-2 overflow-hidden rounded-full bg-gray-100"
              role="progressbar"
              aria-valuenow={row.count}
              aria-valuemin={0}
              aria-valuemax={max}
              aria-label={`${row.name}: ${row.count} ${labels.countLabel}`}
            >
              <div
                className="h-full rounded-full bg-gradient-to-r from-teal-400 to-teal-500 transition-[width] duration-700 ease-out-soft"
                style={{ width: `${pct}%` }}
              />
            </div>
          </li>
        );
      })}
    </ol>
  );
}
