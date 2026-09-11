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
