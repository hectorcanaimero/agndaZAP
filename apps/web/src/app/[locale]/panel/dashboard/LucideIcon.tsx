import {
  ArrowDownRight,
  ArrowUpRight,
  CalendarClock,
  CalendarDays,
  CheckCircle2,
  Clock3,
  DollarSign,
  LineChart,
  Minus,
  PieChart,
  Sparkles,
  Stethoscope,
  TrendingDown,
  TrendingUp,
  Users,
  Wallet,
  type LucideProps,
} from 'lucide-react';

/**
 * Wrapper server-safe para los íconos del dashboard.
 *
 * Motivo: consumir un ícono directo desde un server component es correcto
 * (no requiere "use client"). Este componente centraliza el mapping name → icon
 * para evitar múltiples imports scattered por el page.tsx y sub-componentes.
 */
type IconName =
  | 'ArrowDownRight'
  | 'ArrowUpRight'
  | 'CalendarClock'
  | 'CalendarDays'
  | 'CheckCircle2'
  | 'Clock3'
  | 'DollarSign'
  | 'LineChart'
  | 'Minus'
  | 'PieChart'
  | 'Sparkles'
  | 'Stethoscope'
  | 'TrendingDown'
  | 'TrendingUp'
  | 'Users'
  | 'Wallet';

const MAP: Record<IconName, React.ComponentType<LucideProps>> = {
  ArrowDownRight,
  ArrowUpRight,
  CalendarClock,
  CalendarDays,
  CheckCircle2,
  Clock3,
  DollarSign,
  LineChart,
  Minus,
  PieChart,
  Sparkles,
  Stethoscope,
  TrendingDown,
  TrendingUp,
  Users,
  Wallet,
};

export function LucideIcon({
  name,
  ...rest
}: { name: IconName } & LucideProps) {
  const Cmp = MAP[name];
  return <Cmp {...rest} />;
}

export type { IconName };
