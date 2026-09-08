# SPEC técnico — Showly (MVP)

Complementa el [PRD](./PRD.md) y la [Arquitectura](./ARCHITECTURE.md). Aquí van los contratos,
las reglas de negocio precisas y los escenarios de aceptación (Gherkin) que definen "hecho".

---

## 1. Contratos de API (backend NestJS)

Todas las rutas de negocio requieren JWT con `clinicId` y `role`. Prefijo `/api`.

### Auth
- `POST /api/auth/login` → `{ email, password }` → `{ accessToken }`
- `GET /api/auth/me` → usuario actual + clínica.

### Clínicas (SUPERADMIN)
- `POST /api/clinics` → crea clínica + sesión WAHA.
- `GET /api/clinics/:id/waha/status` → estado de la sesión (para QR).
- `POST /api/clinics/:id/waha/start` → inicia sesión WAHA.

### Catálogo (CLINIC_ADMIN)
- `CRUD /api/services`, `/api/professionals`, `/api/business-hours`, `/api/time-off`.

### Agenda
- `GET /api/availability?serviceId&professionalId&from&days` → `Slot[]`.
- `POST /api/appointments` → crea cita (valida slot libre) → programa recordatorios.
- `PATCH /api/appointments/:id/status` → transición controlada.
- `GET /api/appointments?from&to&status` → agenda.

### Conversaciones
- `GET /api/conversations?state` → bandeja.
- `POST /api/conversations/:id/takeover` → estado HUMAN (silencia bot).
- `POST /api/conversations/:id/reply` → mensaje manual.
- `POST /api/conversations/:id/release` → devuelve al bot.

### Webhook
- `POST /webhooks/waha` → eventos de WAHA (público, validado por token).

### Dashboard
- `GET /api/dashboard/metrics` → no-show rate, citas por estado, confirmaciones, tendencia.

---

## 2. Reglas de negocio precisas

### Disponibilidad
- Un slot es válido si: cae dentro de `BusinessHour` del profesional (o de la clínica si el
  profesional no define horario), no interseca ninguna cita activa del profesional, no interseca
  ningún `TimeOff`, y su inicio es futuro respecto al `now` en la TZ de la clínica.
- El paso entre slots es `durationMin + bufferMin` del servicio.
- Toda hora se calcula en la TZ de la clínica.

### Creación de cita
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
- Confirmar cancela el job `check-risk`. Cancelar/reprogramar elimina todos los jobs de la cita.
- Idempotencia por `jobId` determinista (`reminder:{id}`, `risk:{apptId}`).
  En BullMQ, el `jobId` físico usa `reminder-{id}` y `risk-{apptId}` porque `:` es separador reservado de claves Redis; la relación lógica 1:1 se mantiene.

### Bot
- Confirmaciones (`sí`, `cancelar`, etc.) se resuelven por regla determinista antes de invocar el LLM.
- Las respuestas de recordatorio `SÍ`, `REAGENDAR` y `CANCELAR` no dependen del LLM: confirman, derivan a recepción para reagendar sin mover la cita todavía, o cancelan explícitamente la cita.
- El bot nunca crea ni cancela una cita sin confirmación explícita del paciente.
- Si `Conversation.state = HUMAN`, el bot no responde.
- La FSM de agendamiento se persiste en `Conversation.flowStep` + `flowData` y avanza por `ASK_SERVICE → ASK_PROFESSIONAL → ASK_SLOT → CONFIRM`; pasos auxiliares como captura de nombre deben preservar esos datos para que el flujo sea retomable.

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
| Agendamiento — Paciente agenda en un horario disponible | `scheduling/scheduling.service.spec.ts` → `crea la cita y programa recordatorios cuando el slot está libre`, `crea la cita CONFIRMADA cuando clinic.autoConfirm=true`; `bot/bot.service.spec.ts` → `flujo end-to-end: agendar → nombre → confirmar → cita creada + recordatorios programados` | 🟡 Parcial | Falta test directo de `reminders/reminders.service.ts` que pruebe offsets reales `24h` y `3h`; los tests actuales sólo verifican que `SchedulingService` invoca `scheduleForAppointment`. |
| Agendamiento — No se permite doble reserva del mismo slot | `scheduling/scheduling.service.spec.ts` → `tira ConflictException 409 si el @@unique falla (doble reserva)`, `tira ConflictException si availability ya no ofrece ese slot`; `bot/bot.service.spec.ts` → `si scheduling tira ConflictException el bot re-lista horarios libres y vuelve a ASK_SLOT` | 🟡 Parcial | Falta spec propio de `scheduling/availability.service.ts` que pruebe que una cita activa no se ofrece como slot disponible; hoy se testea vía mock y por el fallback `@@unique`. |
| Recordatorios — Paciente confirma tras el recordatorio | `appointments/appointments.controller.spec.ts` → `PENDIENTE → CONFIRMADA: llama a reminders.confirmAppointment`; `appointment-status.util.spec.ts` → matriz legal `PENDIENTE → CONFIRMADA` | 🟡 Parcial | Falta test de `BotService` para respuesta determinista `SÍ` fuera de la FSM y test directo de `RemindersService.confirmAppointment` que pruebe que se elimina el job `check-risk`. |
| Recordatorios — Paciente no confirma y la cita entra en riesgo | `appointment-status.util.spec.ts` → matriz legal `PENDIENTE → EN_RIESGO`; `dashboard/dashboard.controller.spec.ts` cubre agregación visual de citas `EN_RIESGO` | 🔴 Gap | Falta test de `reminders/reminders.processor.ts` para job `check-risk`: `updateMany` sólo si sigue `PENDIENTE`, transición a `EN_RIESGO` y alerta a recepción con conversación en `NEEDS_HUMAN`. |
| Recordatorios — Cancelación libera el horario | `appointments/appointments.controller.spec.ts` → `PENDIENTE → CANCELADA: 200 con status CANCELADA + cancelForAppointment`, `CONFIRMADA → CANCELADA: llama a reminders.cancelForAppointment`; `appointment-status.util.spec.ts` → matriz legal a `CANCELADA` | 🟡 Parcial | Falta test de `BotService` para respuesta determinista `CANCELAR` de recordatorio; falta test directo de `RemindersService.cancelForAppointment`; falta spec de `AvailabilityService` que demuestre que una cita `CANCELADA` libera el slot. |
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

## 5. Estándares del proyecto
- Node 20+, TypeScript strict, NestJS 10, Prisma 5.
- Commits atómicos (~100 líneas), trunk-based.
- Toda función de fecha/hora usa Luxon con TZ de la clínica; nunca `Date` "naive".
- Secretos solo por env; nunca en el repo.
