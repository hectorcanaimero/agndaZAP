'use client';

import * as Sentry from '@sentry/nextjs';
import { AlertTriangle, RotateCcw } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useEffect } from 'react';
import { Button } from '@/components/ui/button';

/**
 * Pantalla de error de segmento (App Router `error.tsx`) para panel y admin.
 * - Reporta a Sentry y ofrece "Reintentar" (`reset()` re-renderiza el segmento).
 * - En producción NO muestra `error.message` (puede filtrar detalles internos);
 *   sólo el `digest` como referencia para soporte. En dev sí se ve el mensaje.
 */
export function RouteError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const t = useTranslations('common.error');

  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  const showDetails = process.env.NODE_ENV !== 'production';

  return (
    <div
      className="mx-auto flex w-full max-w-lg flex-col items-center gap-4 rounded-xl border border-border bg-card px-6 py-10 text-center shadow-sm"
    >
      <span className="flex h-12 w-12 items-center justify-center rounded-full bg-destructive/10 text-destructive">
        <AlertTriangle className="h-6 w-6" aria-hidden="true" />
      </span>
      <div className="space-y-1">
        <h1 className="text-xl font-semibold tracking-tight text-foreground">
          {t('title')}
        </h1>
        <p role="alert" className="text-sm text-muted-foreground">
          {t('description')}
        </p>
      </div>
      {showDetails ? (
        <pre className="max-w-full overflow-x-auto rounded-md bg-muted p-3 text-left text-xs text-muted-foreground">
          {error.message}
        </pre>
      ) : null}
      <Button type="button" onClick={reset} className="min-h-11 gap-2">
        <RotateCcw className="h-4 w-4" aria-hidden="true" />
        {t('retry')}
      </Button>
      {error.digest ? (
        <p className="text-xs text-muted-foreground">
          {t('reference', { digest: error.digest })}
        </p>
      ) : null}
    </div>
  );
}
