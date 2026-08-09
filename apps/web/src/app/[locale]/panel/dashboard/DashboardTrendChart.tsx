'use client';

import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from 'recharts';
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from '@/components/ui/chart';

interface TrendPoint {
  date: string;
  label: string;
  created: number;
  noShow: number;
}

interface Props {
  trend: TrendPoint[];
  labels: {
    created: string;
    noShow: string;
    ariaLabel: string;
  };
}

/**
 * Trend chart del dashboard usando shadcn Chart wrapper de Recharts.
 *
 * - `created` usa `--chart-1` (verde brand) — coherente con el resto del theme.
 * - `noShow` usa `--destructive` (rojo) — el `--chart-4` del theme shadcn
 *   default es amarillo (43 74% 66%), que no comunica "alerta". `--destructive`
 *   está pensado para exactamente ese caso semántico y sube el contraste sobre
 *   fondo blanco a AA (60.2% de luminosidad → 4.5:1+ con blanco).
 *
 * A11y: mantenemos el `role="img"` + `aria-label` del contenedor y la leyenda
 * dot visible; la tabla `<details>` en el padre sigue siendo la fuente
 * accesible primaria (WCAG 2.1.1). Los `ChartTooltipContent` de shadcn son
 * hover-only por defecto → no accesibles a keyboard, por eso mantenemos el
 * `<details>`.
 */
export function DashboardTrendChart({ trend, labels }: Props) {
  const chartConfig = {
    created: {
      label: labels.created,
      color: 'hsl(var(--chart-1))',
    },
    noShow: {
      label: labels.noShow,
      color: 'hsl(var(--destructive))',
    },
  } satisfies ChartConfig;

  return (
    <>
      {/* Leyenda visible antes del chart — dots con color + label.
          aria-hidden porque el aria-label del chart ya lo describe al AT
          y la tabla `<details>` es la fuente accesible primaria. */}
      <div
        className="mb-2 flex gap-4 text-xs text-gray-700"
        aria-hidden="true"
      >
        <span className="inline-flex items-center gap-1">
          <span className="inline-block h-3 w-3 rounded-sm bg-brand-600" />
          {labels.created}
        </span>
        <span className="inline-flex items-center gap-1">
          <span
            className="inline-block h-3 w-3 rounded-sm"
            style={{ backgroundColor: 'hsl(var(--destructive))' }}
          />
          {labels.noShow}
        </span>
      </div>

      <ChartContainer
        config={chartConfig}
        className="h-[140px] w-full"
        aria-label={labels.ariaLabel}
        role="img"
      >
        <BarChart
          data={trend}
          margin={{ top: 4, right: 4, bottom: 0, left: -20 }}
        >
          <CartesianGrid
            vertical={false}
            strokeDasharray="3 3"
            className="stroke-gray-200"
          />
          <XAxis
            dataKey="label"
            tickLine={false}
            axisLine={false}
            tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }}
            interval="preserveStartEnd"
          />
          <YAxis
            tickLine={false}
            axisLine={false}
            tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }}
            allowDecimals={false}
            width={28}
          />
          <ChartTooltip
            cursor={{ fill: 'hsl(var(--muted))', opacity: 0.5 }}
            content={<ChartTooltipContent indicator="dot" />}
          />
          <Bar
            dataKey="created"
            fill="var(--color-created)"
            radius={[3, 3, 0, 0]}
            maxBarSize={20}
          />
          <Bar
            dataKey="noShow"
            fill="var(--color-noShow)"
            radius={[3, 3, 0, 0]}
            maxBarSize={20}
          />
        </BarChart>
      </ChartContainer>
    </>
  );
}
