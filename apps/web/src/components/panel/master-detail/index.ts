/**
 * Barrel de los helpers compartidos del patrón master-detail.
 * Consumidores: /panel/{servicios,profesionales,horarios,bloqueos,faq}.
 *
 * Cada helper resuelve un problema específico del rollout:
 * - `MasterDetailShell` — layout split card + Sheet mobile con guard.
 * - `useMobileSheet` — matchMedia guard (evita backdrop en desktop).
 * - `EmptyStatePanel` — chrome del empty (illustration + texto + CTA).
 * - `MasterDetailRow` — row seleccionable con marker vertical brand.
 *
 * Ver `docs/adr` — el patrón se estableció en el rollout de servicios (PR #6)
 * y se replicó en 4 clientes más antes de extraer estos helpers (PR #12).
 */
export { MasterDetailShell } from './MasterDetailShell';
export { EmptyStatePanel } from './EmptyStatePanel';
export { MasterDetailRow } from './MasterDetailRow';
export { useMobileSheet } from './useMobileSheet';
