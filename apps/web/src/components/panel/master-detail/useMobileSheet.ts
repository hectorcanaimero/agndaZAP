'use client';

import { useCallback, useState } from 'react';

/**
 * Estado + guard del Sheet mobile para las páginas master-detail del panel.
 *
 * Encapsula el bug clásico del rollout: si el Sheet controlled se abre en
 * desktop, Radix igual renderiza el overlay/backdrop del portal aunque el
 * content tenga `md:hidden` (el overlay NO hereda esa clase). Guard con
 * `matchMedia('(max-width: 767.98px)').matches` para abrir sólo cuando
 * corresponde. En desktop el panel derecho ya es visible, no hace falta
 * drawer.
 *
 * Uso:
 *   const sheet = useMobileSheet();
 *   sheet.openIfMobile();  // en handlers openCreate/openEdit
 *   sheet.close();         // en handlers cerrar/onSuccess/onDelete
 *   <Sheet open={sheet.isOpen} onOpenChange={sheet.onOpenChange}> ...
 */
export function useMobileSheet() {
  const [isOpen, setIsOpen] = useState(false);

  const openIfMobile = useCallback(() => {
    if (typeof window === 'undefined') return;
    if (window.matchMedia('(max-width: 767.98px)').matches) {
      setIsOpen(true);
    }
  }, []);

  const close = useCallback(() => setIsOpen(false), []);

  const onOpenChange = useCallback((next: boolean) => {
    if (!next) setIsOpen(false);
  }, []);

  return { isOpen, openIfMobile, close, onOpenChange };
}
