/**
 * Type-safe next-intl — declara el shape de los mensajes basándose en `es.json`
 * como source of truth. Con esto, TypeScript infiere:
 *
 * - Las **keys válidas** de `t()` y `t.rich()`. Escribir `t('foo.bar')` con una
 *   key inexistente falla en `pnpm exec tsc --noEmit` (no en runtime).
 * - Las **variables ICU** que cada string requiere. `t('offsetChip')` sin
 *   pasar `{ h }` da error de compilación, no `FORMATTING_ERROR` en el browser.
 *
 * Convención next-intl v3: `IntlMessages` en el global scope extendiendo del
 * shape del JSON. next-intl lo lee automáticamente vía módulo augmentation.
 * (v4+ usa `AppConfig`; migrar cuando actualicemos next-intl.)
 *
 * Load-bearing: `es.json` es la fuente de verdad. Los otros locales (pt.json)
 * DEBEN tener paridad estricta — se valida con `diff <(jq)` (script CI en
 * follow-up).
 *
 * Motivación (2026-08-10): en la sesión aparecieron 3 bugs post-merge del
 * mismo patrón — MISSING_MESSAGE por keys inexistentes (panel.conversations.live,
 * panel.timeOff.empty.cta, roles.CLINIC_ADMIN) y FORMATTING_ERROR por variables
 * ICU no pasadas (`hints.botGreeting` con `{clinicName}` literal). El scan
 * bash con jq atrapaba las primeras pero no las segundas — TypeScript atrapa
 * ambas de un saque.
 */
import type esMessages from './messages/es.json';

type Messages = typeof esMessages;

declare global {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  interface IntlMessages extends Messages {}
}
