'use client';

import { Plus } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';

interface EmptyStatePanelProps {
  /**
   * Ilustración (SVG inline). Cada consumidor pone la suya para que el empty
   * tenga personalidad propia — libro para FAQ, calendario para bloqueos,
   * silueta para profesionales, etc.
   */
  illustration: ReactNode;

  title: string;
  description: string;
  ctaLabel: string;
  onCreate: () => void;
}

/**
 * Empty state que se muestra en el panel derecho cuando no hay selección
 * (kind: 'empty'). Comparte estructura visual entre todos los master-detail
 * del panel — solo cambia la ilustración y los textos.
 *
 * Usá SVG inline con carácter — evitar íconos lucide sin contexto.
 */
export function EmptyStatePanel({
  illustration,
  title,
  description,
  ctaLabel,
  onCreate,
}: EmptyStatePanelProps) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 p-8 text-center">
      <div className="relative">{illustration}</div>
      <div className="max-w-xs space-y-1.5">
        <h2 className="text-base font-semibold tracking-tight text-foreground">
          {title}
        </h2>
        <p className="text-sm leading-relaxed text-muted-foreground">
          {description}
        </p>
      </div>
      <Button onClick={onCreate} className="mt-2 gap-1.5">
        <Plus className="h-4 w-4" aria-hidden="true" />
        {ctaLabel}
      </Button>
    </div>
  );
}
