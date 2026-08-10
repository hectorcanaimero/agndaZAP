/**
 * Query keys canónicos para TanStack Query.
 *
 * Convención: exportamos un objeto `queryKeys` con funciones/tuplas serializables.
 * Las mutations invalidan usando estas mismas keys (o prefijos) — así garantizamos
 * que un solo lugar define la forma de la key y no divergimos entre callers.
 *
 * Reglas:
 * - Keys estáticas: tupla `const` con un string identificador.
 * - Keys parametrizadas: función que recibe los inputs y devuelve una tupla `const`
 *   con el mismo prefijo. Cambiar el orden de los parámetros ROMPE la cache.
 * - Prefijos consistentes: al invalidar `['appointments']` se invalida cualquier
 *   `['appointments', filters]`. TanStack Query hace prefix-match automáticamente.
 *
 * @see ARCHITECTURE.md §Frontend — TanStack Query como fuente de verdad del server state.
 */
export const queryKeys = {
  services: ['services'] as const,
  professionals: ['professionals'] as const,
  businessHours: (professionalId?: string) =>
    ['businessHours', professionalId ?? 'all'] as const,
  timeOff: (professionalId?: string) =>
    ['timeOff', professionalId ?? 'all'] as const,
  faq: ['faq'] as const,
  /**
   * Lista de conversaciones. El filtro "inbox" (NEEDS_HUMAN + HUMAN) es
   * client-side merge — usamos "inbox" como key virtual y el queryFn hace las
   * 2 requests. Ver ConversationsClient.
   */
  conversations: (state?: string) =>
    ['conversations', state ?? 'all'] as const,
  conversation: (id: string) => ['conversation', id] as const,
  /**
   * Agenda: la key incluye TODOS los filtros que impactan el resultado. Cambiar
   * cualquiera de ellos crea una key nueva y refetchea; volver al anterior
   * recupera desde cache.
   */
  appointments: (filters: {
    date?: string;
    view?: string;
    professionalId?: string;
    status?: string;
  }) => ['appointments', filters] as const,
  /**
   * Disponibilidad pública. `expandedRange` cambia el `days` param — clave que
   * distingue entre 7 y 14 días.
   */
  availability: (
    slug: string,
    serviceId?: string,
    professionalId?: string,
    from?: string,
    days?: number,
  ) =>
    ['availability', slug, serviceId ?? '', professionalId ?? '', from ?? '', days ?? 7] as const,
  dashboardMetrics: ['dashboard', 'metrics'] as const,
  me: ['me'] as const,
  /**
   * Meta-info + settings de la clínica del usuario. Consumida por /panel/ajustes
   * y por otros consumidores que necesitan `timezone`/`locale`/branding
   * (ej. agenda para el slot picker).
   */
  clinicMe: ['clinicMe'] as const,
} as const;
