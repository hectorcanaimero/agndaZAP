'use client';

import { QueryClientProvider } from '@tanstack/react-query';
import { ReactQueryDevtools } from '@tanstack/react-query-devtools';
import { useState, type ReactNode } from 'react';
import { makeQueryClient } from './query-client';

/**
 * Provider raíz de TanStack Query.
 *
 * Estrategia SSR-safe: usamos `useState(() => makeQueryClient())` en vez de un
 * singleton a nivel de módulo. Esto garantiza un `QueryClient` único por render
 * tree del cliente, evitando que múltiples requests SSR concurrentes compartan
 * el mismo cache (lo que filtraría data entre usuarios). En cliente, el
 * `useState` mantiene la misma instancia entre re-renders.
 *
 * Devtools solo en dev: en prod tree-shakea gracias al `process.env.NODE_ENV`.
 */
export function QueryProvider({ children }: { children: ReactNode }) {
  const [client] = useState(() => makeQueryClient());

  return (
    <QueryClientProvider client={client}>
      {children}
      {process.env.NODE_ENV === 'development' && (
        <ReactQueryDevtools initialIsOpen={false} />
      )}
    </QueryClientProvider>
  );
}
