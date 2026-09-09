# SPEC técnico — Showly (MVP)

Complementa el [PRD](./PRD.md) y la [Arquitectura](./ARCHITECTURE.md). Aquí van los contratos,
las reglas de negocio precisas y los escenarios de aceptación (Gherkin) que definen "hecho".

---

## 1. Contratos de API (backend NestJS) (actualizado 2026-09-09)

Todas las rutas de negocio requieren JWT con `clinicId` y `role` (HS256, 24h). Prefijo global
`/api`, **excepto** `/webhooks/*` y `/ical/*` (ver `main.ts`). Paths verificados contra los
`@Controller` de `apps/backend/src` al 2026-09-09; el drift anterior está documentado en
[[auditoria/F1.1.T3]] y [[auditoria/RESUMEN-finalizacion]].

### Auth
- `POST /api/auth/login` → `{ email, password }` → `{ accessToken }`. 403 si la clínica del
  usuario no está `ACTIVE` (no aplica al SUPERADMIN, que no tiene clínica). Rate-limit por
  email hasheado: 5 fallos → 429 durante 15 min.
- `GET /api/auth/me` → usuario actual + clínica.
- (Web) `GET /api/auth/token` y `POST /api/auth/force-logout` → rutas Next.js que leen/limpian
  la cookie de sesión del panel.

### Admin SaaS (SUPERADMIN)
Todas con `@Roles('SUPERADMIN')`, base `/api/admin/*` (ADR 0014, 0016).
- `POST /api/admin/clinics` → crea clínica + user CLINIC_ADMIN (password random) + `Invitation`
  (email vía Resend).
- `GET /api/admin/clinics` / `GET /api/admin/clinics/:id` → listado/detalle de tenants.
- `PATCH /api/admin/clinics/:id` → edita tenant.
- `POST /api/admin/clinics/:id/suspend` / `POST /api/admin/clinics/:id/reactivate` → ciclo de vida.
- `POST /api/admin/clinics/:id/impersonate` → JWT temporal (30 min) con `impersonatedBy`.
  Sólo sobre clínicas `ACTIVE` (404 si no existe, 403 si está SUSPENDED/ARCHIVED).
- `GET /api/admin/metrics/overview` → métricas cross-tenant.
- `GET /api/admin/audit` → trail de auditoría paginado.

### Clínica propia (CLINIC_ADMIN)
- `GET /api/clinics/me` → datos de la clínica propia.
- `PATCH /api/clinics/me` → actualiza config (TZ, locale, `autoConfirm`, offsets, etc.).
- `GET /api/clinics/me/waha/status` → estado de la sesión WAHA (+ QR).
- `POST /api/clinics/me/waha/start` / `POST /api/clinics/me/waha/logout` → sesión WAHA.

### Catálogo (CLINIC_ADMIN)
- `CRUD /api/services`, `/api/professionals`, `/api/business-hours`, `/api/time-off`
  (`POST`, `GET`, `GET /:id` donde aplica, `PATCH /:id`, `DELETE /:id`).
- `GET /ical/professionals/:id?token=…` → feed iCal del profesional. Sin JWT (`@Public`),
  firmado con `ICAL_SECRET`; token inválido → 403 (ADR 0011).

### Pacientes (CLINIC_ADMIN)
- `GET /api/patients?q&limit&offset` · `GET /api/patients/:id` · `GET /api/patients/:id/history`.
- `PATCH /api/patients/:id` → sólo `name` y `consent`; `consent` es ratchet (false→true, nunca al revés).

### Agenda
- `GET /api/appointments/slots?serviceId&professionalId&from&days&excludeAppointmentId` →
  `Slot[]`. Slot picker del panel (agendar/reagendar); `days` se acota a [1, 30], máx. 200 slots.
  No existe `/api/availability`.
- `POST /api/appointments` → crea cita (valida slot libre) → programa recordatorios.
  `consent: true` obligatorio, sin bypass por rol.
- `GET /api/appointments?from&to&status` → agenda. `GET /api/appointments/:id` → detalle.
- `GET /api/appointments/mine` → agenda del profesional autenticado (rol PROFESSIONAL).
- `PATCH /api/appointments/:id/status` → transición controlada (422 si es ilegal).
- `PATCH /api/appointments/:id/reschedule` → mueve la cita y reprograma recordatorios.

### Conversaciones
- `GET /api/conversations?state` → bandeja. `GET /api/conversations/:id?limit` → mensajes.
- `POST /api/conversations/:id/takeover` → estado HUMAN (silencia bot).
- `POST /api/conversations/:id/reply` → mensaje manual.
- `POST /api/conversations/:id/release` → devuelve al bot (limpia `flowStep`/`flowData`).

### Público (página `/agendar/[clinicSlug]`, sin auth)
Todas con rate-limit por `slug+ip` (ADR 0003) y `SlugValidationPipe` (`^[a-z0-9-]{1,50}$`).
Clínica inexistente o no `ACTIVE` → 404 en las tres.
- `GET /api/public/clinics/:slug` → catálogo público (servicios, profesionales, TZ, dirección).
- `GET /api/public/clinics/:slug/availability?serviceId&professionalId&from&days` → `Slot[]`.
- `POST /api/public/clinics/:slug/appointments` → crea cita (201). Honeypot → 200 falso.
  Body: `serviceId, professionalId, startAt, name, phone (E.164), consent: true, token?`.
  `token` (ADR 0018) ata la cita a una conversación de WhatsApp: se consume atómicamente,
  debe pertenecer al mismo `slug` y setea `source = BOT_WEB`; inválido/expirado → 400.
- `GET /api/public/scheduling/session/:token` → hidrata el form desde el token:
  `{ clinicSlug, name, phone, phoneEditable }`. 404 si no existe o venció (TTL 30 min).

### Invitaciones (público)
- `GET /api/public/invitations/:token` → valida la invitación (existe, no expirada, no aceptada).
- `POST /api/public/invitations/:token/accept` → fija password y activa la cuenta (204).
  Ya consumida → 410 Gone. El password random inicial nunca viaja; sólo el token.

### Leads
- `POST /api/public/leads` → prospecto desde el landing (público, anti-spam, phone E.164) → 201.
- `GET /api/leads` → listado/funnel para SUPERADMIN. `LeadStatus`: NEW → CONTACTED → DEMO →
  CONVERTED | LOST.

### Feedback post-atención
- `GET /api/feedback?professionalId&limit` → listado (cap 200). Roles CLINIC_ADMIN, SUPERADMIN.
- `GET /api/feedback/summary` → total, promedio, distribución 1-5 y ranking por profesional.

### Webhook
- `POST /webhooks/waha` → eventos de WAHA (público, sin prefijo `/api`). Autenticación
  (ADR 0017), en orden:
  1. HMAC-SHA256 del body raw (`req.rawBody`) en el header `x-webhook-hmac`, timing-safe,
     con `WEBHOOK_HMAC_SECRET`. Acepta `sha256=<hex>` o `<hex>`.
  2. Fallback: header `x-webhook-token` = `WEBHOOK_TOKEN`.
  3. Sólo dev: `ALLOW_WEBHOOK_WITHOUT_TOKEN=true` y `NODE_ENV != production`.
  Si `WEBHOOK_HMAC_SECRET` está seteado, el token se ignora (anti-downgrade). Cualquier otro
  caso → **403** (fail-closed). En producción el fail-fast de `main.ts` exige al menos uno de
  los dos secretos.
- Siempre responde `200 { ok: true }` (nunca 201) para no provocar reintentos agresivos.

### Página pública (sin auth, rate-limit por slug+IP)
- `GET /api/public/clinics/:slug` → snapshot para `/agendar/[clinicSlug]` y `/gracias`:
  ```json
  {
    "id": "...", "name": "...", "slug": "...", "address": "... | null",
    "timezone": "America/Caracas", "locale": "es",
    "whatsappPhone": "+5804121234567 | null",
    "services": [{ "id", "name", "durationMin", "priceCents" }],
    "professionals": [{ "id", "name", "serviceIds": [] }]
  }
  ```
  - Solo clínicas `ACTIVE`; SUSPENDED/ARCHIVED/inexistente → 404 indistinguible.
  - `whatsappPhone` = `Clinic.publicWhatsappPhone` (opt-in desde `/panel/ajustes` →
    `PATCH /api/clinics/me { publicWhatsappPhone }`, o `POST/PATCH /api/admin/clinics`).
    Se guarda en E.164 con `+`; `""` lo borra. Si la clínica no lo configuró → `null`
    y `/gracias` no muestra el botón "Escribir a la clínica por WhatsApp" (`wa.me/<sin +>`).
  - **Nunca** se exponen teléfonos/emails de profesionales, usuarios ni pacientes,
    ni `wahaSession`/`autoConfirm`.
- `GET /api/public/clinics/:slug/availability?serviceId&professionalId&from&days` → `Slot[]`.
- `POST /api/public/clinics/:slug/appointments` → crea cita `source=PUBLIC` (honeypot + consent).

### Dashboard
- `GET /api/dashboard/metrics` → no-show rate, citas por estado, confirmaciones, tendencia.

### Salud y observabilidad
- `GET /api/health/live` → liveness sin dependencias: `{ ok, timestamp }`.
- `GET /api/health` → `{ ok, db, redis, waha, checks, timestamp }` con timeout por check.
- (Web) `GET /api/health` → `{ ok, timestamp }`.
- Logs: Pino → Axiom (JSON), `requestId` (`x-request-id`) correlacionado HTTP → BullMQ →
  WhatsApp saliente; PII redactada (`[REDACTED]`). Errores: Sentry backend + web, sólo 5xx y
  excepciones no-`HttpException`; `SENTRY_DSN` es fail-fast en prod (ADR 0015).

---

## 2. Reglas de negocio precisas (actualizado 2026-09-09)

### Disponibilidad
- Un slot es válido si: cae dentro de `BusinessHour` del profesional (o de la clínica si el
  profesional no define horario), no interseca ninguna cita activa del profesional, no interseca
  ningún `TimeOff`, y su inicio es futuro respecto al `now` en la TZ de la clínica.
- El paso entre slots es `durationMin + bufferMin` del servicio.
- `bufferMin` es tiempo ocupado **a ambos lados**: una cita existente ocupa
  `[startAt, endAt + bufferMin de su servicio)` y el slot candidato ocupa
  `[start, start + durationMin + bufferMin del servicio nuevo)`; ninguno de los dos
  intervalos puede intersecar al otro. Contra `TimeOff` y el cierre del horario sólo cuenta
  `durationMin` (el buffer puede caer en un bloqueo o fuera de horario).
- Toda hora se calcula en la TZ de la clínica.

### Creación de cita
- `phone` se guarda en formato canónico **E.164 con `+`** (`+584141234567`) mediante el helper
  único `normalizeE164` (webhook, página pública, panel y leads). Sin migración retroactiva:
  pacientes viejos creados por el bot sin `+` son deuda de merge
  (ver [[notas/2026-09-09-formato-phone-e164-y-dedup-webhook]]).
- `Patient.consent` debe ser `true` en toda creación (público y panel, sin bypass por rol) y
  sólo puede pasar de `false` a `true`. El texto aceptado cubre explícitamente el procesamiento
  con IA de terceros (OpenAI, DeepSeek, Google) según [[adr/0004-pii-y-compliance]] §7; el
  registro de `ConsentEvent` versionado y el opt-out de IA por clínica son deuda post-piloto.
- Debe validar atómicamente que el slot sigue libre (constraint `@@unique([professionalId, startAt])`).
- Estado inicial: `CONFIRMADA` si `clinic.autoConfirm`, si no `PENDIENTE`.
- Al crear, se programan recordatorios según `clinic.reminderOffsetsH`.

### Transiciones de estado permitidas
```
PENDIENTE   → CONFIRMADA | EN_RIESGO | CANCELADA
CONFIRMADA  → ATENDIDA | CANCELADA | NO_SHOW
EN_RIESGO   → CONFIRMADA | CANCELADA | NO_SHOW | ATENDIDA
```
Cualquier otra transición se rechaza con 422.

### Recordatorios
- Se programa un job por cada offset futuro. Los offsets en el pasado se omiten.
- `send-reminder` no envía si la cita ya está `CANCELADA`, `NO_SHOW` o `ATENDIDA` (PR #28).
- Confirmar cancela el job `check-risk`. Cancelar/reprogramar elimina todos los jobs de la cita.
- Idempotencia por `jobId` determinista (`reminder:{id}`, `risk:{apptId}`).
  En BullMQ, el `jobId` físico usa `reminder-{id}` y `risk-{apptId}` porque `:` es separador reservado de claves Redis; la relación lógica 1:1 se mantiene.

### Bot
- Confirmaciones (`sí`, `cancelar`, etc.) se resuelven por regla determinista antes de invocar el LLM.
- Las respuestas de recordatorio `SÍ`, `REAGENDAR` y `CANCELAR` no dependen del LLM: confirman, derivan a recepción para reagendar sin mover la cita todavía, o cancelan explícitamente la cita.
- El bot nunca crea ni cancela una cita sin confirmación explícita del paciente.
- Si `Conversation.state = HUMAN`, el bot no responde.
- La FSM de agendamiento se persiste en `Conversation.flowStep` + `flowData` y avanza por `ASK_SERVICE → ASK_PROFESSIONAL → ASK_SLOT → CONFIRM`; pasos auxiliares como captura de nombre deben preservar esos datos para que el flujo sea retomable.
- Si la conversación llega por `@lid` sin número (`phone = null`), el bot no aborta: manda un
  link `WEB_BASE_URL/{locale}/agendar/{slug}?t={token}` (token efímero en Redis, TTL 30 min,
  un token = una cita) y resetea la FSM. La cita creada por ese link queda con
  `source = BOT_WEB` y `conversationId` (ADR 0018).

### Webhook: idempotencia
- Cada evento de WAHA se deduplica por `payload.id` (clave `SET NX` en Redis con hash de
  `session + from + messageId`, TTL 24h). Repetido → se ignora sin reprocesar (evita doble
  respuesta del bot y doble cita). Sin `payload.id` → se procesa normal.
- Fail-open: si Redis falla, se procesa (mejor un duplicado que perder un mensaje) y se loguea
  `warn` sin PII.

### Impersonation y trail de auditoría (SUPERADMIN)
- Impersonation genera un JWT de 30 min con `{ sub, role: 'CLINIC_ADMIN', clinicId, impersonatedBy }`;
  el SUPERADMIN nunca lleva `clinicId` propio y sólo puede impersonar clínicas `ACTIVE`.
- Toda mutation (POST/PATCH/DELETE) bajo un JWT con `impersonatedBy` queda en `AdminAudit`
  con `action = IMPERSONATED_WRITE`, `targetType` inferido del path, `targetId` de
  `req.params.id` y `metadata = { method, path, clinicId }`. El body nunca se persiste.
- Un non-SUPERADMIN que envía `clinicId` distinto del propio recibe 403 (no se ignora en silencio).

### Feedback post-atención (ADR 0012)
- Config por profesional: `followUpEnabled` (default false) y `followUpDelayHours` (default 2, 0-168).
- Al pasar una cita a ATENDIDA se encola un job en la queue `follow-ups` con jobId
  `follow-up-{appointmentId}` (fail-open: si falla el encolado, la transición no se rompe).
- El bot captura score 1-5 en la sub-FSM `AWAITING_NPS_SCORE → AWAITING_NPS_COMMENT`.
  `Feedback.appointmentId` es unique: la segunda respuesta se ignora en silencio.

---

## 3. Escenarios de aceptación (Gherkin)

```gherkin
Feature: Agendamiento por WhatsApp

  Scenario: Paciente agenda en un horario disponible
    Given una clínica con el servicio "Consulta" (30 min) y el profesional "Dra. Ríos"
    And existe un slot libre mañana a las 10:00 en la TZ de la clínica
    When el paciente pide agendar "Consulta" para mañana
    And elige el slot de las 10:00 y confirma
    Then se crea una cita en estado PENDIENTE (o CONFIRMADA si autoConfirm)
    And se programan recordatorios a 24h y 3h antes
    And el paciente recibe un mensaje con fecha, hora y dirección

  Scenario: No se permite doble reserva del mismo slot
    Given una cita activa de "Dra. Ríos" mañana a las 10:00
    When otro paciente intenta agendar con "Dra. Ríos" mañana a las 10:00
    Then el sistema no ofrece ese slot como disponible
    And si se fuerza la creación, falla por constraint único

Feature: Recordatorios anti no-show

  Scenario: Paciente confirma tras el recordatorio
    Given una cita PENDIENTE para dentro de 24h
    When llega el recordatorio y el paciente responde "SÍ"
    Then la cita pasa a CONFIRMADA
    And se cancela el job de riesgo

  Scenario: Paciente no confirma y la cita entra en riesgo
    Given una cita PENDIENTE y un umbral de 6h sin confirmar
    When pasa el umbral sin respuesta del paciente
    Then la cita pasa a EN_RIESGO
    And recepción ve una alerta en el panel

  Scenario: Cancelación libera el horario
    Given una cita CONFIRMADA para mañana a las 10:00
    When el paciente responde "CANCELAR"
    Then la cita pasa a CANCELADA
    And el slot de las 10:00 vuelve a estar disponible
    And se eliminan sus recordatorios pendientes

Feature: Handoff a humano

  Scenario: El paciente pide hablar con una persona
    Given una conversación manejada por el bot
    When el paciente escribe "quiero hablar con alguien"
    Then la conversación pasa a NEEDS_HUMAN
    And el bot deja de responder hasta que se libere
```

### 3.1 Matriz de cobertura de tests vs Gherkin (audit F1.7.T2)

Auditoría realizada el 2026-08-23 contra los specs existentes en `apps/backend/src/**/*.spec.ts`.
La columna **Hueco explícito** documenta las partes del escenario que todavía no tienen cobertura
directa; si no hay hueco, el escenario queda cubierto por al menos un test representativo.

| Feature / Scenario §3 | Tests representativos existentes | Veredicto | Hueco explícito |
|---|---|---:|---|
| Agendamiento — Paciente agenda en un horario disponible | `scheduling/scheduling.service.spec.ts` → `crea la cita y programa recordatorios cuando el slot está libre`, `crea la cita CONFIRMADA cuando clinic.autoConfirm=true`; `bot/bot.service.spec.ts` → `flujo end-to-end: agendar → nombre → confirmar → cita creada + recordatorios programados`; `reminders/reminders.service.spec.ts` → `programa exactamente dos recordatorios (24h y 3h) con delay relativo a startAt y jobId determinista`, `respeta offsets configurables por clínica`, `cita a menos de 24h: solo programa el recordatorio de 3h` | 🟢 Cubierto | — |
| Agendamiento — No se permite doble reserva del mismo slot | `scheduling/scheduling.service.spec.ts` → `tira ConflictException 409 si el @@unique falla (doble reserva)`, `tira ConflictException si availability ya no ofrece ese slot`; `bot/bot.service.spec.ts` → `si scheduling tira ConflictException el bot re-lista horarios libres y vuelve a ASK_SLOT` | 🟡 Parcial | Falta spec propio de `scheduling/availability.service.ts` que pruebe que una cita activa no se ofrece como slot disponible; hoy se testea vía mock y por el fallback `@@unique`. |
| Recordatorios — Paciente confirma tras el recordatorio | `appointments/appointments.controller.spec.ts` → `PENDIENTE → CONFIRMADA: llama a reminders.confirmAppointment`; `bot/bot.service.spec.ts` → `"sí" → confirma la cita vía RemindersService y no invoca al LLM`; `reminders/reminders.service.spec.ts` → `marca la cita CONFIRMADA con confirmedAt=ahora y elimina el job check-risk`; `reminders/reminders.processor.spec.ts` → `envía el recordatorio por WAHA con fecha en la TZ/locale de la clínica y marca el Reminder SENT` | 🟢 Cubierto | — |
| Recordatorios — Paciente no confirma y la cita entra en riesgo | `reminders/reminders.processor.spec.ts` → `cita PENDIENTE al vencer el umbral → EN_RIESGO y alerta a recepción (NEEDS_HUMAN + mensaje)`, `cita ya CONFIRMADA: updateMany no matchea → no cambia estado ni alerta`, `es idempotente: ejecutar el job dos veces alerta una sola vez`; `reminders/reminders.service.spec.ts` → `programa el job check-risk en startAt - confirmThresholdH`; `appointment-status.util.spec.ts` → matriz legal `PENDIENTE → EN_RIESGO` | 🟢 Cubierto | — |
| Recordatorios — Cancelación libera el horario | `appointments/appointments.controller.spec.ts` → `PENDIENTE → CANCELADA: 200 con status CANCELADA + cancelForAppointment`; `bot/bot.service.spec.ts` → `"cancelar" → marca la cita CANCELADA con canceledAt y elimina sus recordatorios`; `reminders/reminders.service.spec.ts` → `elimina los jobs de los reminders SCHEDULED, los marca CANCELED y borra el check-risk`; `appointment-status.util.spec.ts` → matriz legal a `CANCELADA` | 🟡 Parcial | Falta spec de `AvailabilityService` que demuestre que una cita `CANCELADA` libera el slot. |
| Handoff a humano — El paciente pide hablar con una persona | `bot/bot.service.spec.ts` → `"hablar con una persona" en cualquier paso marca NEEDS_HUMAN y resetea la FSM`, `si state=HUMAN, el bot no responde`; `conversations/conversations.controller.spec.ts` → `release → set state=BOT, limpia flowStep y flowData` | 🟡 Parcial | Falta un test que demuestre explícitamente que `state=NEEDS_HUMAN` también silencia al bot hasta `release`; hoy la no-respuesta cubierta es para `state=HUMAN`. |

#### Test centinela cross-tenant

El centinela de fuga cross-tenant requerido por F1.7.T2 está en
`scheduling/scheduling.service.spec.ts` → `rechaza el intento de usar un serviceId de otra clínica`.
Ese test no sólo espera `NotFoundException`: también assertéa que la query use
`where: { id: 'svc-of-clinic-B', clinicId: 'clinic-A', active: true }`.
Si alguien remueve el filtro `clinicId` de esa query, el test falla aunque el mock siga devolviendo
`null`; por eso es un test load-bearing contra fuga entre tenants.

---

## 4. Definición de "hecho" (Definition of Done) por incremento

- Compila con TypeScript strict, sin `any` innecesarios.
- Tests unitarios de la lógica de negocio (disponibilidad, transiciones, recordatorios).
- Sin fuga de datos entre tenants (test que lo verifique).
- Endpoints validados con class-validator.
- Documentado el "por qué" de decisiones no obvias (ADR en `docs/adr/`).

---

## 5. Estándares del proyecto (actualizado 2026-09-09)
- Node 20+, TypeScript strict, NestJS 10, Prisma 5.
- Logger: siempre `PinoLogger` inyectado con `@InjectPinoLogger()` + `setContext` en el ctor
  (nunca `@InjectPinoLogger(Nombre)`; ver [[notas/2026-09-09-nestjs-pino-inject-con-contexto]]).
  Prohibido `console.*` y `Logger` de `@nestjs/common` en código nuevo.
- Todo log propaga `requestId` + `clinicId`; nunca loguear `patient`/`user` completos ni bodies de error de WAHA.
- i18n: `es` (default) y `pt` con next-intl, `localePrefix: always`; paridad de claves verificada en CI.
- Commits atómicos (~100 líneas), trunk-based.
- Toda función de fecha/hora usa Luxon con TZ de la clínica; nunca `Date` "naive".
- Secretos solo por env; nunca en el repo.
