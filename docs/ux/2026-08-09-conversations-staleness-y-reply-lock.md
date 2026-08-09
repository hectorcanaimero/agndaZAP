---
title: Bandeja de conversaciones — staleness visible, textarea siempre editable y hint claro
slug: 2026-08-09-conversations-staleness-y-reply-lock
priority: P0
axis: States
subagent_type: general-purpose
skill: frontend-design
status: pending
created: 2026-08-09
tags:
  - ux
  - priority/p0
  - axis/states
  - subagent/general-purpose
aliases:
  - conversations-staleness
---

# Bandeja de conversaciones — staleness visible, textarea siempre editable y hint claro

> [!info] Contexto
> El panel de conversaciones ([[SPEC|SPEC §Conversaciones]] + [[ARCHITECTURE|Arquitectura →
> ConversationModule]]) es la bandeja de trabajo de la recepcionista. Hoy hace polling cada
> 15s ([[adr/0006-panel-mvp-y-deuda|ADR 0006 §9]] deja WebSocket para post-piloto). Con la
> UX actual el operador (a) no sabe cuándo se actualizó la lista, (b) no puede pre-escribir
> una respuesta mientras el paciente sigue en BOT, y (c) el reply queda silenciosamente
> deshabilitado sin conectar con el CTA de tomar la conversación.

## Problema

**Evidencia** (obligatoria, con file:line):

- `apps/web/src/app/[locale]/panel/conversaciones/ConversationsClient.tsx:47` — `POLL_INTERVAL_MS = 15000`
  hardcoded. `refetchList` (líneas 81-113) reemplaza el estado silenciosamente. Cero indicador
  visual de "última actualización hace Xs" o de "actualizando ahora". El operador no distingue
  una lista fresca de una lista de hace 15s.
- `ConversationsClient.tsx:356` — la `Textarea` de reply lleva
  `disabled={!canRelease && detail.state !== 'HUMAN'}` que evalúa a `disabled=true` cuando el
  estado es `BOT` o `NEEDS_HUMAN`. El operador NO puede pre-escribir la respuesta mientras
  toma la conversación → mata la fluidez del handoff (todo el punto de `NEEDS_HUMAN` es
  atender rápido).
- `ConversationsClient.tsx:363-368` — el botón Enviar también deshabilitado
  (`disabled={replying || !reply.trim() || detail.state !== 'HUMAN'}`) pero SIN feedback
  claro sobre POR QUÉ. Se muestra el hint `takeoverBeforeReply` (línea 372) sólo si
  `detail.state !== 'HUMAN'`, pero no está conectado como `aria-describedby` del botón
  ni del textarea. Screen reader no lo asocia.
- `ConversationsClient.tsx:302-332` — el header del detalle muestra estado + count, PERO el
  botón "Tomar" (`canTakeOver`) queda separado visualmente del hint "Tomá la conversación
  para poder responder" (línea 372, en el pie del panel). El CTA y el hint que lo justifica
  están a ~500px de distancia — el operador lo pasa por alto.
- `ConversationsClient.tsx:184-186` — el optimistic UI usa `new Date().toISOString()` para
  `createdAt` del mensaje temporal. Es la única aparición de `new Date()` naive en
  `apps/web/src` no documentada como helper UTC-anchored ([[adr/0006-panel-mvp-y-deuda|ADR 0006 §8]]).
  El fill temporal está bien, pero el timestamp mostrado no refleja la TZ de la clínica
  hasta que llegue el response real.
- `ConversationsClient.tsx:334-347` — mientras `detailLoading` es true, sólo se ve `…`
  (una elipsis). Mismo patrón hostil que otros componentes; sin skeleton de mensajes.

**Impacto**:

- **Usuario afectado**: recepcionista/CLINIC_ADMIN durante volumen alto (bandeja como flujo
  principal según [[PRD|PRD §2]]).
- **Contexto de uso**: happy path (respuesta rápida a `NEEDS_HUMAN`), race con el bot
  (mensaje entrante durante que tipea), primera conexión (data cargando).
- **Magnitud**: cada handoff pierde ~10 segundos (leer contexto → click "Tomar" → esperar →
  focus en textarea → tipear). Con 20 handoffs/día × 5 clínicas = 1,000 handoffs. Si
  reducimos 5s/handoff con la fix, son ~83 minutos/día operativos recuperados. Además
  reduce ansiedad del operador ("¿se cortó el polling?", "¿por qué no me deja enviar?").

> [!warning]+ Priority
> **P0** — Toca la bandeja, que es el flujo principal del panel según el PRD §3. Sin esto,
> la promesa "atendemos rápido" se rompe en el primer handoff real del piloto.

## Propuesta

Cuatro cambios coordinados en `ConversationsClient.tsx`:

1. **Indicador de última actualización** en el header del sidebar de convos:
   - Guardar `lastRefreshAt: Date` en state cuando termina `refetchList` con éxito.
   - Renderizar en el header del filtro un pequeño `<span aria-live="off" role="status">Hace 12s · Actualizando…</span>`
     con contador que se recalcula por render tick (`useState` + `setInterval` cada 5s;
     text-only, sin animación pesada).
   - Cuando `refetchList` está corriendo, mostrar spinner sutil o texto "Actualizando…".
   - Copy nuevo: `panel.conversations.lastRefresh` = "Actualizado hace {seconds}s",
     `panel.conversations.refreshing` = "Actualizando…".
2. **Textarea siempre editable, botón Enviar controlado**:
   - Quitar el `disabled` del `<Textarea>` (línea 356). El operador puede pre-escribir.
   - El botón "Enviar" queda `disabled={replying || !reply.trim()}` — SIN chequeo de estado.
   - Antes de enviar, en `sendReply`, si `detail.state !== 'HUMAN'`, hacer
     `await takeOver()` automáticamente ANTES del `fetcher(...reply)`. Si `takeover` falla,
     mostrar toast error "No se pudo tomar la conversación" y NO enviar.
   - Copy nuevo: `panel.conversations.autoTakeoverHint` = "Al enviar tomás la conversación
     automáticamente." (mostrar sólo cuando `!canRelease && detail.state !== 'BOT'`).
3. **Conectar CTA "Tomar" con hint** (para caso donde el operador prefiere el flujo manual):
   - Poner el hint `takeoverBeforeReply` como `aria-describedby` del textarea y el botón Enviar.
   - Mostrarlo dentro de un `<div role="note">` visualmente asociado al textarea (mismo bloque),
     no al fondo del panel.
   - Contraste: `text-orange-700 on white` = 4.83:1 (pasa AA). Verificar tras cambio.
4. **Skeleton de mensajes durante `detailLoading`**:
   - En vez de `…`, 3 bubbles skeleton alternando `justify-start` / `justify-end` con
     `animate-pulse bg-gray-100 h-8 rounded-md w-3/4`. 400ms mínimo de skeleton para evitar
     flash.

> [!example]- Layout del panel de reply propuesto (ASCII)
>
> ```
> ┌────────────────────────────────────────────────┐
> │ +58414… · 12 mensajes · Requiere humano  [Tomar]│
> ├────────────────────────────────────────────────┤
> │ ← Hola, quisiera agendar…                 09:41│
> │              Estoy revisando la agenda →  09:42│
> │ ← ¿Puedo elegir la Dra. Ana?              09:43│
> │ (skeleton bubbles si detailLoading)             │
> ├────────────────────────────────────────────────┤
> │ ┌──────────────────────────────────────────┐   │
> │ │ Escribí una respuesta...                 │   │  ← Textarea SIEMPRE editable
> │ │                                          │   │
> │ └──────────────────────────────────────────┘   │
> │ ⓘ Al enviar tomás la conversación automáticamente. │  ← Hint contextual + aria-describedby
> │ Máx. 1500 chars              [Enviar / Enviando…] │
> └────────────────────────────────────────────────┘
> ```

### Componentes involucrados

- `apps/web/src/app/[locale]/panel/conversaciones/ConversationsClient.tsx` — 4 cambios arriba.
- `apps/web/messages/es.json` + `pt.json` — nuevas keys `lastRefresh`, `refreshing`,
  `autoTakeoverHint`. Ver [[ux/2026-08-09-pt-json-panel-en-espanol|spec pt.json]] (se agregan
  DE UNA en ambos idiomas para no crear más deuda).
- Nada de cambios en el backend (`POST /:id/takeover` y `POST /:id/reply` ya existen y son
  atómicos; el auto-takeover se hace client-side chaining, no requiere endpoint nuevo).
- `apps/web/src/components/ui/toast.tsx` — nada. Ya cubierto.

> [!success] Criterios de aceptación
> - [ ] El header del sidebar de conversaciones muestra "Actualizado hace Xs" que actualiza
>   sin refetch, y muestra "Actualizando…" durante el polling.
> - [ ] La Textarea de reply se puede editar cuando el estado es BOT/NEEDS_HUMAN.
> - [ ] Al enviar reply con estado ≠ HUMAN, el frontend hace takeover primero y luego send.
>   Si takeover falla, se aborta el send y hay toast error.
> - [ ] El textarea y el botón Enviar tienen `aria-describedby` que apunta al hint contextual
>   cuando aplica.
> - [ ] Durante `detailLoading` se renderizan 3 bubbles skeleton en vez de `…`.
> - [ ] `pnpm build` limpio, tests siguen verdes (no hay tests de este file, no rompemos otros).
> - [ ] Verificar contraste orange-700/white ≥ 4.5:1 con axe-core.
> - [ ] Keys agregadas en `es.json` y `pt.json` (usar convención del spec pt.json).

> [!note]- Fuera de scope
> - NO se reemplaza el polling por WebSocket ([[adr/0006-panel-mvp-y-deuda|ADR 0006 §9]] lo
>   difiere post-piloto).
> - NO se agrega trap del Tab en el sidebar (ya cubierto por [[ux/2026-08-09-modal-focus-trap|
>   spec modal]]).
> - NO se cambia el auto-dismiss del toast (4s ya está OK).
> - NO se toca el orden cronológico de mensajes ni la lógica de sanitizeReply.
> - NO se agrega markdown en el textarea (WhatsApp es plain text).

## Referencias

- [[PRD|PRD §3.5 — Bandeja de conversaciones + handoff a humano]]
- [[SPEC|SPEC §1 Conversaciones — POST /:id/takeover, /reply, /release]]
- [[adr/0006-panel-mvp-y-deuda|ADR 0006 §8 — Toast roles y §9 WebSocket diferido]]
- [[notas/2026-08-09-panel-backend-cruds|nota Panel Backend — sanitización de replies]]

## Ejecución sugerida

- **subagent_type**: `general-purpose`
- **skill**: `frontend-design`
- **prompt para el subagente**:

```
Implementá el spec docs/ux/2026-08-09-conversations-staleness-y-reply-lock.md.
Contexto: AgendaZap, panel de conversaciones. Usuario: recepcionista con volumen alto.
Restricciones:
- No agregar libs (nada de framer-motion o similar).
- Cero cambios en backend.
- Mantener todos los tests existentes verdes.
- Skeleton usa `animate-pulse` de Tailwind (ya disponible).
- Auto-takeover NO debe crear race — verificar con simulación: si takeover retorna 409, no enviar.
Al terminar: reporte con archivos modificados + resultado del build + confirmación de acceptance criteria.
```
