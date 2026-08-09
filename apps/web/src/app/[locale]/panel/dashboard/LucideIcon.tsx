import {
  TrendingDown,
  CheckCircle2,
  PieChart,
  LineChart,
  type LucideProps,
} from 'lucide-react';

/**
 * Wrapper server-safe para los iconos del dashboard.
 *
 * Motivo: `lucide-react` re-exports arrastran side-effects mínimos pero
 * consumir un ícono directo desde el server-component es correcto (no requiere
 * "use client"). Este componente centraliza el mapping name → icon y evita
 * tener múltiples imports en el page.tsx.
 */
type IconName = 'TrendingDown' | 'CheckCircle2' | 'PieChart' | 'LineChart';

const MAP: Record<IconName, React.ComponentType<LucideProps>> = {
  TrendingDown,
  CheckCircle2,
  PieChart,
  LineChart,
};

export function LucideIcon({
  name,
  ...rest
}: { name: IconName } & LucideProps) {
  const Cmp = MAP[name];
  return <Cmp {...rest} />;
}
