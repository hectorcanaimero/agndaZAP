---
title: FAQ — banner "N FAQs sin embedding" para que el operador vea por qué el bot no responde
slug: 2026-08-09-faq-embedding-banner
priority: P0
axis: States
subagent_type: general-purpose
skill: frontend-design
status: done
created: 2026-08-09
tags:
  - ux
  - priority/p0
  - axis/states
  - subagent/general-purpose
aliases:
  - faq-embedding-banner
---

# FAQ — banner "N FAQs sin embedding" para que el operador vea por qué el bot no responde

> [!warning] BLOCKER operativo
> Si el operador carga una FAQ sin que el backend tenga `OPENAI_API_KEY`, el backend
> responde 200 con header `X-Warning: embedding-skipped-no-openai-key` y persiste el
> chunk con `embedding=NULL` — pero el `FaqClient` **NUNCA lee ese header ni distingue
> visualmente** las FAQs sin embedding de las que sí tienen uno. El operador ve un
> checkmark "FAQ guardada" y asume que el bot ya responde. En realidad, la
> `KnowledgeService.retrieve` filtra por `embedding IS NOT NULL` — la FAQ está muerta.
> Cuando un paciente pregunta lo que la FAQ debería cubrir, el bot hace handoff y la
> clínica pierde el caso. Ver [[notas/2026-08-09-rag-faq|nota RAG]].

## Problema

**Evidencia** (obligatoria, con file:line):

- `apps/web/src/app/[locale]/panel/faq/FaqClient.tsx:14-20` — la interfaz `FaqChunk`
  incluye sólo `{ id, content, createdAt }`. No hay campo que indique si el chunk
  tiene embedding.
- `apps/web/src/app/[locale]/panel/faq/FaqClient.tsx:69-105` — el render de cada row
  muestra `firstLine + content + createdAt + edit/delete`. Cero señal de "esta FAQ está
  indexada" vs "esta FAQ no responde al bot todavía".
- `apps/web/src/app/[locale]/panel/faq/FaqClient.tsx:146-166` — el `onSubmit` del modal
  no lee headers de la response. `fetcher` (línea 213-277 de `apps/web/src/lib/auth.ts`)
  tampoco expone headers al caller — sólo devuelve `{ok, data}` o `{ok, status, message}`.
- `apps/backend/src/knowledge/faq.controller.ts` (referenciado desde
  [[notas/2026-08-09-rag-faq|nota RAG]]) — POST cae al fallback silencioso con el header
  `X-Warning: embedding-skipped-no-openai-key` si no hay `OPENAI_API_KEY`. Sin capturar
  este header, la UI no tiene forma de mostrarlo.
- `apps/web/src/app/[locale]/panel/faq/page.tsx:20` — el GET del server-fetch no incluye
  info de embedding en el shape (el backend controller no lo expone tampoco, per
  [[notas/2026-08-09-panel-backend-cruds|nota Panel Backend §PII]] — "response NO expone
  embedding" — pero podemos exponer un booleano `hasEmbedding` sin filtrar el vector).

**Impacto**:

- **Usuario afectado**: recepcionista (CLINIC_ADMIN) que carga FAQs; profesional/dueño que
  las revisa; super-admin en onboarding.
- **Contexto de uso**: 100% del uso de la sección FAQ. Onboarding + operación continua.
- **Magnitud**: la promesa del bot (bajar handoffs) se rompe silenciosamente. En el
  piloto donde `OPENAI_API_KEY` puede no estar configurada al principio (o falla el
  reindex), toda la operación asume que el bot responde y no lo hace. Cada FAQ muerta
  = 1 caso perdido por semana × N pacientes = decisión de compra rota. Además la
  [[notas/2026-08-09-rag-faq|nota RAG §deuda]] menciona "CLI reindex" — el operador
  necesita saber cuándo correrlo.

> [!warning]+ Priority
> **P0** — Bloquea la operación del bot (feature principal del PRD §3). Sin la señal
> visual, la clínica opera creyendo que el bot funciona cuando no. Es un fallo
> silencioso — el peor tipo de bug UX.

## Propuesta

Tres cambios coordinados:

1. **Backend (mínimo)**: agregar `hasEmbedding: boolean` al shape de `GET /api/faq` sin
   exponer el vector. Cambio en el controller: `select: { id, content, createdAt, embedding: true }`
   → mapear a `{...row, hasEmbedding: row.embedding != null, embedding: undefined}` antes
   de responder. NO se expone el vector — sólo el flag. Alternativa: `SELECT id, content, created_at, embedding IS NOT NULL as has_embedding`.
2. **Banner sticky en la parte alta** de `apps/web/src/app/[locale]/panel/faq/page.tsx`:
   - Si `count(rows where !hasEmbedding) > 0` → banner amarillo "⚠️ {n} FAQs sin indexar.
     El bot no puede responderlas. Verificá `OPENAI_API_KEY` o corré el reindex."
   - Copy nuevo: `panel.faq.notIndexedBanner`, `panel.faq.notIndexedHint`.
   - `role="status"` (no `alert` — no requiere interrupción, es informativo persistente).
3. **Badge por row** en la lista:
   - Row con `hasEmbedding: true` → sin cambio (o `Badge` verde sutil "Indexada").
   - Row con `hasEmbedding: false` → `Badge` amarilla "Sin indexar" al lado del `firstLine`.
   - Aria: `aria-label="FAQ sin indexar — el bot no puede responderla"` sobre el badge.

> [!example]- Layout propuesto
>
> ```
> ┌─────────────────────────────────────────────────┐
> │ FAQ                                             │
> │ Preguntas frecuentes para el bot.               │
> ├─────────────────────────────────────────────────┤
> │ ⚠ 3 FAQs sin indexar. El bot no puede responderlas.│  ← banner sticky, role=status
> │   Verificá OPENAI_API_KEY o corré el reindex.   │
> ├─────────────────────────────────────────────────┤
> │                              [Nueva FAQ]        │
> ├─────────────────────────────────────────────────┤
> │ ¿Cuánto dura la consulta?     [Indexada]  05/08 │
> │ La consulta dura 30 min...                      │
> ├─────────────────────────────────────────────────┤
> │ ¿Aceptan tarjeta?             [Sin indexar] 08/08│
> │ Sí, aceptamos débito y crédito...               │
> ├─────────────────────────────────────────────────┤
> │ ¿Dónde están ubicados?        [Indexada]  05/08 │
> └─────────────────────────────────────────────────┘
> ```

### Componentes involucrados

- `apps/backend/src/faq/faq.controller.ts` — cambio menor: exponer `hasEmbedding: boolean`
  (NO el vector). Test unit del controller actualizado.
- `apps/web/src/app/[locale]/panel/faq/page.tsx` — SSR: leer `hasEmbedding`, computar
  `pendingCount`, pasar a `FaqClient`.
- `apps/web/src/app/[locale]/panel/faq/FaqClient.tsx` — extender `FaqChunk` con
  `hasEmbedding`, renderizar banner + badge por row.
- `apps/web/src/components/ui/badge.tsx` — sin cambio; usar `variant="default"` con
  clase custom o agregar `variant="warning"` (opcional — el `Badge` ya soporta className).
- `apps/web/messages/es.json` + `pt.json` — nuevas keys `notIndexedBanner`,
  `notIndexedHint`, `indexed`, `notIndexed`.

> [!success] Criterios de aceptación
> - [x] Backend `GET /api/faq` responde `[{id, clinicId, content, createdAt, hasEmbedding: boolean}]`.
>   El vector NUNCA se expone (test unit `vector embedding NUNCA se expone en la
>   response` — grepea el SQL y las keys de la response en 6 sub-tests).
> - [x] Con 0 FAQs sin indexar, el banner NO aparece (`pendingCount > 0 ?`).
> - [x] Con ≥1 FAQ sin indexar, el banner aparece con el count correcto (ICU
>   plural en es/pt) y `role="status"`.
> - [x] Cada row muestra el badge correcto (Indexada `bg-brand-100 text-brand-800`
>   vs Sin indexar `bg-amber-100 text-amber-900`) — mismos tokens que
>   `CONVERSATION_STATE_TOKENS` (WCAG AA validado en spec #28).
> - [x] Keys en `es.json` y `pt.json` — diff de `jq paths(scalars)` vacío
>   (paridad exacta).
> - [x] `pnpm test` (258 tests, ≥ 250 objetivo) y `pnpm build` verdes en backend
>   y web.
> - [x] Aria label del badge "Sin indexar": `t('notIndexedAriaLabel')` =
>   "FAQ sin indexar — el bot no puede responderla." / "FAQ sem indexação —
>   o bot não pode respondê-la." — descriptivo sin abrir detalle.

> [!note]- Fuera de scope
> - NO se implementa un botón "Reindexar" en el UI (deuda de la
>   [[notas/2026-08-09-rag-faq|nota RAG]] — el CLI `pnpm prisma:reindex-faq` sigue siendo
>   la vía).
> - NO se expone la `distance` de la búsqueda vectorial ni las citas del RAG.
> - NO se cambia el modelo de embedding ni el threshold (`maxDistance=0.5`).
> - NO se agrega paginación (con <50 FAQs por clínica el render lineal alcanza).

## Referencias

- [[PRD|PRD §3 — FAQ vía RAG]]
- [[SPEC|SPEC §1 — CRUD /api/faq]]
- [[notas/2026-08-09-rag-faq|nota RAG — KnowledgeService, fallback sin OPENAI_API_KEY]]
- [[notas/2026-08-09-panel-backend-cruds|nota Panel Backend — FAQ CRUD, "response NO expone embedding"]]

## Ejecución sugerida

- **subagent_type**: `general-purpose`
- **skill**: `frontend-design`
- **prompt para el subagente**:

```
Implementá el spec docs/ux/2026-08-09-faq-embedding-banner.md.
Contexto: AgendaZap panel FAQ. Usuario: recepcionista/CLINIC_ADMIN. El bot depende de estas
FAQs para responder por WhatsApp; sin embedding el bot hace handoff silencioso.
Restricciones:
- Cambio backend mínimo: exponer `hasEmbedding: boolean` sin exponer el vector.
- No agregar rutas ni endpoints nuevos.
- Test unit del faq.controller.ts actualizado (verifica que embedding[0] no aparece en la response).
- Sincronizar keys nuevas en ambos locales (es + pt).
Al terminar: reporte con archivos modificados + tests + build + confirmación de que la
response NO trae el vector.
```
