# 2026-08-09 — Panel Backend: TenantContext + CRUDs (Etapa 1)

Primera etapa del bloque **Panel**: helpers `TenantContext` + todos los CRUDs
que el frontend Next.js va a consumir. Sin frontend. Cero atajos multi-tenant.

Relacionados: [[../adr/0005-auth-mvp-y-deuda|ADR 0005]] (precondición §7),
[[../SPEC|SPEC]] §1 (contratos) + §2 (transiciones), [[../ARCHITECTURE|Arquitectura]].

## TenantContext (base)

`apps/backend/src/auth/tenant-context.util.ts`

- `assertClinicScope(user, override?) → string` — devuelve el `clinicId` efectivo.
- `isSuperadmin(user) → boolean`.
- `tenantWhere(user, override?) → { clinicId }` — fragment estándar para queries.

Reglas duras:
- `CLINIC_ADMIN` / `PROFESSIONAL`: `clinicId` del JWT. Sin `clinicId` → **403**.
- `SUPERADMIN`: requiere `overrideClinicId` explícito (query param `?clinicId=`).
  Sin él → **400**. Es fricción intencional para forzar decisión de scope.
- `overrideClinicId` **sólo se respeta para SUPERADMIN**. Un `CLINIC_ADMIN`
  pasando `?clinicId=X` sigue viendo su propia clínica.

## Endpoints creados

Todos bajo `/api/*`. `@UseGuards(RolesGuard)` + `@Roles(...)` explícito por handler.
Todas las queries pasan por `tenantWhere(user, override?)`.

### `/api/services` — CLINIC_ADMIN, SUPERADMIN
| Método | Ruta | Rol | Notas |
|---|---|---|---|
| POST | `/` | CA/SA | Body: `{ name, durationMin, bufferMin?, priceCents?, professionalIds? }` |
| GET | `/` | CA/SA | Sólo `active=true`. Incluye `professionals[{id,name}]` |
| GET | `/:id` | CA/SA | Detalle |
| PATCH | `/:id` | CA/SA | Campos actualizables; `serviceIds` (M-N) via `set` |
| DELETE | `/:id` | CA/SA | Soft delete (`active=false`). NO hard delete |

### `/api/professionals` — CLINIC_ADMIN, SUPERADMIN
Idéntico shape. Soft-delete. M-N con services via `serviceIds` en body.

### `/api/business-hours` — CLINIC_ADMIN, SUPERADMIN
- POST `/` con `{ weekday, startMinutes, endMinutes, professionalId? }`.
- GET `/?professionalId=` (filtro opcional).
- PATCH `/:id`, DELETE `/:id` (hard delete OK — no rompe históricos).
- Valida `endMinutes > startMinutes` y `professionalId` de la misma clínica.

### `/api/time-off` — CLINIC_ADMIN, SUPERADMIN
- POST con `{ startAt, endAt, reason?, professionalId? }`. ISO 8601.
- Parseo con **Luxon + TZ de la clínica**. DB guarda UTC.
- Valida `endAt > startAt`.

### `/api/appointments` — CLINIC_ADMIN, SUPERADMIN, PROFESSIONAL (parcial)
| Método | Ruta | Rol | Notas |
|---|---|---|---|
| GET | `/` | CA/SA | Filtros: `from`, `to`, `status`, `professionalId`, `limit`, `offset`. Sin `notes` (PII) |
| GET | `/mine` | PROFESSIONAL | Agenda propia. Resuelve `User.professionalId` (patch temporal — ver ADR 0005 §8) |
| GET | `/:id` | CA/SA/PROF | Incluye reminders. Filtro extra por prof si PROF |
| PATCH | `/:id/status` | CA/SA | FSM validada + side effects reminders |
| POST | `/` | CA/SA | Delegado a `SchedulingService.createAppointment` con `source: 'PUBLIC'` |

**FSM (validated en `appointment-status.util.ts`)** — mismas transiciones del SPEC:
```
PENDIENTE  → CONFIRMADA | EN_RIESGO | CANCELADA
CONFIRMADA → ATENDIDA | CANCELADA | NO_SHOW
EN_RIESGO  → CONFIRMADA | CANCELADA | NO_SHOW | ATENDIDA
ATENDIDA / CANCELADA / NO_SHOW: terminales
```
Cualquier otra → **422** `UnprocessableEntityException('transición no permitida')`.

**Side effects (fail-open, log a error)**:
- → `CONFIRMADA`: `remindersService.confirmAppointment(id)` + `confirmedAt = now`.
- → `CANCELADA`: `remindersService.cancelForAppointment(id)` + `canceledAt = now`.
- → `NO_SHOW`: `remindersService.cancelForAppointment(id)` + `outcome = 'no_show'`.
- → `ATENDIDA`: `outcome = 'atendio'`.

`same-status` es no-op — evita explotar requests idempotentes.

**NO exponemos `DELETE`**. El panel usa `PATCH status → CANCELADA`.

**Decisión**: `POST` usa `source: 'PUBLIC'` internamente (no creamos `'PANEL'`).
`SchedulingService` sólo distingue BOT vs no-BOT para dedupe. Panel y público
comparten semántica: creación explícita, sin dedupe. Ver
`SchedulingService.createAppointment` (BOT idempotencia vs PUBLIC).

### `/api/conversations` — CLINIC_ADMIN, SUPERADMIN
| Método | Ruta | Notas |
|---|---|---|
| GET | `/` | Filtro `?state=BOT|NEEDS_HUMAN|HUMAN`. Incluye `lastMessage` + `messageCount` |
| GET | `/:id` | Últimos N mensajes (`?limit=50`, max 200) en orden cronológico ascendente |
| POST | `/:id/takeover` | `state = HUMAN` (silencia bot) |
| POST | `/:id/reply` | Body `{ text }`. Sanitizado (trim + strip control chars). Envía por WAHA. Persiste `Message OUT` sólo si el envío OK |
| POST | `/:id/release` | `state = BOT` + **limpia `flowStep` y `flowData`** (`Prisma.JsonNull`) |

**Sanitización de `text`**: `@Transform` en el DTO elimina caracteres control ASCII
(0x00-0x08, 0x0B-0x1F, 0x7F) salvo `\n` y `\t`, luego `trim()`. Si el input
queda vacío tras la sanitización, se responde 400. `class-validator` cap 1500 chars.

### `/api/dashboard/metrics` — CLINIC_ADMIN, SUPERADMIN
GET → devuelve:
```ts
{
  noShowRate: number,         // NO_SHOW / (ATENDIDA + NO_SHOW), últimos 30d
  byStatus: {                 // conteo por estado, últimos 30d
    PENDIENTE, CONFIRMADA, EN_RIESGO, ATENDIDA, CANCELADA, NO_SHOW: number
  },
  confirmations: {
    sent: number,             // Reminder SENT + CONFIRMED en 30d
    confirmed: number,        // Appointment.confirmedAt en 30d
    rate: number,             // guard división por cero
  },
  trend: Array<{              // 14d con daily buckets en TZ clínica
    date: 'YYYY-MM-DD', created, confirmed, noShow: number
  }>
}
```
Todo en TZ de la clínica (Luxon). Agrupado en JS para el trend (rango chico).

### `/api/faq` — CLINIC_ADMIN, SUPERADMIN
CRUD sobre `FaqChunk`. Schema actual sólo tiene `content` + `embedding`.
No hay `title`; adaptado al schema, documentado. El RAG (bloque futuro)
llenará `embedding` — este CRUD sólo gestiona `content`. Response NO expone
`embedding` (payload grande + no-UI).

## Reglas transversales (aplican a TODOS los controllers)

1. **`tenantWhere(user, override?)` en TODAS las queries**. Ripgrep verifica.
2. **Guards**: `@UseGuards(RolesGuard)` + `@Roles(...)` explícito por handler.
   Sin `@Roles` → cae al default de "cualquier autenticado" — evitado siempre.
3. **PII mínima en responses**:
   - `AppointmentsController.list`: NO devuelve `notes` (sólo detalle).
   - `AppointmentsController.list`: `patient` sólo `{ id, name, phone }`.
   - `FaqController`: NO devuelve `embedding`.
4. **Cero PII en logs**. Log solo `apptId`, `convoId`, `by=userId`, transitions.
   NUNCA `phone`, `name`, `notes`, `reason` del body de status change.
5. **Luxon + TZ clínica** para fechas. Cero `new Date()` naive en runtime.

## Multi-tenant defense-in-depth

Test dedicado: usuario de clínica A que intenta acceder a un recurso de B
recibe **404** (el `findFirst(where: { id, clinicId })` no lo encuentra) —
NUNCA 500 ni 200. Cubierto en cada resource spec.

## Wiring

`app.module.ts` importa: `ServicesModule`, `ProfessionalsModule`,
`BusinessHoursModule`, `TimeOffModule`, `AppointmentsModule`,
`ConversationsModule`, `DashboardModule`, `FaqModule`.

## Tests

Total: **172 verdes** (81 previos + 91 nuevos).

Distribución nuevas suites:
- `auth/tenant-context.util.spec.ts` — 13 tests (matriz completa scope × role)
- `services/services.controller.spec.ts` — 7 tests
- `professionals/professionals.controller.spec.ts` — 4 tests
- `business-hours/business-hours.controller.spec.ts` — 5 tests
- `time-off/time-off.controller.spec.ts` — 5 tests
- `appointments/appointment-status.util.spec.ts` — 22 tests (FSM completa)
- `appointments/appointments.controller.spec.ts` — 14 tests
- `conversations/conversations.controller.spec.ts` — 11 tests
- `dashboard/dashboard.controller.spec.ts` — 5 tests
- `faq/faq.controller.spec.ts` — 4 tests

Cobertura de casos críticos:
- FSM: 10 transiciones legales × permitidas + 11 ilegales × 422 + same-status no-op.
- Multi-tenant: 8 casos de leak → 404 (por cada resource CRUD).
- RBAC: SUPERADMIN sin override → 400 en cada endpoint que lo requiere.
- Side effects: `confirmAppointment` y `cancelForAppointment` invocados
  con `apptId` correcto por cada transición legal + fail-open verificado.
- Sanitización XSS: control chars removidos, `\n`/`\t` preservados, cap chars.
- Dashboard: `rate=0` con `sent=0` (guard división por cero), `noShowRate=0`
  con `closed=0`.

## Ripgreps

```
rg 'new Date\(\)' apps/backend/src -g '!*.spec.ts' → CLEAN
rg 'clinicId:' apps/backend/src/{services,professionals,...} → todo desde
  `scope.clinicId` (via `tenantWhere`), tipos declarados, o mocks de spec.
```

## Preguntas abiertas / decisiones pendientes

1. **`POST /appointments` source**: hoy usa `'PUBLIC'`. Si querés distinguir
   panel del público (para métricas de "canal de creación"), sumar `'PANEL'`
   a `AppointmentSource` en `scheduling.service.ts`. Postergado — el frontend
   no lo necesita para MVP.
2. **`FaqChunk.title`**: schema no lo tiene. Cuando el frontend necesite un
   título separado del contenido, migración menor (`title String?`). Hoy el
   `content` puede ir con markdown y primera línea como título convencional.
3. **`PROFESSIONAL` roles negativos**: RolesGuard cubre `PROFESSIONAL` intentando
   `POST /services` con 403. Testeado indirectamente por el spec del guard.
   Podrían sumarse tests explícitos por endpoint pero el guard es el mismo.
4. **`GET /appointments/mine` sin `professionalId` en JWT**: parche temporal.
   Cierre con migración cuando el rol `PROFESSIONAL` empiece a consumir la app
   mobile (ADR 0005 §8).

## Cambios en archivos existentes

- `apps/backend/src/app.module.ts`: registra los 8 módulos nuevos.
- Todo lo demás: **sólo NUEVOS archivos**. `AuthService`, `SchedulingService`,
  `RemindersService`, `WahaService`, bot no fueron tocados.
