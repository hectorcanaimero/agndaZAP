# 2026-08-08 — Bloque 2: FSM del bot + `SchedulingService`

Notas de implementación del Bloque 2 de [[proximo-incremento]].

## Extracción de `SchedulingService.createAppointment`

- Se extrajo de la FSM del bot para que Bloque 3 (endpoint público) lo reutilice.
- Reglas clave:
  - Todo se cruza por `clinicId`. `findFirst({ where: { id, clinicId, active: true } })`
    en vez de `findUnique({ where: { id } })` para cortar de raíz cualquier fuga entre tenants.
  - Re-verificación del slot con `AvailabilityService.getSlots` justo antes de crear
    (rango de 1 día). Cubre el caso "el slot dejó de ser válido entre el ASK_SLOT y
    el CONFIRM" — por ejemplo, otro paciente lo tomó, o el profesional agregó un
    `TimeOff`.
  - `@@unique([professionalId, startAt])` es la última línea de defensa. Si dos
    requests corren en carrera, uno gana y el otro recibe `P2002` → mapeado a
    `ConflictException` (409) con mensaje "slot ya tomado".
  - **Idempotencia solo para `source: 'BOT'`**: si el paciente ya tiene una cita
    futura activa del mismo servicio, se la devolvemos en vez de crear otra. Esto
    protege contra doble-tap por parte del usuario o retries del bot. El endpoint
    público es explícito, no auto-deduplica.
  - `consent` solo se prende (no pisamos un `true` previo con `false`).

## FSM de agendamiento en el bot

Pasos: `ASK_SERVICE → ASK_PROFESSIONAL → ASK_SLOT → CONFIRM`. Persistidos en
`Conversation.flowStep` (string) y `Conversation.flowData` (JSON).

### Auto-skips

- Si hay **un solo servicio activo**, `startFlow` salta directo a `ASK_PROFESSIONAL`.
- Si hay **un solo profesional** para el servicio, saltamos directo a `ASK_SLOT`.
- No molestamos al usuario con elecciones triviales.

### Parsing "número vs nombre"

En `ASK_SERVICE` y `ASK_PROFESSIONAL` intentamos primero por índice (regex `/\d+/`,
tolera "1.", "opción 2", etc.), después por match parcial en el label. Cero LLM
en pasos triviales: barato, determinista y sin sorpresas.

En `ASK_SLOT` **solo aceptamos índice** — parsear fechas en texto libre invita a
ambigüedad ("mañana" en qué TZ, "10" son 10:00 o el día 10, etc.). Ya mostramos
la lista con etiquetas legibles ("lunes 5 de agosto, 10:00"), así que pedir un
número es lo más simple y seguro.

### Confirmación explícita

Antes de crear la cita se pide `SÍ` / `no` en el paso `CONFIRM`. Cualquier otro
texto → repetimos la pregunta sin crear nada. Regla no negociable del SPEC.

### Cancelación mid-flow

Si el paciente escribe "cancelar" mientras hay `flowStep` activo, la FSM se
resetea y contestamos amable. Solo si NO hay FSM activa, "cancelar" cae al flujo
de cancelar una cita existente. Así evitamos que quedar a mitad de agenda
"secuestre" el keyword.

### Conflicto de slot al confirmar

Si `SchedulingService.createAppointment` tira `ConflictException` en el paso
`CONFIRM` (porque otro reservó el slot en el intervalo entre `ASK_SLOT` y `CONFIRM`),
el bot responde amable, resetea la FSM y le pide al usuario que escriba "agendar"
para volver a listar horarios frescos. NO reintenta silencioso — el paciente
tiene que elegir uno nuevo.

## Tests

- `scheduling.service.spec.ts` — 8 tests. Cubre los dos escenarios Gherkin del SPEC
  (agendar en horario disponible + no doble reserva) y un test **multi-tenant**
  (servicio de otra clínica → `NotFoundException`).
- `bot.service.spec.ts` — 9 tests. Cubre el flujo E2E de la FSM, mensajes ante
  conflicto, ausencia de confirmación (nunca crea sin `sí` explícito), auto-skip
  de pasos triviales, casos borde (0 servicios, 0 slots), cancelación mid-flow y
  estado `HUMAN` (bot silenciado).

## Comandos

```bash
pnpm --filter @agendazap/backend build   # nest build: strict OK
pnpm --filter @agendazap/backend test    # 17 tests passed
```

## Siguiente

Bloque 3 — endpoint público `/agendar/[clinicSlug]` que consume el mismo
`SchedulingService.createAppointment` con `source: 'PUBLIC'`.
