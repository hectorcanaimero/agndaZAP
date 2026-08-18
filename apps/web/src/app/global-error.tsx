'use client';

import * as Sentry from '@sentry/nextjs';
import NextError from 'next/error';
import { useEffect } from 'react';

// Captura errores del root layout (donde `error.tsx` no llega). Debe declarar
// su propio <html>/<body> porque reemplaza al layout raíz cuando este falla.
// Patrón oficial de @sentry/nextjs para App Router.
export default function GlobalError({
  error,
}: {
  error: Error & { digest?: string };
}) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <html lang="es">
      <body>
        <NextError statusCode={0} />
      </body>
    </html>
  );
}
