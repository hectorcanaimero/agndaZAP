'use client';

import { useTranslations } from 'next-intl';
import { ReactNode, useState } from 'react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from './alert-dialog';
import { buttonVariants } from './button';
import { cn } from '@/lib/utils';

interface ConfirmDialogProps {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void | Promise<void>;
  title: string;
  /**
   * Descripción del diálogo. Puede ser un ReactNode para permitir énfasis
   * inline (ej: `<strong>{name}</strong>`) sin duplicar strings de i18n.
   */
  description: ReactNode;
  /** Etiqueta del botón principal (ej: "Eliminar", "Desactivar"). */
  confirmLabel: string;
  /** Etiqueta del botón cancelar. Default: `common.cancel`. */
  cancelLabel?: string;
  /**
   * `destructive` pinta el botón de confirmar en rojo (AA `bg-red-600
   * text-white` = 4.85:1). Default `default` usa el color primario.
   */
  variant?: 'default' | 'destructive';
}

/**
 * ConfirmDialog — wrapper sobre shadcn `AlertDialog` (Radix). Preserva la API
 * pública histórica del ConfirmDialog hand-rolled, para que los ~6 callers no
 * cambien tras la migración F2.
 *
 * Ventajas sobre `window.confirm()`:
 * - i18n (via next-intl) — el copy NO depende del idioma del navegador.
 * - Contexto (título + descripción con nombre del ítem) — el operador ve qué
 *   está por eliminar antes de confirmar.
 * - `role="alertdialog"` semántico (Radix se encarga).
 * - Focus trap + Escape + click en backdrop (Radix nativo).
 * - Loading state cuando `onConfirm` es async — bloquea doble-submit.
 *
 * AA: para `variant="destructive"` usamos `bg-red-600 text-white` = 4.85:1.
 */
export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  description,
  confirmLabel,
  cancelLabel,
  variant = 'default',
}: ConfirmDialogProps) {
  const tCommon = useTranslations('common');
  const [busy, setBusy] = useState(false);

  async function handleConfirm(event: React.MouseEvent<HTMLButtonElement>) {
    // Prevent Radix default close-on-action; queremos cerrar sólo cuando
    // termine `onConfirm` (para poder mostrar el estado "…").
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    try {
      await onConfirm();
    } finally {
      setBusy(false);
    }
  }

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        // Sólo propagamos "closing" externamente (evitamos re-abrir por click en
        // trigger fantasma). También bloqueamos cierre mientras `busy` es true.
        if (!next && !busy) onClose();
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="text-sm text-gray-700">{description}</div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy} onClick={onClose}>
            {cancelLabel ?? tCommon('cancel')}
          </AlertDialogCancel>
          <AlertDialogAction
            disabled={busy}
            onClick={handleConfirm}
            className={cn(
              buttonVariants({
                variant: variant === 'destructive' ? 'destructive' : 'default',
              }),
              // Override extra para asegurar AA: bg-red-600 = 4.85:1 sobre white.
              variant === 'destructive' &&
                'bg-red-600 text-white hover:bg-red-700 focus-visible:ring-red-500 disabled:bg-red-500',
            )}
          >
            {busy ? '…' : confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
