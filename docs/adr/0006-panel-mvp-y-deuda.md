# ADR 0006 — Panel MVP: fixes post-audit y deuda documentada

- Fecha: 2026-08-09
- Estado: aceptado (piloto)
- Relacionados: [[0004-pii-y-compliance]], [[0005-auth-mvp-y-deuda]], [[../notas/2026-08-09-panel-backend-cruds]]

## Contexto

El **Bloque Panel** entregó 8 CRUDs backend (`services`, `professionals`,
`business-hours`, `time-off`, `appointments`, `conversations`, `dashboard`,
`faq`) más el panel frontend Next.js (agenda, dashboard, bandeja de conversaciones,
FAQ, servicios, profesionales, horarios, bloqueos). Dos audits paralelos
(code-reviewer + security-auditor) marcaron **2 blockers reales + 2 altos + varios
should-fix**. Este ADR consolida las decisiones tomadas y la deuda restante.

Reglas duras que se validan en cada CI:

- Multi-tenant estricto: TODAS las queries pasan por `tenantWhere(user, override?)`.
  Ripgrep de `clinicId:` en los módulos del panel debe mostrar sólo derivaciones
  de `scope.clinicId`, tipos, o mocks.
- Cero PII en logs (verificable por review de PR).
- Backend usa Luxon con la TZ de la clínica. `new Date()` sólo permitido en
  helpers UTC-anchored explícitos (documentados). Frontend NO agrega Luxon
  (bundle chico) — usa helpers UTC-anchored en `AgendaClient`.
- TypeScript strict, sin nuevas librerías.

## Decisiones (ya implementadas)

### 1. `tenantWhere` obligatorio en TODAS las queries del panel

- `DashboardController.metrics`: reemplazado `clinicId: scope.clinicId` por
  spread `...scope` en cada `findMany`/`count`. Reminders navega por
  `appointment: { ...scope }`. Cero uso de `clinicId:` suelto.
- `ServicesController` y `ProfessionalsController`: ya venían con
  `tenantWhere` en list/findOne/update/remove — se agregó pre-validación M-N
  (ver §3).

### 2. `assertClinicScope` rechaza override divergente en non-SUPERADMIN

- Antes: un `CLINIC_ADMIN` pasando `?clinicId=<clinica-ajena>` era **ignorado
  silenciosamente** y la query se ejecutaba con su propio `clinicId`. Compatible
  con multi-tenant pero encubría el bug del caller (o el intento hostil).
- Ahora: `assertClinicScope` tira `ForbiddenException("no podés operar sobre
  otra clínica")` si `overrideClinicId !== user.clinicId` para non-SUPERADMIN.
  Override igual al propio sigue funcionando (para no romper callers).
- `SUPERADMIN` con override sigue igual (respeta el override).
- Tests cubren la matriz completa en `tenant-context.util.spec.ts`.

### 3. M-N connect/set con pre-validación de tenant (Services + Professionals)

- Antes: `connect: professionalIds.map(id => ({ id }))` en `ServicesController`
  y análog en `ProfessionalsController` linkeaba IDs **sin verificar** que
  perteneciesen a la clínica del scope. Prisma no ofrece `where` en `connect`.
  Resultado: si `admin@demo` pasaba un `professionalId` de otra clínica, la
  relación se creaba y el M-N quedaba cross-tenant.
- Ahora: `assertProfessionalsInScope(ids, clinicId)` (analog para services)
  hace un `findMany` filtrado por `clinicId` y compara `found.length === ids.length`.
  Si difieren → `BadRequestException("algún professionalId no pertenece a esta clínica")`.
- Aplicado en `create` y `update` de ambos controllers.
- Tests: 4 nuevos (2 create + 2 update).

### 4. Consent SIEMPRE obligatorio (sin bypass de rol)

- Antes: `POST /appointments` tenía la excepción `if (!dto.consent && !isSuperadmin(user))`.
  Un `SUPERADMIN` podía crear cita sin consent. Legalmente incorrecto: el rol
  interno NO otorga consent en nombre del paciente (LGPD/GDPR datos de salud).
- Ahora:
  - DTO `CreatePanelAppointmentDto`: `@IsBoolean()` + `@Equals(true)` sobre
    `consent!: boolean`. El `ValidationPipe` global corta con 400 si viene
    `false` o falta.
  - Controller: check defensivo `if (!dto.consent) throw new BadRequestException(...)`.
    Cubre el caso hipotético de que se saltee el pipe.
- Tests: 2 nuevos (SUPERADMIN con `consent=false` → 400; CLINIC_ADMIN con
  `consent=true` → 201). Confirma que ningún rol tiene bypass.

### 5. `PatchStatusDto.reason` removido (defer a AuditEvent)

- El campo `reason` estaba opcional en el DTO pero SÓLO se loggeaba (no se
  persistía en la fila). Además el logueo estaba explícitamente prohibido por
  el patrón "cero PII en logs" (un operador podía escribir síntomas del
  paciente en el `reason`).
- Decidido remover del DTO. Se re-integra cuando exista la tabla `AuditEvent`
  (deuda §3 abajo). El operador que necesita anotar un motivo lo hace vía
  campo `notes` de la cita (que ya se persiste y no se loguea).

### 6. Sanitización de control chars

- Nuevo helper `apps/backend/src/common/sanitize-text.ts` con `stripControlChars`
  que elimina:
  - Control chars ASCII (0x00-0x1F + DEL 0x7F): rompe intentos de smuggling
    de caracteres invisibles en nombres cortos.
  - Zero-width chars + RTL overrides + BOM: previene spoofing con caracteres
    unicode invisibles.
- Aplicado vía `@Transform` de `class-transformer` en:
  - `CreatePanelAppointmentDto.name`
  - `CreateTimeOffDto.reason`
- No aplicado en textos multi-línea (`notes`) porque `\n`/`\t` son legítimos.
  Un helper análog con whitelist de `\n`/`\t` se puede introducir si se
  descubre abuso.

### 7. Validación de `?professionalId=` filter en `GET /appointments`

- Antes: filtro `professionalId` sin verificar tenant → devolvía lista vacía
  en lugar de señalizar el error, encubriendo el bug del caller (o el intento
  cross-tenant).
- Ahora: pre-check con `findFirst({ where: { id, ...scope } })`. Si no matchea
  → `BadRequestException`.

### 8. Frontend: robustez del panel

- `fetcher()` client-side: si `res.status === 401` → limpia cookie y redirige
  a `/{locale}/login?next=...`. El SSR NO redirige (deja que Nest maneje).
- `AgendaClient.tsx`: helper `shiftDayISO(iso, delta)` UTC-anchored reemplaza
  los `new Date(\`${date}T12:00:00Z\`)`. NO agregamos Luxon a `apps/web`. El
  punto de la regla es evitar `Date` naive de la máquina; `Date.UTC(...)` es
  determinístico y correcto.
- `Modal`: guarda `document.activeElement` al abrir, foca el primer interactive
  (o el container con `tabIndex=-1`), restaura al cerrar.
- `Toast`: errors → `role="alert"` + `aria-live="assertive"`; success/info →
  `role="status"` + `aria-live="polite"`. El container ya no lleva `aria-live`
  (redundante y disparaba lecturas de éxito con la intensidad de un error).
- `middleware.ts`: `PANEL_REGEX`/`LOGIN_REGEX`/`LOCALE_PREFIX_REGEX` derivadas
  de `routing.locales.join('|')`. Agregar `en` al futuro NO requiere tocar el
  middleware.
- `AgendaClient.changeStatus`: si `res.status === 422` (race con otro
  operador) → toast info + `router.refresh()` + cerrar modal. Otros errores
  (500/network) → toast error + modal queda abierto.

## Deuda del bloque Panel (para post-piloto o bloques siguientes)

Numerada para poder referenciar en PRs y en la bitácora.

1. **Idempotencia `POST /appointments`** — hoy `SchedulingService` sólo hace
   dedupe cuando `source === 'BOT'` (por `clinicId + patientId + serviceId`
   dentro de una ventana). El panel entra como `source: 'PUBLIC'` sin dedupe.
   Opciones: (a) `Idempotency-Key` header con Redis SET NX (5 min TTL);
   (b) extender el dedupe a `PANEL` con misma clave. **Post-piloto** — el
   operador humano en el mostrador tiene retroalimentación visual, la
   probabilidad de doble-submit es baja.

2. **Race en `POST /conversations/:id/takeover`** — dos operadores pueden
   tomar la misma conversación simultáneamente. Requiere agregar
   `Conversation.takenById?: string` + `Conversation.takenAt?: DateTime` al
   schema Prisma y usar `updateMany({ where: { id, takenById: null }, ... })`
   para atomizar. **Post-piloto con migración** — con 1 clínica y 1-2
   operadores capacitados, el riesgo es contenible.

3. **`AuditEvent` model** — persistir cambios de estado, replies, takeovers,
   creaciones de citas, etc. Requiere schema change:
   ```
   model AuditEvent {
     id           String @id @default(cuid())
     clinicId     String
     userId       String?
     entity       String     // "appointment" | "conversation" | ...
     entityId     String
     event        String     // "status_change" | "reply" | "takeover" | ...
     metadata     Json?      // { from, to, reason, ... } — con cuidado de PII
     createdAt    DateTime @default(now())
   }
   ```
   **Semana 1 del piloto** — habilita el debugging y la trazabilidad legal.

4. **`Appointment.cancelReason` (o `AuditEvent.metadata.reason`)** — el
   `reason` del `PATCH status` se quitó del DTO. Cuando exista `AuditEvent`,
   el operador podrá anotar el motivo con trazabilidad (userId, ts). Hasta
   entonces, `Appointment.notes` cumple el rol.

5. **`professionalId` al JWT payload** — hoy `GET /appointments/mine` y
   `findOne` con rol `PROFESSIONAL` requieren `User.findUnique` extra para
   resolver `professionalId`. Agregar el claim al JWT ahorra ese round-trip.
   Requiere bump de firma (invalidación de tokens existentes) — coordinar con
   el bloque Auth (ADR 0005 §8).

6. **`pt.json` panel strings** — la mayoría de los strings del panel están en
   español dentro del archivo `pt.json`. Bloquear go-live pt hasta que un
   traductor humano revise. **Bloqueante para pt piloto** — habilitado el
   piloto es-VE, no bloqueante.

7. **JWT httpOnly + refresh tokens + revocación** — heredado del bloque Auth
   (ADR 0005 §8). El fetcher client-side lee la cookie porque hoy no es
   httpOnly; con httpOnly + refresh, el flujo cambia. **Post-piloto**.

8. **Rate-limit en CRUDs autenticados** — hoy sólo `/auth/login` y los
   endpoints `/public/*` tienen rate-limit. Un CLINIC_ADMIN comprometido
   podría burst-writes contra `POST /appointments`. Considerar 30/min en
   POST/PATCH del panel usando el mismo helper `RateLimit`. **Post-piloto**.

9. **WebSocket para conversaciones** — reemplazar el polling 15s del panel de
   bandeja cuando el volumen lo exija (>10 clínicas activas concurrentes).
   NestJS soporta WS nativamente. **Post-piloto por carga**.

10. **Alerting externo sobre sesiones WAHA en FAILED** — hoy el
    `WahaHealthMonitor` ([[0008-panel-conexion-waha-y-observabilidad]])
    loguea `warn` cuando una sesión pasa a FAILED. No hay canal de
    notificación externo (Slack, email, PagerDuty). Post-piloto o cuando la
    primera clínica reporte un no-show por sesión caída no detectada, agregar:
    (a) integración con un webhook Slack por clínica en
    `Clinic.alertsWebhookUrl?` (nullable), (b) throttle: máximo 1 alerta
    cada 30 min por clínica para no spamear si WAHA fluctúa. Hasta entonces,
    monitoreo manual del log del backend con
    `docker compose logs backend | rg waha.health.failed`.

## Consecuencias

- El piloto puede correr con la deuda documentada siempre que sea con
  clínicas conocidas, operadores capacitados y monitoreo activo del backend
  (logs + rate-limit alerts). Cero PII en logs sigue siendo blocker para
  cualquier deploy.
- Para escalar a >5 clínicas o para operar sin control humano sobre los
  operadores (ej. onboarding self-service), ejecutar el roadmap 1-6 antes
  del rollout ampliado. 7-9 pueden diferirse hasta signals de carga o de
  seguridad.
- El ripgrep `clinicId:` en los módulos del panel se convierte en gate del
  CI: cualquier PR que introduzca una query cruda con `clinicId:` fuera de
  `tenantWhere` debe fallar. Sugerido en `.github/workflows/lint.yml`.

## Verificación (post-fix)

- `pnpm test` en backend: **≥180 tests verdes** (172 previos + fixes).
- `pnpm build` en backend + web: limpio.
- `rg 'clinicId:' apps/backend/src/{dashboard,services,professionals,appointments,conversations,time-off,business-hours,faq}` →
  todas las apariciones son `scope.clinicId` (via `tenantWhere`), tipos, o
  `select` (para exponer el campo en responses de FAQ, por ejemplo).
- `rg 'new Date\(\)' apps/backend/src -g '!*.spec.ts'` → limpio.
- `rg 'new Date\(\)' apps/web/src` → sólo apariciones documentadas
  (helpers UTC-anchored explícitos).
- Smokes: (a) M-N cross-tenant → 400; (b) override divergente → 403;
  (c) consent=false con SUPERADMIN → 400; (d) PENDIENTE → CANCELADA → 200
  con `cancelForAppointment` invocado.
