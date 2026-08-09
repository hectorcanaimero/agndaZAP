# Cierre code-review Bloque 2 + smoke E2E Bloque 3

- Fecha: 2026-08-08 (madrugada)
- Relacionados: [[2026-08-08-bloque-2-fsm-scheduling]], [[2026-08-08-bloque-3-pagina-publica]]

## Qué

Se cierran los fixes del code-review del Bloque 2, se agrega `prisma/seed.ts`
idempotente para poblar una clínica demo, y se corre el smoke end-to-end del
endpoint público del Bloque 3 con datos reales en DB + Redis + BullMQ.

## Fixes aplicados (Bloque 2)

### A.1 — Cero `Date` naive

Sustituidos los 6 usos productivos de `new Date()` por `DateTime.now().toJSDate()`
(regla del CLAUDE.md del proyecto):

- `apps/backend/src/scheduling/scheduling.service.ts:130` (`startAt: { gte }`).
- `apps/backend/src/scheduling/scheduling.service.ts:172` (`confirmedAt`).
- `apps/backend/src/bot/bot.service.ts:121` (`canceledAt`).
- `apps/backend/src/bot/bot.service.ts:790` (`startAt: { gte }`).
- `apps/backend/src/reminders/reminders.service.ts:106` (`confirmedAt`).
- `apps/backend/src/reminders/reminders.processor.ts:53` (`sentAt`).

Verificado con `rg 'new Date\(\)' apps/backend/src -g '!*.spec.ts'` → limpio.

### A.2 — UX de la FSM del bot

1. **`reagendar`/`reprogramar` en CONFIRM** ya no cae a `no|cancelar`. Ahora
   invoca `reofferSlotsAfterConflict(...)` y vuelve a `ASK_SLOT` con slots
   frescos, preservando `serviceId`, `professionalId` y `patientName`.
2. **Escape universal a humano**: nuevo `isHumanEscape(normalized)` que detecta
   `humano | persona | operador | asesor | representante | attendant` o la
   frase `hablar con` en CUALQUIER paso (con o sin FSM). Marca
   `Conversation.state = 'NEEDS_HUMAN'`, resetea `flowStep`/`flowData` y
   responde: *"Enseguida te atiende una persona del equipo. 🙏"*.
3. **Slot caducado en CONFIRM**: si `SchedulingService.createAppointment` tira
   `BadRequestException` cuyo mensaje incluye "pasado", el bot ya no muestra el
   texto genérico "se me complicó" — llama al nuevo helper
   `reofferSlotsAfterExpired(...)` con el mensaje específico:
   *"Ese horario ya pasó. Te muestro los que quedan libres:"*.
4. **`resolveChoice` mínimo 3 chars**: el match por nombre requería sólo
   `label.toLowerCase().includes(normalized)` — con una letra suelta ya matcheaba
   ("a" resolvía a "Ana"). Ahora, si `normalized.length < 3` y no hay número, el
   método devuelve `null`.

### A.3 — Tests nuevos (4)

Agregados a `apps/backend/src/bot/bot.service.spec.ts`:

- `en CONFIRM, "reagendar" re-lista slots sin resetear la FSM`
- `"hablar con una persona" en cualquier paso marca NEEDS_HUMAN y resetea la FSM`
- `slot caducado (BadRequest "pasado") re-ofrece horarios con mensaje específico`
- `resolveChoice ignora matches por nombre con menos de 3 chars`

Total suite: **43/43 verde** (39 previos + 4 nuevos).

## Fix extra encontrado durante el smoke (Bloque 2 leak)

`RemindersService.scheduleForAppointment` usaba `jobId: 'reminder:<id>'` y
`jobId: 'risk:<id>'`. **BullMQ 5.x prohíbe `:` en custom job IDs** — lanza
`Error: Custom Id cannot contain :`. El primer smoke real reveló:

- Solo 1 reminder quedaba en DB (el 24h) con `jobId = NULL`.
- No aparecían jobs en Redis (`bull:reminders:reminder-*` ni `risk-*`).
- El `try/catch` en `SchedulingService` logueaba el error pero no rollbackeaba
  la cita, así que quedaba un reminder huérfano en `SCHEDULED` sin jobId.

**Fix**: cambiar el separador a `-` en los tres sitios de `reminders.service.ts`
(`reminder-${reminder.id}`, `risk-${appointmentId}` en `scheduleForAppointment`,
`cancelForAppointment` y `confirmAppointment`).

## Seed idempotente (`apps/backend/prisma/seed.ts`)

Registrado en `apps/backend/package.json` bajo la clave `prisma.seed` con
`ts-node prisma/seed.ts`. `ts-node` instalado como devDep (10.9.2).

Crea (o actualiza si ya existen — reejecución segura):

- **Clínica** `demo`
- **Servicios**: `Consulta general` (30 min), `Control` (20 min, buffer 5 min).
- **Profesionales**: `Dra. Ana Ríos`, `Dr. Luis Pérez`. Ambos atienden ambos
  servicios (M2M `ProfessionalServices`).
- **BusinessHour** por profesional: lunes a viernes (weekday 1..5),
  09:00–18:00 (540..1080).

Estrategia de idempotencia:

- `Clinic`: `upsert` por `slug`.
- `Service` y `Professional`: `findFirst` por `(clinicId, name)` + `create` si
  no existe (Prisma no permite unique compuesto declarativo sobre `name` sin
  cambiar el schema).
- `BusinessHour`: mismo patrón por `(clinicId, professionalId, weekday)`.

### IDs seed (para reproducir el smoke)

Estos IDs se generan al primer `pnpm prisma db seed`. Reejecutar no los cambia:

```
clinic:        cmsl5twqi0000nnu7c6p9yr7p (slug=demo, tz=America/Caracas)
services:
  - cmsl5tws70002nnu7nbbg742d  Consulta general
  - cmsl5twsi0004nnu7f9hdck6z  Control
professionals:
  - cmsl5twsm0006nnu78owyfa3x  Dra. Ana Ríos
  - cmsl5twt20008nnu7wogtaj5v  Dr. Luis Pérez
```

## Smoke E2E ejecutado (backend + db + redis + BullMQ)

Con `docker compose up db redis waha`, seed cargado, backend arriba en
`localhost:4000`. Reproducible con los IDs del seed. Marcadores `SID/PID/SLOT`
abajo referencian los IDs listados arriba.

### C.1 GETs

- `GET /api/public/clinics/demo` → 200 con `id, name, slug, address, timezone,
  locale, services[2], professionals[2]`. Cada profesional trae
  `serviceIds[2]` (ambos servicios).
- `GET /api/public/clinics/demo/availability?serviceId=$SID&professionalId=$PID&from=2026-08-10&days=3&limit=6`
  → 200, primer slot `2026-08-10T13:00:00.000Z` = 09:00 local (Caracas UTC-4).
  Todos dentro de business hours mon-fri 9-18.

### C.2 POST feliz

```bash
curl -X POST /api/public/clinics/demo/appointments \
  -d '{ "phone": "+584141234567", "name": "Juan Test", "notes": "dolor de cabeza",
        "consent": true, "serviceId": SID, "professionalId": PID,
        "startAtISO": "2026-08-10T13:00:00.000Z" }'
```

→ **HTTP 201** con `{ id, startAt, endAt, status: "PENDIENTE", patient: { name, phone } }`.

### C.3 Side-effects

- **DB `Appointment`**: 1 fila, `status = PENDIENTE`, `startAt = 2026-08-10 13:00`.
- **DB `Reminder`**: **2 filas**, `status = SCHEDULED`.
  - `offsetH=24` @ `fireAt=2026-08-09 13:00`
  - `offsetH=3` @ `fireAt=2026-08-10 10:00`
- **Redis (BullMQ)**: keys `bull:reminders:reminder-<id1>`, `bull:reminders:reminder-<id2>`,
  `bull:reminders:risk-<apptId>` + los de infra (`meta`, `events`, `id`, `delayed`,
  `stalled-check`).

### C.4 Doble reserva del mismo slot

Repetir el POST con el mismo `startAtISO` (patient distinto):
→ **HTTP 409** con `{"message":"El horario elegido ya no está disponible. Elegí otro.","error":"Conflict","statusCode":409}`.

El texto orientado al paciente lo mapea `PublicController` en su `catch`: si
`SchedulingService` tira `ConflictException`, el controller re-tira una
`ConflictException` nueva con el mensaje user-facing (no toca el interno del
service, así el bot sigue viendo el mensaje técnico).

### C.5 Rate limit

6 POSTs consecutivos desde el mismo shell (mismo IP + slug):
→ Las primeras 5 pasan; la **6ta** responde **HTTP 429** con header
`Retry-After: 60` y body `{"statusCode":429,"message":"demasiadas
solicitudes","retryAfter":60}`. Log del guard: `rate-limit HIT slug=demo ip=::1
count=6 limit=5`.

### C.6 Honeypot

POST con `honeypot: "soy-bot"`:
→ HTTP 201 (el controller tiene `@HttpCode(201)`) con `{"ok":true}`.
No se crea `Appointment` (contamos antes/después → mismo total).

## Restricciones respetadas

- Schema Prisma sin cambios.
- `SchedulingService.createAppointment` y `AvailabilityService` sin tocar.
- Solo se agregó `ts-node` como devDep (la task lo autorizó explícitamente).

## Comandos útiles

```bash
# Seed idempotente
cd apps/backend && pnpm prisma db seed

# Arranque backend (usa DATABASE_URL del .env raíz vía symlink)
DATABASE_URL=... PORT=4000 pnpm start

# Reset limpio de la clínica demo
docker compose exec db psql -U agendazap -d agendazap \
  -c 'DELETE FROM "Reminder"; DELETE FROM "Appointment"; DELETE FROM "Patient";'
docker compose exec redis redis-cli FLUSHDB
```
