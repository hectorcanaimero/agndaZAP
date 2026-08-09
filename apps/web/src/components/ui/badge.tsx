import { HTMLAttributes, forwardRef } from 'react';
import { cn } from '@/lib/utils';

/**
 * Badge para renderizar estados con colores accesibles (WCAG AA).
 *
 * Los estados de cita AgendaZap tienen paleta fija — mantenerla acá evita
 * inconsistencias entre la agenda, el detalle de cita y el dashboard.
 */
export type AppointmentStatus =
  | 'PENDIENTE'
  | 'CONFIRMADA'
  | 'EN_RIESGO'
  | 'ATENDIDA'
  | 'CANCELADA'
  | 'NO_SHOW';

export const APPOINTMENT_STATUS_STYLES: Record<AppointmentStatus, string> = {
  PENDIENTE: 'bg-yellow-100 text-yellow-900 border-yellow-300',
  CONFIRMADA: 'bg-green-100 text-green-900 border-green-300',
  EN_RIESGO: 'bg-orange-100 text-orange-900 border-orange-300',
  ATENDIDA: 'bg-blue-100 text-blue-900 border-blue-300',
  CANCELADA: 'bg-gray-100 text-gray-700 border-gray-300',
  NO_SHOW: 'bg-red-100 text-red-900 border-red-300',
};

interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  variant?: 'default' | AppointmentStatus;
}

export const Badge = forwardRef<HTMLSpanElement, BadgeProps>(
  ({ className, variant = 'default', ...props }, ref) => {
    const style =
      variant === 'default'
        ? 'bg-gray-100 text-gray-800 border-gray-300'
        : APPOINTMENT_STATUS_STYLES[variant];
    return (
      <span
        ref={ref}
        className={cn(
          'inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium',
          style,
          className,
        )}
        {...props}
      />
    );
  },
);
Badge.displayName = 'Badge';
