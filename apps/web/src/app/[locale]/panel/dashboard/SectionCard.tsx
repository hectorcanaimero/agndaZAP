import { cn } from '@/lib/utils';
import { LucideIcon, type IconName } from './LucideIcon';

/**
 * Card contenedora estándar del dashboard. Unifica:
 *   - Radios y sombra sutil ('card-flat' del tailwind config).
 *   - Header con eyebrow (title uppercase tracked) + descripción opcional.
 *   - Slot `action` a la derecha (link, badge, filtro).
 *   - Ícono decorativo opcional en el header (Lucide, w-4).
 *
 * Se prefiere esta card antes que la de shadcn/ui `<Card>` para el dashboard
 * porque la de shadcn usa `shadow` default (muy fuerte sobre bg-gray-50) y no
 * respeta el ritmo tipográfico del eyebrow. Ambas coexisten sin conflicto.
 */
export interface SectionCardProps {
  title: string;
  description?: string;
  icon?: IconName;
  action?: React.ReactNode;
  className?: string;
  contentClassName?: string;
  /** Delay de animación en ms — para el stagger de entrada. */
  animationDelay?: number;
  children: React.ReactNode;
}

export function SectionCard({
  title,
  description,
  icon,
  action,
  className,
  contentClassName,
  animationDelay = 0,
  children,
}: SectionCardProps) {
  return (
    <section
      className={cn(
        'group relative flex animate-fade-up flex-col overflow-hidden rounded-2xl border border-gray-200/80 bg-white shadow-card-flat transition-shadow duration-300 ease-out-soft hover:shadow-card-lift',
        className,
      )}
      style={{ animationDelay: `${animationDelay}ms` }}
    >
      <header className="flex items-start justify-between gap-4 px-5 pt-5">
        <div className="min-w-0">
          <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-gray-500">
            {title}
          </p>
          {description ? (
            <p className="mt-1 text-sm leading-snug text-gray-600">
              {description}
            </p>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {action}
          {icon ? (
            <LucideIcon
              name={icon}
              className="h-4 w-4 text-gray-300"
              aria-hidden="true"
            />
          ) : null}
        </div>
      </header>
      <div className={cn('flex-1 px-5 pb-5 pt-4', contentClassName)}>
        {children}
      </div>
    </section>
  );
}
