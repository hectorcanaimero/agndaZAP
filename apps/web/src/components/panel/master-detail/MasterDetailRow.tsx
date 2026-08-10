'use client';

import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

interface MasterDetailRowProps {
  /**
   * Handler que se dispara al click. En el consumidor: `() => openEdit(item)`.
   */
  onSelect: () => void;

  /**
   * `true` cuando este row corresponde al ítem activo (`kind: 'edit'`).
   * Dispara el marker vertical brand + fondo `bg-brand-50`.
   */
  active: boolean;

  /**
   * Alto del marker vertical activo. Depende del contenido — más contenido,
   * marker más largo. Los consumidores usan `h-8` (row simple, ej. horarios)
   * hasta `h-12` (row denso, ej. faq con excerpt de 2 líneas).
   *
   * Default `h-10` cubre el caso más común (row con título + meta compacta).
   */
  markerHeight?: string;

  /**
   * `role="option"` cuando el row vive dentro de un `<ul role="listbox">`.
   * Default `false` (solo botón).
   */
  optionRole?: boolean;

  children: ReactNode;
}

/**
 * Wrapper del row seleccionable de las listas master-detail. Encapsula:
 * - Estilo hover / active / focus (mismo lenguaje que conversaciones).
 * - Marker vertical brand a la izquierda cuando `active`.
 * - `aria-current` para accesibilidad.
 *
 * NO define contenido interno — cada consumidor decide qué mostrar dentro
 * (título + meta + chips, o solo horario + profesional, etc).
 */
export function MasterDetailRow({
  onSelect,
  active,
  markerHeight = 'h-10',
  optionRole = false,
  children,
}: MasterDetailRowProps) {
  return (
    <button
      type="button"
      onClick={onSelect}
      role={optionRole ? 'option' : undefined}
      aria-current={active && !optionRole ? 'true' : undefined}
      aria-selected={optionRole ? active : undefined}
      className={cn(
        'group relative flex w-full items-start gap-2.5 rounded-md px-2.5 py-2 text-left transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        active
          ? 'bg-brand-50 text-foreground'
          : 'hover:bg-accent hover:text-accent-foreground',
      )}
    >
      {active ? (
        <span
          aria-hidden="true"
          className={cn(
            'absolute left-0 top-2.5 w-0.5 rounded-r-full bg-brand-600',
            markerHeight,
          )}
        />
      ) : null}
      {children}
    </button>
  );
}
