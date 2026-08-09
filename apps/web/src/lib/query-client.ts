import { QueryClient } from '@tanstack/react-query';

/**
 * Factory de QueryClient con defaults sensatos para el panel AgendaZap.
 *
 * - `staleTime: 30s` — la mayoría de la data del panel (agenda, contactos,
 *   configuración) no cambia tan rápido; evita refetches innecesarios al navegar
 *   entre pantallas dentro de la misma sesión.
 * - `gcTime: 5min` — el cache queda vivo un rato tras unmount para que volver
 *   a una vista recién visitada sea instantáneo.
 * - `retry: 1` — un solo reintento; los backends fallan raro cuando la auth está
 *   ok, y no queremos quemar segundos en errores 401/403/404 legítimos.
 * - `refetchOnWindowFocus: false` — molesta al recepcionista si vuelve del email
 *   y todo se recarga; en el panel preferimos refetches explícitos.
 *
 * @see ARCHITECTURE.md §Frontend — TanStack Query como fuente de verdad del server state.
 */
export function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        gcTime: 5 * 60_000,
        retry: 1,
        refetchOnWindowFocus: false,
      },
    },
  });
}
