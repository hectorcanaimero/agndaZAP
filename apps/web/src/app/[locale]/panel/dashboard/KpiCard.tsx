'use client';

import { Area, AreaChart, ResponsiveContainer } from 'recharts';
import { cn } from '@/lib/utils';
import { DeltaBadge } from './DeltaBadge';
import { LucideIcon, type IconName } from './LucideIcon';

/**
 * KPI hero del dashboard.
 *
 * Composición vertical:
 *   - Eyebrow (uppercase tracked)
 *   - Valor grande (tabular, 32-40px)
 *   - Delta badge inline con hint textual chico
 *   - Sparkline area (30 puntos) que ocupa el bottom de la card, sangrando
 *     hasta los bordes izq/der para dar sensación de "flujo" continuo.
 *
 * El sparkline usa `<AreaChart>` de recharts con un `linearGradient` que va del
 * color activo (teal/rose) hasta transparente. No hay ejes visibles — es
 * puramente decorativo pero cuantitativo (la forma comunica tendencia).
 *
 * Cliente-only por el ResponsiveContainer de recharts (mide el DOM).
 */
export interface KpiCardProps {
  eyebrow: string;
  value: string;
  hint?: string;
  icon: IconName;
  deltaPct: number;
  deltaLabel: string; // texto para lector de pantalla, ej. "vs. mes anterior"
  invertDelta?: boolean;
  spark: number[];
  tone?: 'teal' | 'navy' | 'rose' | 'amber';
  animationDelay?: number;
  className?: string;
}

const TONE_STYLES: Record<
  NonNullable<KpiCardProps['tone']>,
  { line: string; from: string; to: string; iconClass: string }
> = {
  teal: {
    line: '#14b8a6',
    from: 'rgba(20, 184, 166, 0.28)',
    to: 'rgba(20, 184, 166, 0)',
    iconClass: 'text-teal-500',
  },
  navy: {
    line: '#1e3a8a',
    from: 'rgba(30, 58, 138, 0.24)',
    to: 'rgba(30, 58, 138, 0)',
    iconClass: 'text-brand-navy',
  },
  rose: {
    line: '#f43f5e',
    from: 'rgba(244, 63, 94, 0.24)',
    to: 'rgba(244, 63, 94, 0)',
    iconClass: 'text-rose-500',
  },
  amber: {
    line: '#f59e0b',
    from: 'rgba(245, 158, 11, 0.28)',
    to: 'rgba(245, 158, 11, 0)',
    iconClass: 'text-amber-500',
  },
};

export function KpiCard({
  eyebrow,
  value,
  hint,
  icon,
  deltaPct,
  deltaLabel,
  invertDelta = false,
  spark,
  tone = 'teal',
  animationDelay = 0,
  className,
}: KpiCardProps) {
  const styles = TONE_STYLES[tone];
  const gradientId = `spark-${tone}-${eyebrow.replace(/\s+/g, '-').toLowerCase()}`;
  const data = spark.map((v, i) => ({ i, v }));

  return (
    <div
      className={cn(
        'group relative flex animate-fade-up flex-col overflow-hidden rounded-2xl border border-gray-200/80 bg-white shadow-card-flat transition-shadow duration-300 ease-out-soft hover:shadow-card-lift',
        className,
      )}
      style={{ animationDelay: `${animationDelay}ms` }}
    >
      <div className="flex items-start justify-between gap-3 px-5 pt-5">
        <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-gray-500">
          {eyebrow}
        </p>
        <LucideIcon
          name={icon}
          className={cn('h-4 w-4 opacity-70', styles.iconClass)}
          aria-hidden="true"
        />
      </div>

      <div className="flex items-baseline justify-between gap-2 px-5 pt-2">
        <p className="text-[32px] font-semibold leading-none tracking-tight text-gray-900 tabular-nums">
          {value}
        </p>
        <DeltaBadge
          deltaPct={deltaPct}
          invert={invertDelta}
          ariaSuffix={deltaLabel}
        />
      </div>

      {hint ? (
        <p className="mt-2 px-5 text-xs text-gray-500">{hint}</p>
      ) : null}

      <div
        className="mt-3 h-12 w-full"
        aria-hidden="true"
      >
        {data.length > 1 ? (
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart
              data={data}
              margin={{ top: 4, right: 0, bottom: 0, left: 0 }}
            >
              <defs>
                <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={styles.from} />
                  <stop offset="100%" stopColor={styles.to} />
                </linearGradient>
              </defs>
              <Area
                type="monotone"
                dataKey="v"
                stroke={styles.line}
                strokeWidth={1.75}
                fill={`url(#${gradientId})`}
                isAnimationActive={false}
                dot={false}
              />
            </AreaChart>
          </ResponsiveContainer>
        ) : (
          <div className="h-full w-full bg-gradient-to-b from-gray-50 to-transparent" />
        )}
      </div>
    </div>
  );
}
