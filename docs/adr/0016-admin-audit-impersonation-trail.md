# ADR 0016 — Trail estructurado de mutations bajo impersonation

## Estado

Aceptada — 2026-08-18

## Contexto

El review de seguridad pre-lanzamiento identificó un hallazgo Alto:

> Cuando un SUPERADMIN impersona una clínica (JWT con claim `impersonatedBy`), sus mutations sobre datos de pacientes (`PATCH /api/patients/*`, `POST /api/conversations/*/reply`, etc.) quedan solo en logs de stdout — NO en la tabla `AdminAudit`. Después del `START_IMPERSONATION` inicial hay una ventana de 30 min ciega en el trail persistente. Con 40 clínicas piloto y datos de salud bajo LGPD, es un gap de compliance bloqueante.

Estado previo relevante:

- `AdminAudit` cubre solo acciones del área `/admin/*` (crear/suspender clínica, iniciar impersonation). El `AdminAuditInterceptor` estaba montado por-controller con `@UseInterceptors`.
- Los controllers del panel (`patients`, `appointments`, `conversations`, `services`, `professionals`, `business-hours`, `time-off`, `clinics`, `faq`, `feedback`) NO usan el interceptor. Loguean `by=${user.userId}` en stdout pero sin marca de impersonation.
- El enum `AdminAction` cubría acciones a nivel de clínica, no mutations dentro de un tenant.

## Decisión

### 1. Enum extendido: un solo valor genérico

```prisma
enum AdminAction {
  CREATE_CLINIC
  UPDATE_CLINIC
  SUSPEND_CLINIC
  REACTIVATE_CLINIC
  ARCHIVE_CLINIC
  START_IMPERSONATION
  IMPERSONATED_WRITE   // ← NUEVO
}
```

`IMPERSONATED_WRITE` cubre toda mutation POST/PATCH/DELETE ejecutada bajo impersonation. El detalle (método, path, tenant target, targetType inferido) va a `metadata` como JSON. Rechazado hacer valores granulares (`PATIENT_UPDATE`, `APPOINTMENT_STATUS_CHANGE`, etc.) — 10+ enum values requerirían múltiples migrations y no aportan sobre el patrón `WHERE metadata->>'targetType' = 'Patient'`.

### 2. Campo `impersonatedBy` en `AdminAudit`

```prisma
model AdminAudit {
  // ... existentes ...
  impersonatedBy String?
  @@index([impersonatedBy, createdAt])
}
```

Nullable — las mutations normales (fase legacy, admin controllers puros) siguen con `NULL`. Solo se popula cuando la acción vino con JWT impersonado.

**El actor real (`actorUserId`) sigue siendo el mismo `userId` del JWT** — que en impersonation es el SUPERADMIN. `impersonatedBy` es redundante cuando el super se impersona a sí mismo (siempre) pero el campo separado permite:

- Filtros de compliance: "todas las acciones del super X impersonando la clínica Y"
- Diferenciar visualmente en el panel de audit: "acción normal del super" vs "acción bajo impersonation"
- Preparado para el futuro donde `impersonatedBy` podría ser distinto del `actorUserId` (multi-nivel impersonation, delegación)

### 3. Interceptor GLOBAL con lógica dual

`AdminAuditInterceptor` se registra como `APP_INTERCEPTOR` global (antes era per-controller). Lógica interna:

```
if (!HTTP) skip
if (GET/HEAD/OPTIONS) skip
if (!user) skip                             ← endpoints públicos no auditables

if (user.impersonatedBy) {
  → audit SIEMPRE con IMPERSONATED_WRITE
  → targetType inferido del path
  → targetId de req.params.id (o '?' si no aplica)
  → metadata: { method, path, clinicId }
}
else if (@AdminAudit decorator presente) {
  → audit con action del decorador (backward compat)
}
else skip                                   ← mutations normales de CLINIC_ADMIN
```

**Ventaja crítica:** cero cambios en controllers del panel. Cualquier endpoint nuevo bajo `/api/*` que reciba un request con JWT impersonado queda cubierto automáticamente por el interceptor — sin decorador ni ajuste.

### 4. `await` bloqueante con fallback a stderr

Cambiamos el `.catch()` fire-and-forget por `await`:

```ts
try {
  await this.adminAuditService.logAction(...);
} catch (err) {
  this.logger.error(`AUDIT_FAILED ... err=${err.message}`);
  // NO throw — la mutation original ya se ejecutó
}
```

**Trade-off aceptado:** si `AdminAudit.create()` falla (DB blip), la mutation ya se ejecutó → el cliente recibe 200 mientras el audit se pierde. Alternativa "throw" dejaría al cliente en estado ambiguo (¿se guardó?) — peor. Como fallback, el error queda en:
- `logger.error()` → Axiom (correlacionable por `requestId`)
- Sentry (via `SentryFilter` global — level=error se captura por default)

Es "no-repudio comprometido pero visible en 2 sistemas". Para el piloto es suficiente. Post-piloto se puede evaluar dual-write a un topic Kafka/queue.

### 5. Fix del `extractIp` inconsistente (Nit del review)

El interceptor reimplementaba `extractIp` sin validar `TRUST_PROXY` (lee `X-Forwarded-For` siempre). Ahora usa el helper compartido `common/extract-ip.ts` — mismo comportamiento que `RateLimitGuard` y `AuthController`. En prod (`TRUST_PROXY=true`) lee XFF con regex validation. En dev sin proxy, lee `req.ip`.

## Contratos

### Payload de `IMPERSONATED_WRITE`

```json
{
  "actorUserId": "super-1",
  "impersonatedBy": "super-1",
  "action": "IMPERSONATED_WRITE",
  "targetType": "Patient",           ← inferido de req.route.path
  "targetId": "patient-uuid",         ← de req.params.id (o '?' si no aplica)
  "metadata": {
    "method": "PATCH",
    "path": "/api/patients/:id",
    "clinicId": "clinic-target-uuid"
  },
  "ip": "1.2.3.4",
  "userAgent": "Mozilla/5.0 ..."
}
```

**Deliberadamente NO incluye `body`** — puede tener PII y ya lo loguea Pino con redact. `AdminAudit` es forensics de "quién tocó qué", no "con qué contenido".

### Mapeo path→targetType

Tabla estática en el interceptor:

| Path prefix | targetType |
|---|---|
| `/api/patients` | Patient |
| `/api/appointments` | Appointment |
| `/api/conversations` | Conversation |
| `/api/services` | Service |
| `/api/professionals` | Professional |
| `/api/business-hours` | BusinessHours |
| `/api/time-off` | TimeOff |
| `/api/clinics` | Clinic |
| `/api/faq` | Faq |
| `/api/feedback` | Feedback |
| resto | Unknown |

## Consecuencias

### Positivas

- **Cierra el gap de compliance:** toda mutation sensible bajo impersonation queda en DB, queryable con SQL simple.
- **Cero fricción para controllers nuevos:** el trail cubre endpoints futuros automáticamente sin cambiar patrón.
- **Sin ruido operativo:** CLINIC_ADMIN normal no genera rows en `AdminAudit` (que es cross-tenant y no lleva `clinicId`).
- **Consistencia de `extractIp`:** un único source of truth para IP resolution en todo el backend.
- **Non-repudio dual (DB + logs):** aunque el DB write falle, Axiom + Sentry capturan el evento.
- **Backward compat:** los controllers de `/admin/*` con `@AdminAudit()` siguen funcionando idéntico.

### Negativas / Deuda técnica

- **Overhead en todo request:** el interceptor global corre en cada request (aunque early-return rápido). Impact medido: ~0.5ms per request para el skip path. Aceptable.
- **`await` bloqueante suma latencia:** ~5-20ms extra en mutations impersonadas por el INSERT en `AdminAudit`. Con impersonation infrecuente (uso operativo), es material despreciable.
- **`metadata.body` NO se persiste:** para debug forense de "qué valores exactos cambió el super", hay que cruzar el `requestId` en Axiom (que sí tiene el body redactado). Menos cómodo que tener todo en DB pero más seguro.
- **Table `AdminAudit` puede crecer rápido:** con 5+ operaciones/hora × 10 sesiones de impersonation por semana, ~2k rows/mes. Sin plan de archivado — se resuelve post-piloto con particionamiento por `createdAt`.
- **`inferTargetType` es hardcode:** cada módulo nuevo requiere una entrada en la tabla. Sin ella cae en `'Unknown'`. Trade-off vs meta-programación reflection: la lista es corta y explícita.

## Alternativas descartadas

| Alternativa | Razón del rechazo |
|---|---|
| Agregar `@AdminAudit()` a los 30+ handlers del panel | Frágil: endpoint nuevo sin decorador → gap silente. Además requiere tocar 8+ controllers. |
| Enum granular (`PATIENT_UPDATE`, `APPOINTMENT_STATUS_CHANGE`, etc.) | 10+ enum values requieren múltiples migrations. Query flexibility idéntica con `WHERE metadata->>'targetType' = 'Patient'` sobre JSON. |
| Middleware en vez de Interceptor | Middleware corre antes de guards → no tiene `req.user` populated. |
| Dual-write a Kafka + Postgres | Over-engineering para MVP. Sumar complejidad de topic + consumer sin ROI claro en 60 días de piloto. |
| Guardar body redactado en `metadata` | Duplica lo que Pino ya hace en Axiom. Aumenta riesgo de leak accidental de PII si el redactor de Pino y el del interceptor divergen. |
| `throw` en audit failure | Cliente en estado ambiguo ("¿se guardó?"). Peor UX que el `await + log`. |

## Migración

- Migration Prisma: `apps/backend/prisma/migrations/20260818130000_admin_audit_impersonation/migration.sql`
- Statements: `ALTER TYPE AdminAction ADD VALUE 'IMPERSONATED_WRITE'` + `ALTER TABLE AdminAudit ADD COLUMN "impersonatedBy" TEXT` + `CREATE INDEX ... impersonatedBy_createdAt`.
- Backfill: no requerido. Rows previos quedan con `impersonatedBy: NULL`.
- Rollback: eliminable con `ALTER TABLE ... DROP COLUMN` + `DROP INDEX`. El enum value queda (Postgres no soporta DROP VALUE nativo).

## Verificación

- 11 tests unitarios en `admin-audit.interceptor.spec.ts` cubren: skips (GET, sin user, sin impersonation sin decorador), rama 1 (impersonation + inferencia de targetType), rama 2 (decorador backward compat), audit failure sin throw, TRUST_PROXY on/off.
- 482 tests totales del backend verdes (cero regresiones vs baseline previo).

## Relacionado

- [[0014-superadmin-como-operador-saas]] — modelo del SUPERADMIN con impersonation
- [[0015-pino-axiom-sentry]] — observabilidad y correlation ID
- [[0004-pii-y-compliance]] — motivación de compliance
- Review de seguridad pre-lanzamiento (Hallazgo Alto #1)
