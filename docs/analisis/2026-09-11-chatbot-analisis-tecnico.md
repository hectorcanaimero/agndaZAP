---
titulo: Análisis técnico del asistente de WhatsApp
fecha: 2026-09-11
estado: P0 aprobado 2026-09-11 (ver planes/2026-09-11-p0-bot-reparto); P1-P3 pendientes
autor: sesión planner (Fable)
tags: [bot, whatsapp, rag, llm, fsm, analisis, checklist]
---

# Análisis técnico del asistente de WhatsApp (bot)

Base: `origin/main` en `21715e4` (PR #40 incluido). Archivos revisados:
`bot/bot.service.ts` (1.6k líneas), `bot/intent.service.ts`, `knowledge/knowledge.service.ts`,
`common/llm/llm-router.service.ts`, `whatsapp/webhook.controller.ts`,
`scheduling/scheduling-session.service.ts`, `reminders/reminders.processor.ts`,
`follow-ups/follow-ups.processor.ts`, `prisma/schema.prisma`, `apps/web/.../agendar/*`.
Los casos de matching se verificaron ejecutando las mismas regex del código.

## 1. Premisas (definidas por el owner)

| # | Premisa | Estado hoy |
|---|---|---|
| P1 | No alucinar | 🟡 Parcial. El RAG tiene guardas, pero el bot **no** ve los datos de la BD y el clasificador de intención es débil. |
| P2 | Cordial, orientado a agendar | 🟢 Copy de PR #40 bien encaminado. Faltan casos de borde (ver §4). |
| P3 | Parecer humano | 🟡 Hay delay de tipeo. Fallan: aviso de "asistente automático" en cada "hola", sin memoria de turnos, respuestas rígidas ante frases naturales. |
| P4 | Leer el RAG **y** la BD como base de conocimiento | 🔴 Solo lee `FaqChunk`. Servicios, precios, horarios, profesionales, dirección y estado de citas **no** se usan para responder preguntas. |
| P5 | Link como camino principal para agendar / reagendar / cancelar; bot como alternativa | 🔴 El link solo existe para **agendar**. No hay página ni endpoint público para reagendar o cancelar. El bot tampoco reagenda: deriva a humano. |

## 2. Cómo funciona hoy (resumen ejecutivo)

Escalera de decisión en `BotService.handleIncoming` (todo determinista antes del LLM):

1. Rate-limit por chat (15/min) y por clínica (500/h). Silencio si se supera.
2. Upsert de `Conversation` + `Message IN`. Avatar en background.
3. `state = HUMAN` → silencio.
4. Escape a humano por palabra (`humano`, `persona`, `operador`…, `hablar con`).
5. FSM activa (`flowStep`) → se procesa el paso y termina.
6. Saludo por regex (`^hola|buenas|hey…`) → saludo, con contexto de cita si el número tiene una.
7. Respuesta a recordatorio por prefijo (`si|ok|dale` / `cancelar` / `reagendar`).
8. `IntentService.detect`: primero prefijos deterministas, luego LLM (`maxTokens: 5`, sin ejemplos).
9. Según intención: FSM de agendar, RAG (`KnowledgeService.answer`), pedir palabra clave, o handoff.

RAG: embedding OpenAI `text-embedding-3-small` → `<=>` en pgvector, `k=3`, umbral `0.65` →
síntesis con DeepSeek/OpenCode/Gemini (`temperature 0`, `maxTokens 200`, sentinela `NULL_ANSWER`).
Sin match o sin respuesta → `NEEDS_HUMAN` + mensaje de handoff.

Diagrama navegable: [[flujo-bot]].

## 3. Lo que está bien (conservar)

- **Determinista antes que LLM.** Recordatorios (`SÍ/CANCELAR/REAGENDAR`), FSM y saludo no dependen
  del modelo. Es la base correcta para P1.
- **Anti-alucinación en el RAG**: fuentes delimitadas, instrucción de ignorar órdenes dentro de
  las fuentes, sentinela `NULL_ANSWER` con match estricto, `temperature 0`, política
  "prefiero handoff que inventar". Sanitiza `---` en el contenido.
- **Nunca crea ni cancela sin confirmación explícita** (`CONFIRM` pide `SÍ`; intención `CANCELAR`
  pide la palabra `CANCELAR`).
- **Multi-tenant estricto**: `clinicId` parametrizado en todo el raw SQL de `knowledge.service.ts`;
  el token del link guarda `clinicSlug` y se valida contra la URL.
- **Robustez operativa**: dedup del webhook por `payload.id` (SET NX) con liberación si el bot
  falla; rate-limit y circuit breaker con fail-open; fallback en cadena de 3 proveedores LLM con
  timeout de 3 s cada uno; guard de estado terminal en recordatorios (`ATENDIDA` incluida).
- **Cero PII en logs** (hash del chatId, longitudes en vez de textos).
- **Sensación humana básica**: `startTyping` + delay proporcional al largo (0,7–4 s, jitter ±20 %),
  pools de variantes para no repetir el mismo string.
- **Copy de PR #40**: tuteo LATAM, saludo con link público sin token, saludo contextual si hay
  cita próxima, progreso visible ("Primero…", "Último paso"), errores que repiten la lista,
  cierre con servicio + profesional + recordatorio anunciado.
- **Escalado bot → web con token efímero** (ADR 0018): Redis, 30 min, un token una cita, PII
  fuera de la URL.
- **Cobertura de tests**: 39 casos en `bot.service.spec.ts`, 17 en `knowledge.service.spec.ts`,
  5 en `intent.service.spec.ts`. Buena base para refactorizar sin miedo.

## 4. Lo que está mal (bugs) y cómo resolverlo

### B1 · "Hola, quiero agendar una cita" recibe solo el saludo
`GREETING_REGEX` es `^(hola|buenas|…)\b` y corre **antes** del clasificador. Cualquier mensaje que
empiece con un saludo pierde el resto ("Buenas, ¿cuánto cuesta la limpieza?" → saludo genérico).
Verificado con la regex real.
**Fix**: tratar como saludo solo si el mensaje normalizado, sin el saludo y sin muletillas
("que tal", "buen dia", nombre de la clínica), queda vacío o con ≤ 2 tokens. Si sobra contenido,
quitar el saludo y seguir la escalera con el resto. Test: los dos ejemplos de arriba.

### B2 · "Sí, quiero agendar" y "ok gracias" se interpretan como confirmación de recordatorio
`parseReminderReply` usa `startsWithAny(['si','ok','dale',…])` y corre para **toda** conversación
sin FSM, tenga o no cita. Resultado: "No encontré una cita próxima asociada a este número".
Lo mismo hace `IntentService.detectDeterministic`.
**Fix**: (a) aceptar `SÍ/OK/DALE` como respuesta a recordatorio **solo** si el mensaje entero es
esa palabra (≤ 2 tokens) **y** hay un `Reminder` `SENT` reciente (p. ej. últimas 48 h) para ese
teléfono; (b) si no se cumple, seguir al clasificador. Test con las tres frases.

### B3 · "Es para otra persona" dispara handoff a humano
`isHumanEscape` busca el token `persona` suelto. Frases naturales ("¿puedo agendar para otra
persona?", "soy la persona que llamó") sacan al paciente del bot.
**Fix**: quitar `persona` del set de tokens sueltos; mantener `humano`, `operador`, `asesor`,
`representante` y las frases `hablar con (una persona|alguien|humano)`, `quiero una persona`.

### B4 · Mensajes sin texto (audio, imagen, sticker, ubicación) van al LLM con texto vacío
`webhook.controller.ts` solo descarta `fromMe` y `from` vacío; `body` vacío pasa a
`handleIncoming` → `intent.detect('')` → llamada al LLM → fallback. Gasta tokens y responde
raro a un audio.
**Fix**: en el webhook, si `body` está vacío o `payload.hasMedia`/`type` ∉ {`chat`,`text`},
responder sin LLM: "Por ahora solo puedo leer texto. ¿Me escribes lo que necesitas?" (una vez
por conversación cada N horas para no ser pesado). Registrar el `Message IN` con marcador
`[audio]`/`[imagen]` para la bandeja.

### B5 · "Reagendar" cancela los recordatorios y deja la cita huérfana
`handleReminderReply('RESCHEDULE')` llama a `reminders.cancelForAppointment` y marca
`NEEDS_HUMAN`, pero **no** cambia la cita. Si recepción no actúa, la cita sigue `PENDIENTE` sin
recordatorios ni `check-risk`.
**Fix**: no tocar los recordatorios hasta que exista una cita nueva. Flujo propuesto en §6 (M2).

### B6 · El aviso de "asistente automático" se repite en cada "hola"
`resolveBotMessage('greeting')` siempre concatena `AI_DISCLOSURE`. Un paciente que saluda tres
veces en la semana lo lee tres veces. Rompe P3.
**Fix**: mostrar el aviso solo si la conversación no tiene `Message OUT` en las últimas 24 h
(o guardar `disclosureShownAt` en `flowData`/columna). Mantener el requisito de ADR 0004:
siempre en el primer contacto.

### B7 · Locale `pt` recibe el bot en español
Todo el copy de `bot.service.ts`, `reminders.processor.ts` y `follow-ups.processor.ts` está
hardcodeado en español; `clinic.locale` solo cambia el formato de fecha.
**Fix**: mover los pools a un diccionario `bot.messages.{es,pt}.ts` y resolver por
`clinic.locale`. Los prefijos de `parseReminderReply` también necesitan variantes pt
(`sim`, `cancelar`, `remarcar`).

### B8 · Instrucción de tono "cercano" pide voseo
`knowledge.service.ts` → `TONE_INSTRUCTIONS.cercano` dice "con voseo (Argentina)". Contradice la
decisión de tono LATAM neutro ([[notas/2026-09-10-tono-espanol-neutro]]) y el prompt del RAG
sigue en voseo ("Sos un asistente", "Respondés", "Usá").
**Fix**: reescribir las tres instrucciones y el system prompt en tuteo neutro.

### B9 · Follow-up sin conversación previa cae al LLM
Ya documentado en [[bitacora]] 2026-09-09: `send-follow-up` manda el prompt aunque no exista
`Conversation`, así que la respuesta "5" va al clasificador.
**Fix**: hacer `upsert` de la `Conversation` por `(clinicId, chatId)` en el processor antes de
enviar, igual que hace el bot.

### B10 · El webhook es síncrono y puede superar el timeout de WAHA
`handleWaha` espera todo el pipeline: hasta 3 proveedores × 3 s + embedding + delay de tipeo
hasta 4 s. WAHA reintenta si no recibe 200 a tiempo; el dedup evita el doble proceso, pero un
reintento que llega mientras el primero sigue vivo se descarta y **el primero puede seguir
fallando**. Bajo carga, bloquea el event loop de respuestas.
**Fix**: encolar `handleIncoming` en BullMQ (`bot-inbound`) con `jobId = dedupKey` y responder
200 de inmediato. Mantener el dedup en Redis como segunda barrera.

## 5. Lo que hay que mejorar (deuda de diseño frente a las premisas)

### M1 · El bot no conoce la base de datos (P1, P4)
Solo `FaqChunk` participa en `retrieve`. Preguntas frecuentes reales de un paciente:
"¿cuánto cuesta la limpieza?", "¿atienden los sábados?", "¿qué doctores tienen?", "¿dónde
quedan?", "¿a qué hora es mi cita?". Todas tienen respuesta en `Service.priceCents`,
`BusinessHour`, `Professional.specialty`, `Clinic.address` y `Appointment`, pero el bot solo
responde si alguien duplicó ese dato en una FAQ, que además puede quedar desactualizada
(la nota del umbral RAG ya reporta chunks del seed contradiciendo la dirección real).
**Propuesta**: un `ClinicFactsService.build(clinicId, phone?)` que arme un bloque de
"fuentes estructuradas" en texto plano desde la BD, siempre fresco, y que `KnowledgeService.answer`
lo pase al LLM como `--- FUENTE BD ---` junto a los chunks. Contenido:
- Clínica: nombre, dirección, WhatsApp público, zona horaria.
- Horario de atención por día (derivado de `BusinessHour` de la clínica).
- Servicios activos: nombre, duración, precio formateado con `Clinic.currency` (si `priceCents`
  no es null; si es null, "consultar precio").
- Profesionales activos: nombre, especialidad, servicios que atienden.
- Si `phone` conocido: próxima cita del paciente (servicio, profesional, fecha, estado).
Regla anti-alucinación: el bloque se genera con formato fijo y el prompt dice explícitamente
"si un dato no aparece en las fuentes, responde NULL_ANSWER". Sin embeddings para la BD: es
pequeña (< 2 KB por clínica) y cabe entera en el prompt; evita el problema de umbral.
Cachear 60 s en Redis por clínica.

### M2 · Reagendar y cancelar por link (P5)
Hoy: agendar por link sí; reagendar/cancelar solo por bot (cancelar) o por humano (reagendar).
**Propuesta**:
- Backend: `GET /public/:slug/appointments/manage/:token` (hidrata cita) y
  `POST …/cancel`, `POST …/reschedule { startAtISO }`. Token efímero en Redis con
  `appointmentId + clinicSlug + phone`, TTL 30 min, reutilizando `SchedulingSessionService`
  con un `kind: 'manage'`. Reglas de estado según `appointment-status.util`.
- Web: página `/[locale]/agendar/[slug]/cita?t=…` con resumen de la cita, botón "Cancelar" con
  confirmación y "Cambiar horario" que reutiliza `ScheduleSelection` con el mismo servicio y
  profesional.
- Bot: en `REPROGRAMAR`/`CANCELAR` con cita encontrada, mandar el link de gestión como primera
  opción y ofrecer el camino por chat como alternativa ("o responde *CANCELAR* aquí"). El
  recordatorio y el mensaje de confirmación también llevan ese link.
- Reagendar por chat (alternativa): reusar la FSM desde `ASK_SLOT` con `serviceId` y
  `professionalId` de la cita existente; al confirmar, crear la nueva y cancelar la vieja en una
  transacción. Recién ahí cancelar los recordatorios viejos (cierra B5).

### M3 · Clasificador de intención frágil (P1)
Prompt de una línea, sin ejemplos, sin contexto de conversación, `maxTokens: 5`, y `parse` usa
`includes` (una respuesta "no es cancelar" clasifica `cancelar`). Gemini recibe system y user
concatenados. No distingue `pregunta_faq` de charla ("gracias", "ok listo") ni saludos con
contenido (B1).
**Propuesta**:
- Prompt con definición de cada intención + 2 ejemplos por clase, en el idioma de la clínica,
  con los últimos 3 mensajes como contexto y salida JSON `{intent, confidence}`.
- Agregar intenciones `AGRADECER/CERRAR` (responder "¡Con gusto!" sin LLM ni handoff) y
  `CONSULTA_CITA` ("¿a qué hora es mi cita?", resuelta desde BD con M1).
- `parse` por igualdad exacta sobre la lista; con `confidence < 0.6` → fallback con menú.
- Tests con un set de 30 frases reales de WhatsApp (corto, sin tildes, con emojis).

### M4 · FSM de agendamiento rígida (P2)
- Ofrece 6 slots de los próximos 7 días en orden; no hay "ver más", ni "otro día", ni preferencia
  ("por la tarde", "el martes"). Si los 6 no sirven, el paciente solo puede cancelar.
- Pregunta profesional antes de mostrar horarios; para muchas clínicas el paciente quiere "el
  primero disponible".
- `ASK_SLOT` solo acepta números; "el segundo", "el de las 10" no entran.
**Propuesta**: opción `0. Ver más horarios` y `Otro día` (avanza la ventana 7 días); opción
"Cualquier profesional" cuando hay más de uno (elige el primer slot libre de cualquiera);
parsing de preferencia simple por regex (mañana/tarde, día de la semana) que filtra la lista
antes de mostrarla. Cuando el paciente ya escribió dos respuestas no válidas seguidas en el
mismo paso, ofrecer el link tokenizado (`buildSchedulingLink`) como salida, que es la premisa P5.

### M5 · Memoria conversacional (P3)
Cada mensaje se clasifica aislado. "¿Y los sábados?" tras preguntar por horarios no tiene
contexto; el RAG tampoco recibe la pregunta anterior.
**Propuesta**: pasar los últimos 3 pares IN/OUT (ya están en `Message`) al clasificador y al
RAG como `--- CONTEXTO ---`, con tope de 600 caracteres. Sin PII adicional: ya vive en la BD.

### M6 · Respuestas del RAG sin salida a acción (P2, P5)
Tras responder una pregunta el bot se calla. Un humano cerraría con "¿Quieres que te agende?".
**Propuesta**: si la conversación no tiene cita próxima, anexar una línea corta con la acción
principal y el link público; si la tiene, no anexar nada (evitar ruido).

### M7 · Handoff sin expectativa de tiempo y sin retorno automático (P2, P3)
"Enseguida te atiende una persona" fuera de horario no es cierto. Y `NEEDS_HUMAN` silencia al bot
hasta que alguien libere la conversación desde el panel.
**Propuesta**: mensaje de handoff según `BusinessHour` ("Te responden en horario de atención,
lunes a viernes de 8 a 17"); job que, si nadie tomó la conversación en X horas, avisa al
paciente y devuelve el estado a `BOT`.

### M8 · Calidad del RAG (P1)
- Sin índice vectorial (aceptable en MVP, documentado).
- Umbral global 0.65; "dónde queda la clínica" sigue matcheando el chunk equivocado (nota del
  2026-09-10). Con M1 la ubicación y horarios salen de la BD y este caso desaparece.
- Falta un fallback léxico (`pg_trgm` o `ILIKE` sobre `title`) para preguntas de 2 o 3 palabras.
- Falta evaluación automatizada: un spec que corra las 9 preguntas de la nota contra un set
  fijo de embeddings grabados y verifique matches (sin llamar a OpenAI).

### M9 · Observabilidad del bot
No hay métricas por intención, tasa de handoff, tasa de `NULL_ANSWER`, ni citas por `source`.
Sin eso no se puede calibrar P1 ni medir P5.
**Propuesta**: evento Pino estructurado `bot.turn` con `{intent, source: 'rule'|'llm', handoff,
rag: {candidates, matches, minDist, nullAnswer}, latencyMs}` y una tabla en el dashboard.

## 6. Prioridad sugerida

| Prioridad | Ítems | Motivo |
|---|---|---|
| P0 (esta semana) | B1, B2, B3, B4, B8, M1 | Son los que hoy hacen quedar mal al bot en la demo y rompen P1/P4. Cambios acotados, todos con test unitario. |
| P1 | M2, B5, M3, B6 | Cumplen P5 y la sensación humana. M2 es la única feature grande (backend + web). |
| P2 | M4, M5, M6, M7, B9, B7 | Calidad conversacional. |
| P3 | B10, M8, M9 | Escala y medición. |

## 7. Checklist para las sesiones ejecutoras (pendiente de aprobación)

Reglas comunes: rama por ítem, commits atómicos, `pnpm --filter @showly/backend test` verde,
copy en tuteo LATAM, `security-auditor` en todo lo que toque `Patient`/`Appointment`, y anotar en
[[bitacora]]. No editar `bot.service.ts` desde dos ramas a la vez: coordinar por ítem.

### P0
- [ ] **B1** Saludo con contenido: extraer saludo y seguir la escalera con el resto. Tests: "hola quiero agendar", "buenas cuánto cuesta la limpieza", "hola" solo.
- [ ] **B2** `SÍ/OK/DALE` como respuesta a recordatorio solo con mensaje corto **y** recordatorio `SENT` reciente; si no, clasificar. Tests: "sí quiero agendar", "ok gracias", "sí" con recordatorio enviado.
- [ ] **B3** Quitar `persona` como token suelto de `isHumanEscape`; mantener frases. Tests: "es para otra persona" no deriva; "quiero hablar con una persona" sí.
- [ ] **B4** Webhook: mensajes sin texto (audio/imagen/sticker/ubicación) no llaman al LLM; respuesta fija con throttle por conversación; `Message IN` con marcador de tipo.
- [ ] **B8** Prompt del RAG y `TONE_INSTRUCTIONS` en tuteo neutro; eliminar la mención al voseo.
- [ ] **M1** `ClinicFactsService` + inyección como fuente en `KnowledgeService.answer`; cache 60 s; tests de formato y de que precios `null` no se inventan. Actualizar [[notas/2026-08-09-rag-faq]].

### P1
- [ ] **M2-a** Backend: token de gestión + endpoints públicos `manage/:token`, `cancel`, `reschedule` con rate-limit y validación de slug/estado. Tests + `security-auditor`.
- [ ] **M2-b** Web: página `/agendar/[slug]/cita?t=` (resumen, cancelar con confirmación, cambiar horario). E2E Playwright.
- [ ] **M2-c** Bot: `REPROGRAMAR`/`CANCELAR` con cita → link de gestión primero, chat como alternativa; link también en recordatorio y confirmación. ADR nuevo `0019-gestion-cita-por-link`.
- [ ] **B5** Reagendar por chat: reusar FSM desde `ASK_SLOT`; cancelar recordatorios viejos solo al crear la nueva cita (transacción).
- [ ] **M3** Clasificador: prompt con definiciones + ejemplos + contexto de 3 mensajes, salida JSON con confianza, `parse` exacto, intenciones `AGRADECER` y `CONSULTA_CITA`. Set de 30 frases en tests.
- [ ] **B6** `AI_DISCLOSURE` una vez por conversación cada 24 h; siempre en el primer contacto.

### P2
- [ ] **M4** FSM: "ver más horarios", "otro día", "cualquier profesional", filtro mañana/tarde y día de semana; link tokenizado tras dos fallos en el mismo paso.
- [ ] **M5** Contexto de los últimos 3 pares de mensajes al clasificador y al RAG.
- [ ] **M6** Cierre con acción tras respuesta de RAG cuando no hay cita próxima.
- [ ] **M7** Handoff con horario real de atención y retorno automático a `BOT` tras X horas sin atención.
- [ ] **B9** `send-follow-up` hace upsert de `Conversation` antes de enviar.
- [ ] **M10** Backlog (pedido del owner 2026-09-11): **leer audio**. Transcribir notas de voz con un proveedor STT (candidatos: Gemini 2.0 Flash multimodal, ya en el router; OpenAI `gpt-4o-mini-transcribe`; Deepgram) y pasar el texto por la escalera normal. Requiere descargar el media desde WAHA (`GET /api/files` o `payload.media.url`), tope de duración (60 s), coste por clínica y aviso en la política de privacidad (ADR 0004). Cuando exista, S2 deja de aplicar.
- [ ] **B7** Copy del bot, recordatorios y follow-ups por `clinic.locale` (es/pt), incluidos los prefijos de respuesta.

### Seguimiento surgido durante P0
- [ ] **S1** Extraer el rate-limit de ADR 0007 (`withinRateLimit` duplicado en `webhook.controller.ts` por PR #43 y el original en `BotService.handleIncoming`) a un helper compartido `bot/bot-rate-limit.ts`. Hacerlo después del merge de A1 para no chocar con `bot.service.ts`.
- [ ] **S2** Paciente que solo manda notas de voz (decidido 2026-09-11, delegado por el owner): el primer audio recibe el aviso "solo leo texto"; si llega un **segundo mensaje sin texto sin un texto en medio** (ventana 24 h), la conversación pasa a `NEEDS_HUMAN` y el bot responde "Te paso con una persona del equipo para escucharte". Recepción ve el `[audio]` en la bandeja. Implementar en `webhook.controller.ts` (mismo camino de PR #43). Ver `docs/notas/2026-09-11-waha-mensajes-sin-texto.md`. Implementado en PR #46 (depende de #43). Decisiones: tras el handoff la racha se reinicia; si ya está en `NEEDS_HUMAN` no se repite el mensaje; el contador es fail-open si Redis cae (mejor repetir un aviso que derivar por fallo de infra). Sustituido a futuro por M10.
- [ ] **S4** Seguridad (hallazgo PR #44): `FollowUpsService.recordFeedback(clinicId, appointmentId, …)` no verifica que la cita pertenezca a la clínica. No alcanzable hoy, pero cerrar con un `findFirst({ id, clinicId })` antes de escribir. Aplica `security-auditor`.
- [ ] **S5** Ligar `Conversation.patientId` cuando la FSM resuelve al paciente (en `handleAskSlot`/`handleConfirm`) y cuando una cita `BOT_WEB` consume el token. Sin esto, un paciente que llegó por `@lid` y agendó por la web no recibe follow-up ni se le encuentra por teléfono. Ver `docs/notas/2026-09-11-conversation-chatid-canonico.md`. Vive en `bot.service.ts`: hacerlo tras el merge de A1.
- [ ] **S3** `health.controller.spec.ts` es intermitente bajo carga (test de checks en paralelo). Preexistente; no perseguir en PRs del bot, arreglar con fake timers en un PR aparte.

### P3
- [ ] **B10** Cola `bot-inbound` en BullMQ; el webhook responde 200 al encolar.
- [ ] **M8** Fallback léxico para preguntas cortas + spec de calibración del RAG con embeddings grabados.
- [ ] **M9** Evento `bot.turn` estructurado y panel de métricas del bot (intención, handoff, `NULL_ANSWER`, citas por `source`).

## Relacionado
[[flujo-bot]] · [[adr/0007-rate-limit-bot]] · [[adr/0018-scheduling-link-wa]] ·
[[adr/0004-pii-y-compliance]] · [[notas/2026-08-09-rag-faq]] ·
[[notas/2026-09-10-rag-umbral-distancia]] · [[notas/2026-09-10-tono-espanol-neutro]] · [[SPEC]] · [[PRD]]
