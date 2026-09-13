# Spec — Bot link-first: agendar y reagendar por link, no por chat

**Fecha:** 2026-09-13
**Decisión del owner:** 2026-09-13, tras probar el bot en el VPS con `main` 6bad599
**ADR:** [[adr/0023-bot-link-first]]
**Reemplaza en parte:** [[adr/0018-scheduling-link-wa]] (el link deja de ser la excepción) y
[[adr/0020-gestion-cita-por-link]] (reagendar por chat desaparece)

## Contexto

El owner probó agendar por WhatsApp y el bot se perdió en el paso de horarios:

| Paciente escribe | Bot responde | Problema |
|---|---|---|
| `cualquera` | "Creo que no te entendí" | la errata no casa con "cualquier profesional" |
| `3` | 6 horarios, **todos del lunes 14** de 09:00 a 11:05 | cada tanda es una semana y solo se ven los 6 primeros |
| `0` (ver más) | 6 horarios del **lunes 21** | salta la semana entera: del martes 15 al viernes 18 no se llega nunca |
| `tienes para el dia 15 de septiembre` | "Ese número no está en la lista. Elige uno entre 1 y 6" | el paso de horarios solo entiende números |

No son tres bugs sueltos: elegir fecha y hora con una lista numerada por chat es frágil por
diseño, y cada arreglo (fechas en lenguaje natural, paginación por día, fuzzy matching) añade más
superficie donde el bot puede divagar. La web ya tiene un calendario, el token con prefill
(ADR 0018) y la gestión de cita (ADR 0020).

## Decisión de producto

**El chat detecta la intención y manda el link; nunca pide servicio, profesional ni horario.**

| Acción del paciente | Antes | Ahora |
|---|---|---|
| Agendar (intención `AGENDAR`) | FSM `ASK_SERVICE → … → CONFIRM` | link tokenizado `/agendar/{slug}?t=` con nombre y teléfono ya rellenados |
| Reagendar (`REAGENDAR` o intención `REPROGRAMAR`) | lista de horarios por chat (B5) | link de gestión `/agendar/{slug}/cita?t=` |
| Cancelar con la palabra exacta `CANCELAR` | cancela en el chat | **igual** (determinista, sin LLM; libera el turno sin abrir navegador) |
| Cancelar en texto libre ("no voy a poder ir") | link de gestión + "o responde CANCELAR" | **igual** |
| Confirmar asistencia (`SÍ` al recordatorio) | confirma en el chat | **igual** |
| Dudas (FAQ / RAG), `humano`, NPS | chat | **igual** |

Lo que se queda en el chat es un sí/no cerrado o una palabra fija: no hay por dónde divagar.

## Requisitos

### R1 — Agendar manda el link
- `Intent.AGENDAR` responde con un texto corto y el link **con token** (`buildSchedulingLink`),
  que llega con nombre y teléfono del chat. No toca `flowStep`.
- Si no se puede emitir el token (Redis caído), manda el link público **sin token**: agendar
  sigue funcionando, solo sin prefill. Nunca un error.
- Clínica sin servicios activos: mismo `noServices` que hoy.

### R2 — Reagendar manda el link de gestión
- `REAGENDAR` (palabra) e `Intent.REPROGRAMAR` con cita próxima → `rescheduleSlots(link)`
  ("Puedes elegir el horario nuevo aquí… tu cita actual sigue en pie").
- Sin cita próxima → mismo camino que hoy (`noUpcomingAppointment` / `cannotLinkChat`).
- Con cita pero sin link (Redis caído) → deriva a recepción (`NEEDS_HUMAN` + `cannotLinkChat`).
  No se cae a la lista de horarios por chat.
- Los recordatorios de la cita no se tocan: sigue en pie hasta que la mueva.

### R3 — Conversaciones a mitad de la FSM al desplegar
- Si llega un mensaje con `flowStep ∈ {ASK_SERVICE, ASK_PROFESSIONAL, ASK_SLOT, ASK_NAME, CONFIRM}`:
  se resetea la FSM y se aplica R1 (o R2 si `flowData.rescheduleOf`). Los pasos NPS no cambian.
- Antes de eso siguen valiendo el escape a `humano` y `CANCELAR` exacto.

### R4 — Textos sin "escríbeme *agendar* y lo hacemos aquí"
- Saludo, saludo con cita, fallback, CTA tras responder dudas, recordatorio y
  `manageLineFallback` dejan de prometer agendar o reagendar por chat. Los que listan acciones
  ofrecen el link. Siempre en `es` y `pt` (el tipo `BotCopy` obliga).
- Los overrides por clínica (`Clinic.botGreeting`, etc.) no se tocan: son texto del tenant.
- Tuteo LATAM neutro (el `i18n-check` de CI lo verifica en la web; en el bot, a mano).

### R5 — Flag de vuelta atrás durante el piloto
- `BOT_CHAT_BOOKING_ENABLED=true` restaura el comportamiento anterior entero (FSM y textos).
  Por defecto **apagado**. Es global, no por clínica: no hay piloto todavía y un flag por tenant
  exige migración y UI.
- Cuando cierre el piloto se borra la FSM de agendamiento y el flag (PR aparte).

### R6 — WhatsApp de confirmación cuando el paciente actúa en la web
Hoy crear, mover o cancelar desde la web no manda nada por WhatsApp: el paciente vuelve al chat
sin un "listo". Con el link como único camino es obligatorio.
- Tras `POST /public/clinics/:slug/appointments` exitoso, y tras `…/manage/:token/reschedule` y
  `…/cancel`, se manda un WhatsApp al paciente con el resultado. En crear y mover lleva el link de
  gestión nuevo.
- **Solo si el paciente ya tiene conversación con la clínica** (por `conversationId` del token,
  `patientId` o teléfono; mismo criterio que `alertReception`). Nunca se abre un chat nuevo
  desde un formulario público: cualquiera puede escribir el teléfono de otro y convertir el
  número de la clínica en un emisor de spam (riesgo de baneo con WAHA no oficial).
- Se manda al `chatId` de esa conversación (sirve para `@lid`) y se persiste como `Message OUT`.
- **Fail-open**: la cita ya está hecha. Si WAHA falla, `logger.warn` y la respuesta HTTP no cambia.
- Se envía aunque la conversación esté en `HUMAN` o `NEEDS_HUMAN`: es una notificación
  transaccional, como el recordatorio, no una respuesta del bot.
- Sin PII en logs (solo `clinicId`, `apptId`, `kind`).

### R7 — Token de agendamiento caducado no pierde la reserva
- Si el POST público trae un `token` caducado o ya usado, la cita se crea como `PUBLIC` en vez de
  responder 400. El token no autoriza nada que el formulario público no permita ya; solo ata la
  conversación. Se pierde el `conversationId`, y R6 cae a la búsqueda por teléfono.
- El token de **otra clínica** (`clinicSlug` distinto) sigue siendo 400.
- Se quita "el enlace vence en 30 minutos" de los textos nuevos: el link no se rompe, solo pierde
  el prefill.

## Fuera de alcance
- Borrar la FSM de agendamiento (tras el piloto, R5).
- Parsear fechas en lenguaje natural o paginar por día: deja de hacer falta.
- Confirmación por WhatsApp para pacientes que agendan por la web sin haber escrito nunca.
- PRs abiertos #103 (guard de audio) y #105 (cota STT): tocan `bot.service.ts`; se resuelven al
  mergear, con `git merge origin/main`, nunca rebase.

## Escenarios de aceptación

```gherkin
Escenario: agendar manda el link con prefill
  Dado un paciente sin cita que escribe "quiero agendar"
  Cuando el clasificador devuelve AGENDAR
  Entonces el bot responde con un link /agendar/{slug}?t=<token>
  Y la conversación queda sin flowStep

Escenario: Redis caído al agendar
  Dado que emitir el token falla
  Cuando el paciente pide agendar
  Entonces el bot responde con el link público sin token

Escenario: reagendar desde el recordatorio
  Dado un paciente con cita próxima que responde "REAGENDAR"
  Entonces el bot responde con el link de gestión
  Y no le lista horarios por chat
  Y la cita y sus recordatorios siguen igual

Escenario: conversación atrapada en ASK_SLOT al desplegar
  Dada una conversación con flowStep = ASK_SLOT
  Cuando el paciente escribe "tienes para el 15?"
  Entonces flowStep queda en null
  Y el bot responde con el link de agendamiento

Escenario: CANCELAR sigue en el chat
  Dado un paciente con cita próxima que responde "CANCELAR"
  Entonces la cita queda CANCELADA sin abrir ningún link

Escenario: flag de vuelta atrás
  Dado BOT_CHAT_BOOKING_ENABLED=true
  Cuando el paciente pide agendar
  Entonces el bot arranca la FSM y lista los servicios

Escenario: confirmación por WhatsApp al agendar desde el link
  Dado un paciente que llegó desde el chat con un token válido
  Cuando crea la cita en la web
  Entonces recibe por WhatsApp la confirmación con el link de gestión
  Y el mensaje queda como OUT en su conversación

Escenario: sin conversación no se escribe a nadie
  Dado un teléfono que nunca escribió a la clínica
  Cuando alguien agenda en la web con ese teléfono
  Entonces no se manda ningún WhatsApp

Escenario: WAHA caído al confirmar
  Dado que WAHA falla al enviar
  Cuando el paciente cancela desde el link
  Entonces la respuesta es 200 y la cita queda CANCELADA

Escenario: token caducado en el formulario
  Dado un token de agendamiento caducado
  Cuando el paciente envía el formulario
  Entonces la cita se crea con source = PUBLIC

Escenario: token de otra clínica
  Dado un token emitido para la clínica A
  Cuando se usa en el POST de la clínica B
  Entonces la respuesta es 400
```

## Plan

Rama `feat/bot-link-first`, commits de ~100 líneas. Un PR con todo (backend) si el diff queda
revisable; si pasa de ~800 líneas, R6+R7 van en un segundo PR.

1. **Flag + R1 + R3** — `chatBookingEnabled()`; `AGENDAR` y pasos de FSM atrapados → link. Tests.
2. **R2** — `REAGENDAR` / `REPROGRAMAR` → link de gestión; sin link → recepción. Tests.
3. **R4** — textos `es`/`pt` link-first (pools nuevos seleccionados por el flag). Tests de copy.
4. **R7** — token caducado → `PUBLIC`; mismatch de slug sigue 400. Tests del controller.
5. **R6** — `PatientNotifier` (resuelve conversación, `sendText`, persiste OUT, fail-open) llamado
   desde los tres endpoints públicos. Tests: con conversación, sin ella, WAHA caído, `@lid`.
6. **Docs** — ADR 0023, SPEC §Bot y §Público, PRD, bitácora, INDEX.
7. **Verificación** — `tsc --noEmit`, suite del backend, `security-auditor` (endpoint público y
   WhatsApp saliente), `code-reviewer`. Prueba manual en el stack local del VPS.
