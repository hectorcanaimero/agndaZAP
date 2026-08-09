# SPEC técnico — AgendaZap (MVP)

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

### Bot
- Confirmaciones (`sí`, `cancelar`, etc.) se resuelven por regla determinista antes de invocar el LLM.
- El bot nunca crea ni cancela una cita sin confirmación explícita del paciente.
- Si `Conversation.state = HUMAN`, el bot no responde.

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
