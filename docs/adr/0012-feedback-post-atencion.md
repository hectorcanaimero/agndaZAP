# ADR 0012 — Feedback post-atención (satisfacción) por WhatsApp

- Fecha: 2026-08-10
- Estado: aceptado
- Relacionados: [[0002-waha-no-oficial]], [[0007-rate-limit-bot]], [[0011-perfil-profesional-e-ical-feed]]

## Contexto

Las clínicas piloto quieren medir satisfacción del paciente sin salir del canal
que ya usan (WhatsApp), y usar esa señal para decisiones concretas:

1. Detectar profesionales con caída de satisfacción antes que se pierda el
   paciente.
2. Tener un promedio "movible" que muestre progreso del negocio (algo que hoy
   no existe — solo métricas anti no-show).
3. Bajar la fricción vs. formularios web (SMS/link con tap-through histórico
   < 15%).

WhatsApp ya está integrado (WAHA + FSM del bot). Reutilizamos el rail.

## Decisión

### 1) Escala 1-5, NO NPS 0-10

Elegimos escala 1-5 (CSAT-like) sobre NPS 0-10. Razones:

- **UX en chat**: 5 opciones caben en un mensaje corto ("del 1 al 5"). NPS
  0-10 requiere explicar promotores/detractores o el paciente tira números
  random.
- **Voseo / lenguaje directo**: "¿cómo fue tu experiencia? 1 muy mala, 5
  excelente" traduce mejor que la retórica NPS de "recomendarías".
- **Volumen bajo por tenant**: no necesitamos la resolución estadística de
  NPS para muestras chicas — el average simple sobre 1-5 es más legible.

En código el modelo se llama `Feedback` (neutro), en UI se muestra como
"satisfacción" / "experiencia". No exponemos "NPS" al usuario porque
técnicamente no lo es.

### 2) Config a nivel profesional, no clínica

`Professional.followUpEnabled` (bool, default `false`) +
`Professional.followUpDelayHours` (int, default `2`).

- **`false` por default** — evita spam accidental cuando se prende el módulo.
  El operador decide profesional por profesional.
- **Delay = 2h** — sweet spot: la experiencia está fresca, el paciente ya
  salió del consultorio pero no pasó tanto que se olvidó. Rango legal 0-168h
  (0 útil para testing en dev, 7 días es el máximo razonable). Valores por
  fuera de ese rango se rechazan en el DTO.

### 3) Trigger + processor separado

Cuando `Appointment.status → ATENDIDA`, `AppointmentsController` llama a
`FollowUpsService.scheduleForAppointment(id)` con **fail-open** (side effect
independiente del PATCH). Encola un job BullMQ con jobId idempotente
(`follow-up-${apptId}`) y delay derivado del profesional.

El worker de follow-ups es una Queue separada del de reminders — mismo Redis,
distintas colas — para que un failure en uno no arrastre al otro y las
métricas de BullMQ Board queden legibles.

### 4) Sub-FSM AWAITING_NPS_SCORE / AWAITING_NPS_COMMENT

Cuando el processor envía el prompt, marca la `Conversation` en
`flowStep=AWAITING_NPS_SCORE` con `flowData.feedbackAppointmentId`. Esto
"pisa" cualquier FSM de agendamiento activa — decisión consciente: preferimos
capturar la respuesta de satisfacción (raro) antes que un flujo de agendar
(el paciente puede reagendar después con "hola" o "agendar").

El BotService parsea 1-5 dígito o palabra ("cinco"). Fuera de rango, pide
corregir. Recibido el score, guarda el `Feedback` y avanza a
`AWAITING_NPS_COMMENT` — opcional. "no"/"nada"/"listo" cierra sin comment.

### 5) Idempotencia dura: unique en Feedback.appointmentId

Un paciente = un feedback por cita. La 2da respuesta (paciente
sobre-escribiendo) se **ignora silenciosamente** — el bot le agradece igual,
para no confundirlo. Si quiere corregir, hoy la salida es cancelar y volver
a marcar ATENDIDA (edge case, no vale la pena una UI de "editar mi feedback"
en MVP).

## Consecuencias

**Positivo:**
- Cero costo adicional de infra (WAHA + Redis ya están).
- Reutilizamos el rail de FSM + BullMQ existente.
- Reportes agregados listos (`GET /feedback/summary`) para el panel.
- El operador puede A/B testear delays por profesional sin código.

**Negativo / deuda:**
- **NPS "de verdad" no está** — si el mercado premium pide NPS 0-10 real
  con promotores/detractores, hay que sumar otro tipo o escalar el modelo.
- **Sin recordatorio de follow-up** — si el paciente no responde, no
  reenviamos. Es intencional para no ser molestos, pero cae el response
  rate. Métrica a monitorear.
- **PII en `comment`**: el paciente puede escribir cualquier cosa
  ("me trató mal el Dr. X"). Excluido de logs (ver [[0004-pii-y-compliance]]),
  visible solo en panel autenticado.
- **No exponemos "editar feedback"** — la 2da respuesta se ignora. Puede
  frustrar al paciente si se equivocó. Aceptable en MVP.

## Alternativas descartadas

- **NPS 0-10 puro**: descartado por UX chat + volumen bajo (ver arriba).
- **Link a form externo**: fricción alta, tap-through pobre, y saca al
  paciente del canal donde ya está.
- **Config a nivel clínica** (todo prendido/apagado): pierde granularidad —
  quizás un profesional está en período de prueba y no quiere feedback aún.
- **Cron nocturno que barre citas ATENDIDA sin feedback**: descartado. El
  delay por-cita en BullMQ es más limpio y permite retry semántico.
