import { Skeleton } from '@/components/ui/skeleton';

/**
 * Skeleton genérico de página del panel/admin: título + 3 líneas + 2 cards.
 * Se usa en los `loading.tsx` de segmento; las rutas con patrón propio
 * (agenda, conversaciones) tienen su skeleton específico.
 */
export function PageSkeleton({ loadingLabel }: { loadingLabel: string }) {
  return (
    <div className="w-full space-y-6" aria-busy="true" aria-live="polite">
      <span className="sr-only">{loadingLabel}</span>
      <div className="space-y-2">
        <Skeleton className="h-7 w-56" />
        <Skeleton className="h-4 w-80 max-w-full" />
      </div>
      <div className="space-y-2">
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-11/12" />
        <Skeleton className="h-4 w-3/4" />
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Skeleton className="h-36 rounded-xl" />
        <Skeleton className="h-36 rounded-xl" />
      </div>
    </div>
  );
}
