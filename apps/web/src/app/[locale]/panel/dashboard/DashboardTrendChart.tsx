'use client';

import {
  Area,
  Bar,
  CartesianGrid,
  ComposedChart,
  XAxis,
  YAxis,
} from 'recharts';
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
  confirmed: number;
  noShow: number;
}

interface Props {
  trend: TrendPoint[];
  labels: {
    created: string;
    confirmed: string;
    noShow: string;
    ariaLabel: string;
  };
}

/**
 * Trend chart 14 días — composed:
 *   - Área suave para `created` (tendencia — el eje que importa).
 *   - Línea/área ligera para `confirmed` (contexto de conversión).
 *   - Barras chicas para `noShow` (alertas — el rojo salta pero no domina).
 *
 * Sobre por qué composed y no solo bars:
 *   - Con 14 puntos las barras se ven flacas y el ojo no lee la tendencia,
 *     solo puntos individuales. Area comunica el patrón de mediano plazo.
 *   - `noShow` sigue como barra porque son eventos discretos "malos" —
 *     visualmente queremos que se lean como incidentes, no como flujo.
 *
 * A11y: mantenemos `role="img"` + `aria-label` del contenedor. La tabla
 * accesible sigue viviendo en el padre (details/summary + <table>).
 */
export function DashboardTrendChart({ trend, labels }: Props) {
  const chartConfig = {
    created: {
      label: labels.created,
      color: 'hsl(213 66% 17%)', // brand navy
    },
    confirmed: {
      label: labels.confirmed,
      color: 'hsl(170 71% 45%)', // brand teal
    },
    noShow: {
      label: labels.noShow,
      color: 'hsl(var(--destructive))',
    },
  } satisfies ChartConfig;

  return (
    <>
      {/* Leyenda arriba del chart — muted, prosa. Uso dots + dashes para que
          también se distingan en print/monochrome. */}
      <div
        className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-gray-600"
        aria-hidden="true"
      >
        <span className="inline-flex items-center gap-1.5">
          <span
            className="inline-block h-2.5 w-2.5 rounded-full"
            style={{ backgroundColor: 'hsl(213 66% 17%)' }}
          />
          {labels.created}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span
            className="inline-block h-2.5 w-2.5 rounded-full"
            style={{ backgroundColor: 'hsl(170 71% 45%)' }}
          />
          {labels.confirmed}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span
            className="inline-block h-2.5 w-2.5 rounded-sm"
            style={{ backgroundColor: 'hsl(var(--destructive))' }}
          />
          {labels.noShow}
        </span>
      </div>

      <ChartContainer
        config={chartConfig}
        className="h-[220px] w-full"
        aria-label={labels.ariaLabel}
        role="img"
      >
        <ComposedChart
          data={trend}
          margin={{ top: 8, right: 8, bottom: 0, left: -16 }}
        >
          <defs>
            <linearGradient id="area-created" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="hsl(213 66% 17%)" stopOpacity={0.28} />
              <stop offset="100%" stopColor="hsl(213 66% 17%)" stopOpacity={0} />
            </linearGradient>
            <linearGradient id="area-confirmed" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="hsl(170 71% 45%)" stopOpacity={0.18} />
              <stop offset="100%" stopColor="hsl(170 71% 45%)" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid
            vertical={false}
            strokeDasharray="3 3"
            stroke="hsl(0 0% 89%)"
          />
          <XAxis
            dataKey="label"
            tickLine={false}
            axisLine={false}
            tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }}
            interval="preserveStartEnd"
            minTickGap={12}
          />
          <YAxis
            tickLine={false}
            axisLine={false}
            tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }}
            allowDecimals={false}
            width={28}
          />
          <ChartTooltip
            cursor={{ fill: 'hsl(0 0% 96%)', opacity: 0.6 }}
            content={<ChartTooltipContent indicator="dot" />}
          />
          <Area
            type="monotone"
            dataKey="created"
            stroke="hsl(213 66% 17%)"
            strokeWidth={2}
            fill="url(#area-created)"
            dot={false}
            activeDot={{ r: 4, strokeWidth: 0 }}
          />
          <Area
            type="monotone"
            dataKey="confirmed"
            stroke="hsl(170 71% 45%)"
            strokeWidth={1.5}
            strokeDasharray="4 3"
            fill="url(#area-confirmed)"
            dot={false}
            activeDot={{ r: 3, strokeWidth: 0 }}
          />
          <Bar
            dataKey="noShow"
            fill="hsl(var(--destructive))"
            radius={[3, 3, 0, 0]}
            maxBarSize={14}
            opacity={0.9}
          />
        </ComposedChart>
      </ChartContainer>
    </>
  );
}
