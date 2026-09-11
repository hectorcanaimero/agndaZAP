---
titulo: P0 del bot — reparto entre sesiones
fecha: 2026-09-11
estado: aprobado por el owner (P0 arranca)
tags: [bot, plan, p0, reparto]
---

# P0 del asistente de WhatsApp — reparto de tareas

Fuente de cada ítem: [[analisis/2026-09-11-chatbot-analisis-tecnico]] (secciones §4 y §5).
Cada ítem termina con un PR contra `main`. El owner mergea y despliega en Coolify (no hay auto-deploy).

## Reglas para las dos sesiones

1. Arrancar desde `origin/main` actualizado (`git fetch origin && git checkout -b <rama> origin/main`).
   El working tree de `main` local tiene borrados sin commitear (`orchestrator/`, `specs/`,
   `tasks.json`, `scripts/task-*.sh`, `.obsidian/`): **no** los incluyan en sus PRs. Usar
   worktrees en `.claude/worktrees/` si hace falta aislar.
2. Un PR por ítem (o por el grupo indicado). Commits atómicos, título `fix(bot): …` / `feat(bot): …`.
3. Copy en español LATAM neutro (tuteo). Ver [[notas/2026-09-10-tono-espanol-neutro]].
4. Tests: `pnpm --filter @showly/backend test` verde. Cada bug lleva su test de regresión con
   las frases exactas listadas abajo.
5. `code-reviewer` antes de abrir el PR. `security-auditor` en todo lo que lea `Patient` o
   `Appointment` (aplica a M1).
6. Al cerrar cada PR: entrada en [[bitacora]] y, si hubo decisión no obvia, nota en `docs/notas/`.
7. **Solo la sesión A edita `bot.service.ts` e `intent.service.ts`.** La sesión B no toca esos
   archivos; su único punto de contacto (pasar `phone` a `knowledge.answer`) queda como
   cambio de una línea que hace la sesión A al final (ver M1, paso 4).

## Sesión A (Opus) — matching y webhook

### PR A1 · B1 + B2 + B3 (una sola rama `fix/bot-matching-saludo-si-persona`)

**B1 — saludo con contenido.** Hoy `GREETING_REGEX` corre antes del clasificador y se come el
resto del mensaje. Cambio: detectar el saludo, quitarlo del texto normalizado junto con
muletillas ("que tal", "buen dia", "buenas tardes", "como estas", el nombre de la clínica).
Si lo que queda tiene ≤ 2 tokens → saludo (como hoy). Si queda más → **no** responder el
saludo; seguir la escalera (recordatorio → clasificador) con el resto del texto. Pasar el
texto recortado también a `intent.detect` y al RAG.
Tests: `"hola"` → saludo; `"hola, quiero agendar una cita"` → arranca FSM sin saludo previo;
`"buenas, cuánto cuesta la limpieza?"` → RAG; `"hola que tal"` → saludo.

**B2 — `SÍ/OK/DALE` como respuesta a recordatorio solo cuando aplica.** En `handleIncoming`
paso 2, aceptar `YES` únicamente si (a) el mensaje normalizado tiene ≤ 2 tokens y (b) existe un
`Reminder` con `status = SENT` y `sentAt` en las últimas 48 h para una cita próxima de ese
`phone` (o la conversación tiene cita próxima; elegir el criterio más simple que se pueda
testear y documentarlo). `CANCELAR` y `REAGENDAR` siguen igual (son palabras de acción, no
ambiguas). Si no aplica, el mensaje sigue al clasificador; `IntentService.detectDeterministic`
también debe dejar de mapear `si/ok/dale` a `CONFIRMAR` cuando el texto tiene más de 2 tokens.
Tests: `"sí, quiero agendar"` → FSM; `"ok gracias"` → no responde "no encontré cita" (fallback
o, mejor, un cierre breve "¡Con gusto!" sin LLM); `"sí"` con recordatorio SENT → confirma.

**B3 — `persona` no es escape a humano.** Quitar `persona` de los tokens sueltos en
`isHumanEscape` y en `detectDeterministic`. Mantener `humano`, `operador`, `asesor`,
`representante`, y frases: `hablar con`, `quiero una persona`, `atienda una persona`.
Tests: `"es para otra persona"` → no deriva; `"quiero hablar con una persona"` → deriva;
`"humano"` → deriva.

### PR A2 · B4 (rama `fix/webhook-mensajes-sin-texto`)

En `webhook.controller.ts`: si `payload.body` está vacío o `payload.hasMedia === true` o
`payload.type`/`_data.type` ∉ {`chat`, `text`} (revisar qué manda WAHA NOWEB: `ptt`, `audio`,
`image`, `sticker`, `location`, `document`), **no** llamar a `bot.handleIncoming`. En su lugar:
registrar `Conversation` (upsert por `(clinicId, chatId)`) y `Message IN` con body
`[audio]`/`[imagen]`/`[sticker]`/`[ubicación]`/`[archivo]`, y responder por `WahaService.sendText`
"Por ahora solo puedo leer mensajes de texto. ¿Me escribes lo que necesitas?" con throttle
en Redis de 1 respuesta por conversación cada 6 h (clave `bot:media-notice:{clinicId}:{chatId}`).
Persistir también el `Message OUT`. Respetar `state = HUMAN` (silencio). Sin LLM.
Tests en `webhook.controller.spec.ts`: audio → no llama al bot, sí registra y responde; segundo
audio en la misma hora → registra pero no responde; texto normal → sigue igual.
Documentar en `docs/notas/` qué campos de WAHA se usaron.
> Corrección aplicada en PR #43: si WAHA marca `hasMedia` pero `type` es `chat`/`text` y hay
> texto, el mensaje **sí** va al bot. `hasMedia` solo no basta para descartar. El camino nuevo
> replica el rate-limit de ADR 0007 (ver ítem S1 del análisis).

## Sesión B (Sonnet) — conocimiento

### PR B1 · B8 (rama `fix/rag-prompt-tuteo`)

En `knowledge.service.ts`: reescribir el system prompt de `answer` y `TONE_INSTRUCTIONS` en
tuteo neutro. Eliminar toda mención al voseo. Ejemplo para `cercano`: "Usa un tono cercano y
amable, de tú, como le hablarías a un vecino." `formal`: "Usa un tono formal y profesional, de
usted." `tecnico`: sin cambio de registro, solo precisión. El prompt principal: "Eres el
asistente de una clínica. Respondes siempre en {idioma}, en 1 o 2 oraciones…". Ajustar los
tests que aserten sobre el prompt. PR pequeño, primero.

### PR B2 · M1 (rama `feat/rag-hechos-de-la-clinica`)

Objetivo: que el RAG responda con datos reales de la BD además de las FAQ.

1. Nuevo `knowledge/clinic-facts.service.ts` con `build(clinicId, phone?: string | null): Promise<string>`
   que arma un bloque de texto plano, formato fijo, en el idioma de la clínica:
   - Clínica: nombre, dirección (si existe), WhatsApp público (si existe).
   - Horario de atención: derivado de `BusinessHour` **de la clínica** (`professionalId = null`);
     agrupar días con el mismo rango ("Lunes a viernes 8:00 a 17:00. Sábado 9:00 a 13:00.").
     Si no hay filas: "Horario: no informado".
   - Servicios activos: nombre, duración, precio con `Clinic.currency` si `priceCents` no es
     null; si es null, "precio a consultar". Nunca inventar un precio.
   - Profesionales activos: nombre, especialidad (si existe), servicios que atiende.
   - Si `phone` viene y existe `Patient`: la próxima cita (servicio, profesional, fecha en TZ
     y locale de la clínica con Luxon, estado en palabras). Solo la de **ese** teléfono y esa
     clínica (multi-tenant). Sin otros datos del paciente.
   - Tope ~2 000 caracteres; si se pasa, recortar profesionales/servicios con "…y N más".
   - Cache en Redis 60 s por `clinicId` para la parte sin paciente (`REDIS_CLIENT`).
2. `KnowledgeService.answer` acepta `phone?: string | null`. Construye las fuentes como hoy y
   agrega `--- FUENTE BD ---\n{facts}\n--- FIN FUENTE BD ---` al principio del bloque.
   **Cambio de umbral de entrada**: hoy si `retrieve` devuelve 0 matches se retorna `null` sin
   llamar al LLM. Con M1, si no hay matches de FAQ pero hay hechos de BD, igual se llama al LLM
   con solo la fuente BD; el LLM decide `NULL_ANSWER`. Mantener el corte por `KnowledgeUnavailableError`.
3. Prompt: agregar "Si el dato no aparece en las fuentes, responde NULL_ANSWER. No calcules ni
   estimes precios ni horarios que no estén escritos."
4. Wiring en `bot.service.ts` (una línea: `phone: convo.phone` en la llamada a
   `knowledge.answer`). **No lo hace la sesión B**: dejar el parámetro opcional y pedir a la
   sesión A que lo agregue en su PR A2 o en un commit aparte tras el merge de B2.
5. Tests: `clinic-facts.service.spec.ts` (formato, precio null, horario agrupado, sin fugas
   entre tenants, cita del teléfono correcto) y ampliar `knowledge.service.spec.ts` (la fuente
   BD entra al prompt; sin FAQ pero con BD → llama al LLM).
6. `security-auditor` obligatorio. Actualizar [[notas/2026-08-09-rag-faq]] y agregar
   `docs/adr/0019-rag-hechos-de-bd.md` (contexto, decisión "BD como fuente en texto plano sin
   embeddings", consecuencias).

## Asignación real (2026-09-11, 15:30)

- PR A1 → sesión Opus dueña del worktree `.claude/worktrees/a1-matching` (pendiente de confirmar nombre).
- PR A2 → sesión `agndazap-40` (Opus 5), worktree propio.
- Sesión B (B8 + M1) → sesión `agndazap-ef` (Opus 5); ninguna sesión Sonnet respondió.

## Orden y dependencias

| Sesión | 1º | 2º |
|---|---|---|
| A (Opus) | PR A1 (B1+B2+B3) | PR A2 (B4) + una línea `phone` para M1 cuando B2 esté en main |
| B (Sonnet) | PR B1 (B8) | PR B2 (M1) |

Sin dependencias entre A1 y B1/B2. A2 debe rebasar sobre main cuando B2 esté mergeado si va a
incluir el wiring de `phone`.

## Post-P0 · S5 — ligar `Conversation.patientId` (sesión A, tras merge de #42 y #47)

Rama `fix/bot-ligar-conversation-patient`. Origen: hallazgo de PR #44
([[notas/2026-09-11-conversation-chatid-canonico]]): una conversación `@lid` que agendó por
la web no se encuentra ni por `phone` ni por `patientId`, así que pierde recordatorio-respuesta,
follow-up y saludo con contexto.

**Regla**: nunca se crea un `Patient` por este ítem. Solo se liga cuando el paciente ya existe
o cuando lo crea `SchedulingService.createAppointment` (upsert por `(clinicId, phone)`).
Solo hacia adelante: sin migración ni backfill (opcional después: script idempotente que
ligue conversaciones con `phone` a su `Patient` por `(clinicId, phone)`).

Puntos de enlace:
1. **FSM, `handleConfirm` con éxito** → `conversation.update({ patientId: appt.patientId })`.
2. **Token BOT_WEB consumido** (`POST /public/:slug/appointments` con `token`): ya ata
   `appointment.conversationId`. **Nunca se rellena `conversation.phone`** con el del form: el
   número del form es declarado, y convertirlo en verificado permitiría que un chat `@lid`
   responda `SÍ`/`CANCELAR` sobre las citas de otro paciente (hallazgo de la sesión A,
   2026-09-11). Ligar `patientId` **solo si el `Patient` lo creó ese mismo
   `createAppointment`** (`patientCreated: true` en el resultado; nadie más pudo reclamarlo).
   Si el upsert encontró un paciente preexistente: no ligar; la cita queda alcanzable desde ese
   chat solo por `appointment.conversationId`. Si `conversation.phone` existe y no coincide con
   el del form: no ligar, `logger.warn` sin PII, la cita se crea igual.
2b. **Resolución acotada por conversación**: `findUpcomingAppointment` busca, en este orden,
   por `patientId` si está ligado, luego por `appointment.conversationId = convo.id`, luego por
   `phone` de la conversación. Así un chat `@lid` gestiona **sus propias** citas sin heredar el
   historial del teléfono.
3. **Oportunista**: `findUpcomingAppointment` y `greetingWithAppointment` usan el orden del
   punto 2b (`patientId` → `conversationId` → `phone`). Cuando encuentran `Patient` por el
   `phone` propio de la conversación (verificado por WAHA) y `patientId = null`, lo ligan.
   Nunca ligan a partir de un teléfono declarado.
4. Multi-tenant: todas las escrituras con `where: { id, clinicId }`.

Tests (`bot.service.spec.ts`, `public.controller.spec.ts`):
- Confirmar cita por FSM deja `conversation.patientId` = paciente de la cita.
- Cita por token con conversación `@lid` y paciente **nuevo** → liga `patientId`; `phone` sigue `null`.
- Cita por token con conversación `@lid` y paciente **preexistente** → no liga `patientId`; la cita se resuelve por `conversationId` y ese chat puede confirmarla/cancelarla, pero no otras del mismo teléfono.
- Cita por token con `phone` distinto al de la conversación → no liga, warn, la cita se crea igual.
- Conversación con `patientId` ligado y `phone = null` responde `SÍ` al recordatorio y confirma.
- Follow-up: conversación ligada por `patientId` recibe `AWAITING_NPS_SCORE` (coordinar con #44).
- Cero fuga: `patientId` de otra clínica nunca se liga.

`security-auditor` obligatorio (toca `Patient` y `Appointment`).

---

# P1 (aprobado 2026-09-11) — gestión de cita por link, clasificador, reagendar por chat

Mismas reglas que P0. Mapa de sesiones: `opus [0d6f55]` = sesión A (única que edita
`bot.service.ts`); `agndazap-40` y `agndazap-ef` = Opus libres; `sonnet` (dueña de #42) = sesión B.

## Contrato de API de M2 (para que backend y web avancen en paralelo)

Token de gestión: `SchedulingSessionService` gana `kind: 'manage'` con payload
`{ kind, appointmentId, clinicId, clinicSlug, phone }`, clave `sched:manage:<token>`, TTL hasta
`appointment.startAt` (mínimo 30 min, máximo 30 días). Se emite en: respuesta del
`POST /public/:slug/appointments` (campo `manageUrl`, para `/gracias`), recordatorios, mensaje
de confirmación del bot y respuestas del bot a `REPROGRAMAR`/`CANCELAR`. **No se consume** en
`GET`; se invalida al cancelar o reagendar.

URL web: `{WEB_BASE_URL}/{locale}/agendar/{slug}/cita?t={token}`.

| Método y ruta (bajo `/api/public/clinics/:slug`) | Respuesta |
|---|---|
| `GET /appointments/manage/:token` | `{ appointment: { id, serviceId, serviceName, professionalId, professionalName, startAtISO, durationMin, status }, clinic: { name, address, timezone, locale }, patient: { name }, canCancel, canReschedule }`. 404 si token inválido/expirado o slug no coincide. |
| `POST /appointments/manage/:token/cancel` | `{ status: 'CANCELADA' }`. 409 si el estado no permite cancelar. Cancela recordatorios. |
| `POST /appointments/manage/:token/reschedule` body `{ startAtISO }` | `{ appointment: {…nueva…}, manageUrl }`. Transacción: crea la nueva cita (misma clínica, servicio, profesional, paciente; `source` heredado; `conversationId` heredado), cancela la vieja, cancela recordatorios viejos y programa los nuevos. 409 si el slot se ocupó. Emite token nuevo. |
| Disponibilidad | La web reutiliza `GET /availability?serviceId&professionalId` existente. |

Reglas: `canCancel = canReschedule = status ∈ {PENDIENTE, CONFIRMADA, EN_RIESGO} && startAt > now`.
Rate-limit scope `manage` (10/min por token+ip). Cero PII en logs. Todas las queries con `clinicId`.

## Reparto P1

### agndazap-40 → M2-a backend (rama `feat/cita-gestion-por-link-api`)
Implementa el contrato de arriba: `SchedulingSessionService.createManage/resolveManage/invalidate`,
`SchedulingService.cancelByPatient(appointmentId, clinicId)` y `reschedule(...)` (transacción),
endpoints en `public.controller.ts`, `manageUrl` en la respuesta de creación, spec de cada
endpoint, `security-auditor`, ADR `0020-gestion-cita-por-link.md`, SPEC.md (contratos). Además `createAppointment` pasa a devolver `{ appointment, patientCreated: boolean }` (lo
necesita S5; actualizar los callers: bot, public.controller, specs). No tocar `bot.service.ts`
ni `reminders.processor.ts` (eso es M2-c).

### agndazap-ef → S4 y luego M2-b web
- **S4** (rama `fix/feedback-tenant-check`): `FollowUpsService.recordFeedback` verifica
  `appointment.findFirst({ id, clinicId })` antes de escribir; test de cross-tenant. PR chico.
- **M2-b** (rama `feat/cita-gestion-por-link-web`): página `/[locale]/agendar/[slug]/cita`
  (server component lee `?t=`, hidrata con `GET manage`, 404 amable si expiró), resumen de la
  cita, botón "Cancelar cita" con `ConfirmDialog`, "Cambiar horario" que reutiliza
  `ScheduleSelection` con `serviceId/professionalId` y llama a `reschedule`, estados de carga y
  error, i18n es/pt, `/gracias` muestra el link de gestión cuando el POST devuelve `manageUrl`.
  Mock del contrato hasta que M2-a esté en main; E2E Playwright al final.

### sonnet (sesión B) → tras rebasar #42: M3-a clasificador (rama `feat/intent-clasificador-v2`)
Solo `intent.service.ts` + spec (libre tras el merge de #47). Prompt con definición de cada
intención y 2 ejemplos por clase en el idioma de la clínica; parámetro opcional
`context: string[]` (últimos 3 mensajes, tope 600 chars); salida JSON `{ intent, confidence }`
con `parse` por igualdad exacta y fallback a `OTRO` si `confidence < 0.6` o JSON inválido;
nuevos valores `AGRADECER` y `CONSULTA_CITA` en el enum (el bot los cablea en M3-b).
Set de 30 frases reales de WhatsApp en el spec (sin tildes, con emojis, cortas). Mantener el
prefiltro determinista. `maxTokens` 40.

### opus [0d6f55] (sesión A) → en serie, tras merge de #42 y #47
1. Wiring `phone: convo.phone` a `knowledge.answer` (commit chico).
2. **S5** (spec arriba).
3. **S1** extraer el rate-limit de ADR 0007 a `bot/bot-rate-limit.ts` y usarlo en
   `bot.service.ts` y `webhook.controller.ts`.
4. **B6** `AI_DISCLOSURE` solo si no hay `Message OUT` en las últimas 24 h (siempre en el primer contacto). **Bloqueado hasta visto bueno explícito del owner**: es un requisito de compliance (ADR 0004 §7.1), el PR debe actualizar ese ADR. Si no hay respuesta, saltar y seguir con el ítem 5.
   S1 solo cuando #43 y #46 estén en main (toca `webhook.controller.ts`); si no, saltar y volver después.
5. **M2-c** (tras M2-a en main): el bot manda el link de gestión primero en `REPROGRAMAR` y
   `CANCELAR` con cita encontrada ("Puedes cambiarla o cancelarla aquí: {link}. Si prefieres,
   responde *CANCELAR* aquí mismo"), en la confirmación post-agendamiento y en
   `reminders.processor.ts`. `RESCHEDULE` deja de cancelar recordatorios (B5).
6. **B5** reagendar por chat: `REPROGRAMAR` con cita → FSM desde `ASK_SLOT` con
   `serviceId/professionalId` de la cita y `rescheduleOf: appointmentId` en `flowData`; en
   `CONFIRM` usa `SchedulingService.reschedule` de M2-a.
7. **M3-b** cablear `AGRADECER` ("¡Con gusto! Aquí estoy si necesitas algo más.", sin LLM) y
   `CONSULTA_CITA` (responde desde `findUpcomingAppointment` con link de gestión) y pasar
   `context` al clasificador.

## Después (P2 y P3)
M4, M5, M6, M7, B7 (bot) · B10, M8, M9 · M10 audio. Se reparten cuando P1 esté mergeado.
