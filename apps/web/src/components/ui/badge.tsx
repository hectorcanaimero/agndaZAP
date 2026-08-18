import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from '@/lib/utils';
import { APPOINTMENT_STATUS_TOKENS } from './tokens';

/**
 * Estados de cita Showly. Fuente única en `tokens.ts` — cualquier badge que
 * pinte un status DEBE consumir `APPOINTMENT_STATUS_TOKENS` (contrastes WCAG AA
 * ya verificados en los specs UX).
 */
export type AppointmentStatus =
  | 'PENDIENTE'
  | 'CONFIRMADA'
  | 'EN_RIESGO'
  | 'ATENDIDA'
  | 'CANCELADA'
  | 'NO_SHOW';

const badgeVariants = cva(
  'inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2',
  {
    variants: {
      variant: {
        // Variants shadcn estándar.
        default:
          'border-transparent bg-primary text-primary-foreground shadow hover:bg-primary/80',
        secondary:
          'border-transparent bg-secondary text-secondary-foreground hover:bg-secondary/80',
        destructive:
          'border-transparent bg-destructive text-destructive-foreground shadow hover:bg-destructive/80',
        outline: 'text-foreground',
        // Variants extra Showly: appointment status (tokens semánticos).
        PENDIENTE: APPOINTMENT_STATUS_TOKENS.PENDIENTE.intense,
        CONFIRMADA: APPOINTMENT_STATUS_TOKENS.CONFIRMADA.intense,
        EN_RIESGO: APPOINTMENT_STATUS_TOKENS.EN_RIESGO.intense,
        ATENDIDA: APPOINTMENT_STATUS_TOKENS.ATENDIDA.intense,
        CANCELADA: APPOINTMENT_STATUS_TOKENS.CANCELADA.intense,
        NO_SHOW: APPOINTMENT_STATUS_TOKENS.NO_SHOW.intense,
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return (
    <div className={cn(badgeVariants({ variant }), className)} {...props} />
  );
}

export { Badge, badgeVariants };
