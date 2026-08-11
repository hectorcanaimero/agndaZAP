'use client';

import type { ReactNode } from 'react';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { cn } from '@/lib/utils';

interface MasterDetailShellProps {
  /**
   * Lista + toolbar. Va en la aside izquierda del split (~380px en desktop,
   * full-width en mobile).
   */
  sidebar: ReactNode;

  /**
   * Panel derecho — empty state o form. En desktop se renderiza inline; en
   * mobile se muestra dentro del `<Sheet>` cuando `mobile.isOpen` es true.
   */
  panel: ReactNode;

  /**
   * Estado del Sheet mobile. Provisto por `useMobileSheet()`.
   */
  mobile: {
    isOpen: boolean;
    onOpenChange: (open: boolean) => void;
  };

  /**
   * Título accesible del Sheet mobile (obligatorio para Radix a11y).
   * `sr-only` — no visible, sólo lo leen screen readers.
   */
  mobileTitle: string;

  /**
   * Si `true`, el Sheet mobile queda vacío aunque `mobile.isOpen`. Útil
   * cuando el panel derecho está en estado `empty` y no vale la pena
   * mostrar el drawer.
   */
  hidePanelInSheet?: boolean;

  /**
   * Ancho máximo del Sheet mobile en tablets/desktop chico (breakpoint `sm+`).
   * Default `sm:max-w-md` — suficiente para forms compactos.
   * FAQ usa `sm:max-w-2xl` porque el markdown editor pide más espacio.
   */
  mobileSheetMaxWidth?: string;

  /**
   * Contenido opcional que se renderiza ARRIBA del split card (fuera de él).
   * Ejemplo: banner amber "sin embedding" en FAQ. Sticky en el layout.
   */
  headerSlot?: ReactNode;
}

/**
 * Shell del layout master-detail que usan las páginas CRUD del panel
 * (servicios, profesionales, horarios, bloqueos, faq).
 *
 * Estructura:
 *   ┌───────────────────────────────────────────────────┐
 *   │ ┌────────────┐ ┌───────────────────────────────┐  │
 *   │ │  sidebar   │ │  panel (md+)                  │  │
 *   │ │  (380px)   │ │                               │  │
 *   │ └────────────┘ └───────────────────────────────┘  │
 *   └───────────────────────────────────────────────────┘
 *   Mobile <md: solo sidebar full-width + Sheet drawer con panel.
 *
 * Cero decisiones de behavior — el shell no sabe nada de qué muestra
 * cada consumidor. Sólo provee el chrome.
 */
export function MasterDetailShell({
  sidebar,
  panel,
  mobile,
  mobileTitle,
  hidePanelInSheet = false,
  mobileSheetMaxWidth = 'sm:max-w-md',
  headerSlot,
}: MasterDetailShellProps) {
  // Cuando hay headerSlot arriba, envolvemos todo en un flex-col para que el
  // split card ocupe el resto del alto. Sin header, mantenemos el card
  // stand-alone (el padre ya provee min-h-0).
  const cardClass = headerSlot
    ? 'flex min-h-0 flex-1 overflow-hidden rounded-xl border border-border bg-card shadow-sm'
    : 'flex h-full min-h-0 overflow-hidden rounded-xl border border-border bg-card shadow-sm';

  const cardMarkup = (
    <div className={cardClass}>
      {/* IZQUIERDA — sidebar (lista + toolbar) */}
      <aside className="flex min-h-0 w-full flex-col border-r border-border/60 md:w-[380px] md:shrink-0">
        {sidebar}
      </aside>

      {/* DERECHA — panel (solo md+) */}
      <section className="hidden min-h-0 flex-1 md:flex md:flex-col">
        {panel}
      </section>
    </div>
  );

  return (
    <>
      {headerSlot ? (
        <div className="flex h-full min-h-0 flex-col gap-3">
          {headerSlot}
          {cardMarkup}
        </div>
      ) : (
        cardMarkup
      )}

      {/* MOBILE — Sheet drawer con el panel */}
      <Sheet open={mobile.isOpen} onOpenChange={mobile.onOpenChange}>
        <SheetContent
          side="right"
          className={cn(
            'w-full overflow-y-auto p-0 md:hidden',
            mobileSheetMaxWidth,
          )}
        >
          <SheetHeader className="sr-only">
            <SheetTitle>{mobileTitle}</SheetTitle>
          </SheetHeader>
          {hidePanelInSheet ? null : panel}
        </SheetContent>
      </Sheet>
    </>
  );
}
