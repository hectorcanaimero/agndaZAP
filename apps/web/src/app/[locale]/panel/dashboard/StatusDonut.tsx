'use client';

import { Cell, Pie, PieChart, ResponsiveContainer } from 'recharts';
import { cn } from '@/lib/utils';
import type { AppointmentStatus, DashboardMetrics } from './types';

/**
 * StatusDonut — distribución de estados de cita (30d).
 *
 * Composición horizontal:
 *   - Donut a la izquierda con el `total` en el centro.
 *   - Leyenda estructurada a la derecha (nombre + count + %), no la leyenda
 *     nativa de recharts (que es un chaos de posicionamiento).
 *
 * Colores: usamos los tokens `APPOINTMENT_STATUS_TOKENS.dot` como fuente de
 * verdad pero mapeados a hex reales (los tokens son clases Tailwind y aquí
 * necesitamos hex para recharts). Ver STATUS_COLORS abajo.
 */
export interface StatusDonutProps {
  byStatus: DashboardMetrics['byStatus'];
  labels: {
    total: string;
    status: Record<AppointmentStatus, string>;
  };
}

const STATUS_COLORS: Record<AppointmentStatus, string> = {
  PENDIENTE: '#eab308', // yellow-500
  CONFIRMADA: '#22c55e', // green-500
  EN_RIESGO: '#f97316', // orange-500
  ATENDIDA: '#3b82f6', // blue-500
  CANCELADA: '#9ca3af', // gray-400
  NO_SHOW: '#ef4444', // red-500
};

const ORDER: AppointmentStatus[] = [
  'CONFIRMADA',
  'PENDIENTE',
  'EN_RIESGO',
  'ATENDIDA',
  'CANCELADA',
  'NO_SHOW',
];

export function StatusDonut({ byStatus, labels }: StatusDonutProps) {
  const data = ORDER.map((s) => ({
    name: labels.status[s],
    key: s,
    value: byStatus[s] ?? 0,
    fill: STATUS_COLORS[s],
  })).filter((d) => d.value > 0);

  const total = data.reduce((acc, d) => acc + d.value, 0);

  return (
    <div className="grid grid-cols-[auto_1fr] items-center gap-5">
      <div className="relative h-32 w-32 shrink-0">
        {total === 0 ? (
          <div className="flex h-full w-full items-center justify-center rounded-full border-2 border-dashed border-gray-200">
            <span className="text-xs text-gray-400">—</span>
          </div>
        ) : (
          <>
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={data}
                  dataKey="value"
                  nameKey="name"
                  innerRadius="66%"
                  outerRadius="98%"
                  paddingAngle={2}
                  stroke="#fff"
                  strokeWidth={2}
                  isAnimationActive={false}
                >
                  {data.map((entry) => (
                    <Cell key={entry.key} fill={entry.fill} />
                  ))}
                </Pie>
              </PieChart>
            </ResponsiveContainer>
            <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
              <span className="text-[9px] font-medium uppercase tracking-wide text-gray-500">
                {labels.total}
              </span>
              <span className="text-xl font-semibold tabular-nums text-gray-900">
                {total}
              </span>
            </div>
          </>
        )}
      </div>

      <ul className="grid grid-cols-1 gap-1.5">
        {ORDER.map((s) => {
          const v = byStatus[s] ?? 0;
          const pct = total === 0 ? 0 : (v / total) * 100;
          return (
            <li key={s} className="flex items-center gap-2 text-xs">
              <span
                className="inline-block h-2 w-2 rounded-full"
                style={{ backgroundColor: STATUS_COLORS[s] }}
                aria-hidden="true"
              />
              <span className="flex-1 truncate text-gray-600">
                {labels.status[s]}
              </span>
              <span
                className={cn(
                  'font-medium tabular-nums text-gray-900',
                  v === 0 && 'text-gray-400',
                )}
              >
                {v}
              </span>
              <span className="w-10 text-right text-gray-500 tabular-nums">
                {pct.toFixed(0)}%
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
