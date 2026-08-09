'use client';

import { ReactNode, useEffect, useRef } from 'react';
import { cn } from '@/lib/utils';

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: ReactNode;
  className?: string;
}

/**
 * Modal hand-rolled — sin dependencias. Cierra con Esc y con click en overlay.
 * `role="dialog"` + `aria-modal="true"` para accesibilidad básica.
 *
 * Focus management (Nit-A6):
 * - Al abrir: guardamos el elemento activo previo y focamos el contenedor.
 * - Al cerrar: devolvemos el foco al elemento previo.
 * Sin trap del Tab (nice-to-have futuro).
 */
export function Modal({
  open,
  onClose,
  title,
  children,
  className,
}: ModalProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    // Bloquear scroll del body mientras el modal está abierto.
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    // Guardar el elemento con foco previo y focar el contenedor. Priorizamos
    // el primer elemento interactivo si existe, si no el contenedor (tabIndex=-1).
    previousFocusRef.current =
      (document.activeElement as HTMLElement | null) ?? null;
    const container = containerRef.current;
    if (container) {
      const focusable = container.querySelector<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      (focusable ?? container).focus();
    }

    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
      // Restaurar el foco al elemento previo (si sigue en el DOM).
      const previous = previousFocusRef.current;
      if (previous && typeof previous.focus === 'function') {
        previous.focus();
      }
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        ref={containerRef}
        tabIndex={-1}
        className={cn(
          'w-full max-w-lg rounded-lg bg-white shadow-xl outline-none',
          className,
        )}
        onClick={(e) => e.stopPropagation()}
      >
        {title ? (
          <div className="flex items-center justify-between border-b border-gray-100 px-5 py-3">
            <h2 className="text-base font-semibold text-gray-900">{title}</h2>
            <button
              type="button"
              onClick={onClose}
              aria-label="Cerrar"
              className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-700"
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 16 16"
                fill="none"
                aria-hidden="true"
              >
                <path
                  d="M4 4l8 8M12 4l-8 8"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                />
              </svg>
            </button>
          </div>
        ) : null}
        <div className="px-5 py-4">{children}</div>
      </div>
    </div>
  );
}
