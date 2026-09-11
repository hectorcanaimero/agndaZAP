---
titulo: Flujo del asistente de WhatsApp
idioma: es
generado_por: archify
fecha: 2026-09-10
tags: [bot, whatsapp, fsm, rag, diagrama]
---

# Flujo del asistente — Showly

Cómo viaja un mensaje de WhatsApp desde el webhook de WAHA hasta la respuesta.
La idea central del diseño es que **lo determinista corre siempre antes que el LLM**.

> [!info] Diagrama interactivo
> HTML autocontenido generado con archify. Tema claro/oscuro, foco por nodo,
> presentación y exportación a PNG/SVG. Abrí `diagramas/showly-bot-flujo.html`
> en el navegador para la versión completa. La UI del visor está en inglés:
> `meta.locale` sólo soporta `en` y `zh-CN`.

<iframe src="diagramas/showly-bot-flujo.html" width="100%" height="760" style="border: 1px solid #333; border-radius: 8px;"></iframe>

## La escalera de decisión

Cada mensaje entrante sale por la primera puerta que aplique. El orden vive en
`BotService.handleIncoming`:

1. **Rate limit y cortacircuitos** — tope por chat/minuto y tope horario por
   clínica. Al excederse no responde nada. Fail-open si Redis está caído.
2. **Registro** — upsert de `Conversation`, `Message` entrante, avatar en background.
3. **Estado `HUMAN`** — si recepción tomó la conversación, el bot calla.
4. **Escape a humano** — desde cualquier punto, incluso a mitad de la FSM.
5. **FSM activa** — se procesa el paso y termina ahí, sin gastar un token.
6. **Saludo** — por regex; menciona la cita próxima si el número tiene una.
7. **Respuesta a recordatorio** — `SÍ` / `REAGENDAR` / `CANCELAR` por regla.
8. **Clasificador de intención** — recién acá entra el LLM, y aun así
   `IntentService.detectDeterministic` prueba prefijos primero.

Ver [[adr/0007-rate-limit-bot]] para los topes y [[notas/2026-08-08-bloque-2-fsm-scheduling]]
para el detalle de la FSM.

## Puntos de atención

- **El webhook es síncrono.** `WebhookController` espera a `handleIncoming`
  completo, incluido el delay de tipeo y hasta tres proveedores de LLM. El
  dedup en Redis cubre los reintentos de WAHA, pero meter una cola entre
  webhook y bot es el cambio de mayor impacto bajo carga.
- **Las citas se buscan por `phone`.** Una conversación que llegó por `@lid` no
  puede confirmar ni cancelar por recordatorio. Para agendar ya hay salida por
  link web firmado, ver [[adr/0018-scheduling-link-wa]].
- **La búsqueda vectorial no tiene índice.** Seq-scan sobre `FaqChunk`,
  aceptable en el MVP; revisar cuando una clínica pase de ~500 chunks. Ver
  [[notas/2026-08-09-rag-faq]].
- **El rate limit deja pasar si Redis cae**, lo mismo que el dedup.

## Fuente

`apps/backend/src/whatsapp/webhook.controller.ts` · `bot/bot.service.ts` ·
`bot/intent.service.ts` · `knowledge/knowledge.service.ts` ·
`common/llm/llm-router.service.ts` · `scheduling/` · `reminders/`

Diagrama y fuente versionados en `docs/diagramas/showly-bot-flujo.html` y
`docs/diagramas/showly-bot-flujo.workflow.json`.

Relacionado: [[arquitetura-runtime]] · [[ARCHITECTURE]] · [[SPEC]]
