import { cn } from '@/lib/utils';
import { LucideIcon } from './LucideIcon';

/**
 * Badge de delta vs. periodo anterior.
 *
 * Convención de color:
 *   - Verde  → mejora (por defecto: subir es bueno).
 *   - Rojo   → empeora.
 *   - Gris   → sin cambio o dataset chico (delta ≈ 0).
 *
 * `invert=true` invierte la semántica (útil para no-show rate: bajar es bueno).
 * `neutral=true` fuerza gris (para métricas donde subir/bajar es neutral).
 */
export interface DeltaBadgeProps {
  deltaPct: number;
  /** Bajar es bueno (ej. no-show rate). Invierte la semántica de color. */
  invert?: boolean;
  /** Fuerza gris sin importar el signo. */
  neutral?: boolean;
  /** Formato para lectores de pantalla, ej. "vs. periodo anterior". */
  ariaSuffix?: string;
  className?: string;
}

const NEAR_ZERO = 0.005;

export function DeltaBadge({
  deltaPct,
  invert = false,
  neutral = false,
  ariaSuffix,
  className,
}: DeltaBadgeProps) {
  const abs = Math.abs(deltaPct);
  const flat = abs < NEAR_ZERO;
  const positive = deltaPct > 0;

  // Semántica: si invert, up es malo. Si neutral, siempre gris.
  const isPositive = flat ? false : invert ? !positive : positive;
  const tone: 'up' | 'down' | 'flat' = flat
    ? 'flat'
    : isPositive
    ? 'up'
    : 'down';

  const toneClasses =
    neutral || flat
      ? 'bg-gray-100 text-gray-600'
      : tone === 'up'
      ? 'bg-emerald-50 text-emerald-700'
      : 'bg-rose-50 text-rose-700';

  const IconName = flat
    ? 'Minus'
    : positive
    ? 'ArrowUpRight'
    : 'ArrowDownRight';

  const label = flat
    ? '0%'
    : `${positive ? '+' : '−'}${(abs * 100).toFixed(abs >= 1 ? 0 : 1)}%`;

  return (
    <span
      className={cn(
        'inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[11px] font-semibold tabular-nums leading-none',
        toneClasses,
        className,
      )}
      aria-label={
        ariaSuffix ? `${label} ${ariaSuffix}`.trim() : label
      }
    >
      <LucideIcon
        name={IconName}
        className="h-3 w-3"
        strokeWidth={2.5}
        aria-hidden="true"
      />
      <span aria-hidden="true">{label}</span>
    </span>
  );
}
