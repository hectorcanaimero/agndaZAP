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
import { CHART_SERIES_TOKENS } from '@/components/ui/tokens';

const NAVY = CHART_SERIES_TOKENS.navy.color;
const TEAL = CHART_SERIES_TOKENS.teal.color;
const DESTRUCTIVE = CHART_SERIES_TOKENS.destructive.color;
const MUTED = CHART_SERIES_TOKENS.muted.color;
const GRID = CHART_SERIES_TOKENS.grid.color;
const CURSOR = CHART_SERIES_TOKENS.cursor.color;

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
      color: NAVY,
    },
    confirmed: {
      label: labels.confirmed,
      color: TEAL,
    },
    noShow: {
      label: labels.noShow,
      color: DESTRUCTIVE,
    },
  } satisfies ChartConfig;

  return (
    <>
      {/* Leyenda arriba del chart — muted, prosa. Uso dots + dashes para que
          también se distingan en print/monochrome. Es accesible (sin
          aria-hidden): el chart es role="img" y la leyenda es la única forma
          textual de saber qué serie es cuál; los dots sí son decorativos. */}
      <ul
        className="mb-3 flex list-none flex-wrap items-center gap-x-4 gap-y-1 p-0 text-xs text-gray-600"
      >
        <li className="inline-flex items-center gap-1.5">
          <span
            className="inline-block h-2.5 w-2.5 rounded-full"
            style={{ backgroundColor: NAVY }}
            aria-hidden="true"
          />
          {labels.created}
        </li>
        <li className="inline-flex items-center gap-1.5">
          <span
            className="inline-block h-2.5 w-2.5 rounded-full"
            style={{ backgroundColor: TEAL }}
            aria-hidden="true"
          />
          {labels.confirmed}
        </li>
        <li className="inline-flex items-center gap-1.5">
          <span
            className="inline-block h-2.5 w-2.5 rounded-sm"
            style={{ backgroundColor: DESTRUCTIVE }}
            aria-hidden="true"
          />
          {labels.noShow}
        </li>
      </ul>

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
              <stop offset="0%" stopColor={NAVY} stopOpacity={0.28} />
              <stop offset="100%" stopColor={NAVY} stopOpacity={0} />
            </linearGradient>
            <linearGradient id="area-confirmed" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={TEAL} stopOpacity={0.18} />
              <stop offset="100%" stopColor={TEAL} stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid
            vertical={false}
            strokeDasharray="3 3"
            stroke={GRID}
          />
          <XAxis
            dataKey="label"
            tickLine={false}
            axisLine={false}
            tick={{ fontSize: 10, fill: MUTED }}
            interval="preserveStartEnd"
            minTickGap={12}
          />
          <YAxis
            tickLine={false}
            axisLine={false}
            tick={{ fontSize: 10, fill: MUTED }}
            allowDecimals={false}
            width={28}
          />
          <ChartTooltip
            cursor={{ fill: CURSOR, opacity: 0.6 }}
            content={<ChartTooltipContent indicator="dot" />}
          />
          <Area
            type="monotone"
            dataKey="created"
            stroke={NAVY}
            strokeWidth={2}
            fill="url(#area-created)"
            dot={false}
            activeDot={{ r: 4, strokeWidth: 0 }}
          />
          <Area
            type="monotone"
            dataKey="confirmed"
            stroke={TEAL}
            strokeWidth={1.5}
            strokeDasharray="4 3"
            fill="url(#area-confirmed)"
            dot={false}
            activeDot={{ r: 3, strokeWidth: 0 }}
          />
          <Bar
            dataKey="noShow"
            fill={DESTRUCTIVE}
            radius={[3, 3, 0, 0]}
            maxBarSize={14}
            opacity={0.9}
          />
        </ComposedChart>
      </ChartContainer>
    </>
  );
}
