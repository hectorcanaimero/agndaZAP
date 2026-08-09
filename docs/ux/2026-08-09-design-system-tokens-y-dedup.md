---
title: Design system — tokens semánticos y deduplicación de paleta de estados
slug: 2026-08-09-design-system-tokens-y-dedup
priority: P1
axis: Consistency
subagent_type: general-purpose
skill: tailwind-design-system
status: pending
created: 2026-08-09
tags:
  - ux
  - priority/p1
  - axis/consistency
  - subagent/general-purpose
aliases:
  - design-system-tokens
---

# Design system — tokens semánticos y deduplicación de paleta de estados

> [!info] Contexto
> El panel ya tiene `Badge` con `APPOINTMENT_STATUS_STYLES` centralizado
> (`apps/web/src/components/ui/badge.tsx:18`), pero la misma paleta está DUPLICADA
> hand-rolled en al menos 3 lugares (agenda, dashboard chart, conversations bubbles).
> Los colores hex `#16a34a`/`#ef4444` viven inline en el SVG del dashboard, cuando ya
> existe `brand-600`/`red-500` en Tailwind. `NEEDS_HUMAN` tiene 2 estilos distintos
> según el archivo. Este spec propone consolidar y crear tokens semánticos.

## Problema

**Evidencia** (obligatoria, con file:line):

- `apps/web/src/components/ui/badge.tsx:18-25` — fuente de verdad de la paleta de status
  de citas:
  ```
  PENDIENTE: 'bg-yellow-100 text-yellow-900 border-yellow-300',
  CONFIRMADA: 'bg-green-100 text-green-900 border-green-300',
  EN_RIESGO: 'bg-orange-100 text-orange-900 border-orange-300',
  ATENDIDA: 'bg-blue-100 text-blue-900 border-blue-300',
  CANCELADA: 'bg-gray-100 text-gray-700 border-gray-300',
  NO_SHOW: 'bg-red-100 text-red-900 border-red-300',
  ```
- `apps/web/src/app/[locale]/panel/agenda/AgendaClient.tsx:404-419` — duplicación con
  variante `-50` (más liviana para bloques grandes en week view):
  ```
  function badgeBgFor(status: AppointmentStatus): string {
    switch (status) {
      case 'PENDIENTE': return 'bg-yellow-50 border-yellow-300 text-yellow-900';
      case 'CONFIRMADA': return 'bg-green-50 border-green-300 text-green-900';
      // ... 6 casos ...
    }
  }
  ```
  Cambio en la paleta ahora requiere sincronizar 2 lugares.
- `apps/web/src/app/[locale]/panel/dashboard/page.tsx:195,204` — SVG hardcodea:
  ```
  fill="#16a34a"  // brand-600
  fill="#ef4444"  // red-500
  ```
  Cambio en la paleta brand rompe el chart silenciosamente.
- `apps/web/src/app/[locale]/panel/conversaciones/ConversationsClient.tsx:384-393` —
  `stateStyle(state)` reinventa un mini design system para estados de conversación:
  ```
  BOT: 'bg-blue-100 text-blue-900 border-blue-300',       // ← igual a ATENDIDA en Badge
  NEEDS_HUMAN: 'bg-orange-100 text-orange-900 border-orange-300',  // ← igual a EN_RIESGO
  HUMAN: 'bg-green-100 text-green-900 border-green-300',  // ← igual a CONFIRMADA
  ```
  Los estados de conversación usan la MISMA paleta que los estados de cita — colisión
  semántica: si un operador ve verde en conversación piensa "confirmada", en agenda
  "confirmada" es literal.
- `apps/web/src/app/[locale]/panel/conversaciones/ConversationsClient.tsx:424-425` —
  bubble del OUT usa `bg-brand-500 text-white` — mismo contraste FALLA WCAG 2.83:1
  que el spec de [[ux/2026-08-09-schedule-form-states-y-doble-submit|ScheduleForm]].
- `apps/web/tailwind.config.ts:9-17` — la paleta `brand` sólo define 4 escalas
  (50, 500, 600, 700). Falta 100/200/300/400/800/900 para poder construir todas las
  variantes que hoy se hardcodean.
- `apps/web/src/app/[locale]/panel/PanelShell.tsx:66-68` — active state del sidebar
  usa `bg-brand-50 font-medium text-brand-700`. `brand-700` on `brand-50` = OK. Pero
  ese patrón "brand-50 fondo + brand-700 texto" se repite en varios lugares sin token.

**Impacto**:

- **Usuario afectado**: recepcionista (usa panel), profesional (usa mismo panel),
  paciente (usa el bubble en conversation view — no directamente, pero afecta contraste).
- **Contexto de uso**: todas las pantallas. Cambio de paleta = riesgo de romper cosas
  invisibles.
- **Magnitud**: 3 lugares duplicados + colisión semántica de colores + fallo de
  contraste en bubble. Refactor bien acotado: reducir superficie para todos los futuros
  cambios de branding (el `tailwind.config.ts` línea 12 comenta "la ajustamos cuando
  arranque el branding real").

> [!warning]+ Priority
> **P1** — No es blocker, pero cada spec de este audit que toca colores va a colisionar
> con la deuda si no consolidamos primero. Este spec bloquea/facilita varios refactors
> posteriores.

## Propuesta

Tres pasos:

1. **Escala `brand` completa en `tailwind.config.ts`**:
   ```ts
   brand: {
     50: '#f0fdf4',
     100: '#dcfce7',
     200: '#bbf7d0',
     300: '#86efac',
     400: '#4ade80',
     500: '#22c55e',
     600: '#16a34a',
     700: '#15803d',
     800: '#166534',
     900: '#14532d',
   }
   ```
2. **Paleta semántica** en `APPOINTMENT_STATUS_STYLES` con 2 variantes (`intense` para
   badge chico, `subtle` para bloques grandes de week view):
   ```ts
   export const APPOINTMENT_STATUS_TOKENS = {
     PENDIENTE: { intense: {...}, subtle: {...}, dot: 'bg-yellow-500' },
     ...
   }
   ```
   `AgendaClient.badgeBgFor` se elimina y consume `APPOINTMENT_STATUS_TOKENS[status].subtle`.
3. **Nueva paleta CONVERSATION_STATE_TOKENS** (distinta de la de cita — evitamos
   colisión semántica):
   ```ts
   export const CONVERSATION_STATE_TOKENS = {
     BOT: 'bg-slate-100 text-slate-800 border-slate-300',   // neutro
     NEEDS_HUMAN: 'bg-amber-100 text-amber-900 border-amber-300', // urgencia
     HUMAN: 'bg-brand-100 text-brand-800 border-brand-300', // "activo por nosotros"
   }
   ```
4. **Chart tokens** — nuevos tokens `TREND_CHART_COLORS` con clases Tailwind (usa
   `class="fill-brand-600"` etc. en el SVG en vez de `fill="#16a34a"`):
   ```
   <rect ... className="fill-brand-600"> // creadas
   <rect ... className="fill-red-500">   // no-show
   ```
5. **Bubble contraste** — `ConversationsClient` bubble OUT: reemplazar `bg-brand-500`
   por `bg-brand-600` (4.83:1 AA). Coordinar con [[ux/2026-08-09-schedule-form-states-y-doble-submit|
   ScheduleForm]] para consistencia.
6. **Documentar tokens** en un nuevo archivo `apps/web/src/components/ui/tokens.ts`
   como fuente de verdad. Exportar tanto los objetos como constantes con tipo estricto.

### Componentes involucrados

- `apps/web/tailwind.config.ts` — escala brand completa.
- `apps/web/src/components/ui/tokens.ts` (nuevo) — `APPOINTMENT_STATUS_TOKENS`,
  `CONVERSATION_STATE_TOKENS`, `TREND_CHART_COLORS`.
- `apps/web/src/components/ui/badge.tsx` — consume `APPOINTMENT_STATUS_TOKENS[s].intense`.
- `apps/web/src/app/[locale]/panel/agenda/AgendaClient.tsx` — eliminar `badgeBgFor`,
  consumir `APPOINTMENT_STATUS_TOKENS[s].subtle`.
- `apps/web/src/app/[locale]/panel/dashboard/page.tsx` — reemplazar hex por className en el SVG.
- `apps/web/src/app/[locale]/panel/conversaciones/ConversationsClient.tsx` — reemplazar
  `stateStyle` por consumo de `CONVERSATION_STATE_TOKENS`. Cambiar bubble a `bg-brand-600`.
- Todo lo demás que ya consume `Badge` se hereda sin cambios.

> [!success] Criterios de aceptación
> - [ ] Escala `brand` completa 50-900 en tailwind config.
> - [ ] `AgendaClient.badgeBgFor` eliminada.
> - [ ] SVG del dashboard usa clases Tailwind, sin hex hardcoded.
> - [ ] `stateStyle` de conversations eliminada; usa `CONVERSATION_STATE_TOKENS`.
> - [ ] Bubble OUT del chat con contraste ≥ 4.5:1 verificado.
> - [ ] Zero `#[0-9a-f]{6}` hex en `apps/web/src` fuera de `tailwind.config.ts` y `tokens.ts`
>   (grep `#[0-9a-f]{3,6}` limpio, excluyendo esos 2 archivos).
> - [ ] `pnpm build` limpio, sin warnings de purge de Tailwind.
> - [ ] Sin regresiones visuales (comparar screenshots antes/después de Agenda + Dashboard
>   + Conversations).
> - [ ] Tests siguen verdes.

> [!note]- Fuera de scope
> - NO se implementa dark mode.
> - NO se reemplaza Tailwind por CSS variables (deuda futura si se necesita themeing).
> - NO se hace redesign del branding — se documenta la paleta actual como token, listo
>   para reemplazar cuando venga el branding real ([[tailwind.config.ts]] línea 12).

## Referencias

- [[SPEC|SPEC §5 — Estándares del proyecto]]
- [[adr/0006-panel-mvp-y-deuda|ADR 0006 §Reglas duras]]
- [[ux/2026-08-09-schedule-form-states-y-doble-submit|spec ScheduleForm — contraste slot]]
- [[ux/2026-08-09-conversations-staleness-y-reply-lock|spec Conversations]]

## Ejecución sugerida

- **subagent_type**: `general-purpose`
- **skill**: `tailwind-design-system`
- **prompt para el subagente**:

```
Implementá el spec docs/ux/2026-08-09-design-system-tokens-y-dedup.md.
Contexto: AgendaZap panel, consolidación de paleta y tokens.
Restricciones:
- Cero cambio funcional (solo colores/estilos).
- Cero libs nuevas.
- Grep post-fix: `rg '#[0-9a-fA-F]{3,6}' apps/web/src` sólo debe matchear tailwind.config.ts y tokens.ts.
- Screenshot comparativo agenda + dashboard + conversations antes/después.
Al terminar: reporte con archivos modificados + build + resultado del grep + confirmación
de acceptance criteria.
```
