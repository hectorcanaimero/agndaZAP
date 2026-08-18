'use client';

import { cn } from '@/lib/utils';
import type { DashboardMetrics } from './types';

/**
 * HourHeatmap — cita a qué horas llegan las reservas.
 *
 * Grid de 24 celdas (0-23) con intensidad proporcional al conteo. Se muestran
 * las horas divididas en dos filas (00-11 / 12-23) para lectura AM/PM.
 *
 * Decisión de color: usamos un único tono (brand-navy) con opacidad escalonada
 * (0.05 → 1.0) — un heatmap real "en gama" (rainbow) mete ruido y sesgo
 * perceptual. La opacidad sola comunica magnitud sin drama.
 *
 * Accesibilidad:
 *   - Cada celda es un `<div role="img">` con `aria-label` que dice "3 citas
 *     a las 09" — lector de pantalla la lee correctamente.
 *   - Los labels de hora quedan visibles debajo del grid.
 *   - Tooltip nativo `<title>` para hover mouse (no requiere JS).
 */
export interface HourHeatmapProps {
  data: DashboardMetrics['hourHeatmap'];
  labels: {
    tooltip: string; // "{count} citas a las {hour}"
    tooltipOne: string; // "1 cita a las {hour}"
    tooltipZero: string; // "Sin citas a las {hour}"
    peakLabel: string; // "Pico"
    quietLabel: string; // "Silencio"
  };
}

export function HourHeatmap({ data, labels }: HourHeatmapProps) {
  const filled = Array.from({ length: 24 }, (_, hour) => {
    const found = data.find((d) => d.hour === hour);
    return { hour, count: found?.count ?? 0 };
  });

  const max = filled.reduce((acc, d) => Math.max(acc, d.count), 0);
  const peak = max === 0 ? null : filled.find((d) => d.count === max)!;
  const nonZero = filled.filter((d) => d.count > 0);
  const min = nonZero.reduce(
    (acc, d) => Math.min(acc, d.count),
    Number.POSITIVE_INFINITY,
  );
  const quiet =
    max === 0 || nonZero.length < 2
      ? null
      : filled.find((d) => d.count === min) ?? null;

  const first = filled.slice(0, 12);
  const second = filled.slice(12, 24);

  return (
    <div className="space-y-3">
      <HeatRow row={first} max={max} labels={labels} />
      <HeatRow row={second} max={max} labels={labels} />

      {/* Micro-summary abajo: pico y silencio del día. Le da al operador
          una lectura interpretativa sin obligarlo a escanear el grid. */}
      <div className="mt-3 grid grid-cols-2 gap-3 border-t border-gray-100 pt-3 text-xs">
        <SummaryTile
          label={labels.peakLabel}
          value={peak ? `${formatHour(peak.hour)}` : '—'}
          count={peak?.count ?? 0}
          tone="peak"
        />
        <SummaryTile
          label={labels.quietLabel}
          value={quiet ? `${formatHour(quiet.hour)}` : '—'}
          count={quiet?.count ?? 0}
          tone="quiet"
        />
      </div>
    </div>
  );
}

function HeatRow({
  row,
  max,
  labels,
}: {
  row: Array<{ hour: number; count: number }>;
  max: number;
  labels: HourHeatmapProps['labels'];
}) {
  return (
    <div>
      <div className="grid grid-cols-12 gap-1">
        {row.map((cell) => {
          const alpha = max === 0 ? 0 : cell.count / max;
          const opacity = alpha === 0 ? 0.05 : 0.15 + alpha * 0.85;
          const template = cell.count === 0
            ? labels.tooltipZero
            : cell.count === 1
            ? labels.tooltipOne
            : labels.tooltip;
          const tooltip = template
            .replace('{count}', String(cell.count))
            .replace('{hour}', formatHour(cell.hour));
          return (
            <div
              key={cell.hour}
              role="img"
              aria-label={tooltip}
              title={tooltip}
              className="group/cell aspect-square rounded-md ring-1 ring-inset ring-gray-200/60 transition-transform duration-200 hover:scale-[1.15] hover:ring-brand-navy/40"
              style={{
                backgroundColor: `hsla(213, 66%, 17%, ${opacity})`,
              }}
            />
          );
        })}
      </div>
      <div className="mt-1 grid grid-cols-12 gap-1 text-[9px] text-gray-400 tabular-nums">
        {row.map((cell) => (
          <span key={cell.hour} className="text-center">
            {cell.hour}
          </span>
        ))}
      </div>
    </div>
  );
}

function SummaryTile({
  label,
  value,
  count,
  tone,
}: {
  label: string;
  value: string;
  count: number;
  tone: 'peak' | 'quiet';
}) {
  return (
    <div className="rounded-lg bg-gray-50/70 px-3 py-2">
      <p className="text-[10px] font-medium uppercase tracking-wide text-gray-500">
        {label}
      </p>
      <div className="mt-0.5 flex items-baseline gap-1.5">
        <span
          className={cn(
            'text-sm font-semibold tabular-nums',
            tone === 'peak' ? 'text-brand-navy' : 'text-gray-700',
          )}
        >
          {value}
        </span>
        {count > 0 ? (
          <span className="text-xs text-gray-500 tabular-nums">
            · {count}
          </span>
        ) : null}
      </div>
    </div>
  );
}

function formatHour(h: number): string {
  return `${String(h).padStart(2, '0')}:00`;
}
