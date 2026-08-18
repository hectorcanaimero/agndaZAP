# ADR 0014 — SUPERADMIN como operador del SaaS

## Estado

Aceptada — 2026-08-14

## Contexto

El `SUPERADMIN` fue implementado como un **escape hatch**: puede acceder a cualquier endpoint del panel de clínica pasando `?clinicId=xxx` en el query string (ver `apps/backend/src/auth/tenant-context.util.ts:41-48`). Sin auditoría, sin UI propia, y sin distinción semántica del `CLINIC_ADMIN`. El modelo `Clinic` no tiene campo `status` ni concepto de suspensión.

[[0005-auth-mvp-y-deuda]] §7 ya marcaba esto como deuda explícita: "sin ellos, un SUPERADMIN sin `clinicId` puede colar queries a cualquier tenant si el código no lo blindea explícitamente". Ese patrón fue aceptable durante el piloto con una clínica. No lo es para un SaaS multi-tenant con clínicas de terceros y datos de salud.

Este ADR cierra esa deuda y promueve al SUPERADMIN de "operador manual con SQL directo" a **operador de plataforma** con panel propio, impersonation auditada, y ciclo de vida de cuentas de clínica.

## Decisión

### 1. Nuevo módulo `admin/` en el backend

Ruta base: `/api/admin/*`. Todos los endpoints con `@Roles('SUPERADMIN')` a nivel de clase de controller. Estructura:

```
apps/backend/src/admin/
├── admin.module.ts
├── admin-audit.interceptor.ts       # persiste toda acción no-read en AdminAudit
├── admin-audit.service.ts           # helper logAction() reusable
├── admin-clinics.controller.ts + .service.ts
├── admin-metrics.controller.ts + .service.ts
├── admin-audit.controller.ts
└── impersonation.controller.ts + impersonation.service.ts
```

### 2. Modelo Clinic extendido

Nueva migración `prisma/migrations/YYYYMMDDHHMMSS_saas_admin`:

```prisma
enum ClinicStatus {
  ACTIVE
  SUSPENDED
  ARCHIVED
}

model Clinic {
  // campos existentes ...
  status          ClinicStatus @default(ACTIVE)
  suspendedAt     DateTime?
  suspendedReason String?
}

model AdminAudit {
  id           String   @id @default(uuid()) @db.Uuid
  actorUserId  String   @db.Uuid
  actor        User     @relation(fields: [actorUserId], references: [id])
  action       AdminAction
  targetType   String
  targetId     String?
  metadata     Json
  ip           String?
  userAgent    String?
  createdAt    DateTime @default(now())

  @@index([actorUserId, createdAt])
  @@index([targetType, targetId, createdAt])
}

enum AdminAction {
  CREATE_CLINIC
  UPDATE_CLINIC
  SUSPEND_CLINIC
  REACTIVATE_CLINIC
  START_IMPERSONATION
}
```

### 3. Impersonation con JWT temporal

`POST /admin/clinics/:id/impersonate` genera un JWT de 30 minutos con el claim `impersonatedBy`. Reemplaza por completo al patrón `?clinicId=xxx`.

```ts
// Payload del JWT de impersonation
{
  sub: originalSuperAdminUserId,
  role: 'CLINIC_ADMIN',
  clinicId: targetClinicId,
  impersonatedBy: originalSuperAdminUserId,
  exp: now + 30min
}
```

La acción queda registrada en `AdminAudit` con `action: START_IMPERSONATION`.

### 4. `AuthService.login()` bloquea clínicas no ACTIVE

```ts
if (user.clinic && user.clinic.status !== 'ACTIVE') {
  throw new ForbiddenException('Clínica suspendida o archivada');
}
```

Excepción: el SUPERADMIN no tiene `clinicId` en el JWT (no está atado a una clínica), por lo que no se evalúa este bloqueo para él.

### 5. Nuevo path `/[locale]/admin/*` en el frontend

Path paralelo a `/panel/*`. El middleware de Next.js redirige:
- `SUPERADMIN` sin `clinicId` que intenta acceder a `/panel/*` → `/admin/dashboard`.
- `CLINIC_ADMIN` o `PROFESSIONAL` que intenta acceder a `/admin/*` → `/panel/dashboard`.

### 6. Fuera de alcance (fase 2)

- `Plan`, `Subscription`, trial y billing (Stripe/MercadoPago).
- Signup self-service público.
- Métricas MRR / churn.
- MFA para el SUPERADMIN.

## Impersonation — flujo detallado

Ver diagrama completo en [[notas/2026-08-14-impersonation-flow]].

1. El SUPERADMIN navega a `/admin/clinics/:id`.
2. Hace click en "Entrar como esta clínica".
3. El frontend llama `POST /api/admin/clinics/:id/impersonate`.
4. El backend valida que la clínica esté `ACTIVE`, genera el JWT temporal, registra en `AdminAudit`.
5. El frontend guarda el JWT original en `showly_admin_token`, sobrescribe `showly_token` con el temporal.
6. Redirect a `/panel/dashboard`.
7. `PanelShell` detecta `jwt.impersonatedBy` y renderiza el `ImpersonationBanner`: _"Estás impersonando: [Nombre clínica]. Volver al Admin"_.
8. Al hacer click en "Volver al Admin": limpiar `showly_token`, restaurar desde `showly_admin_token`, redirect a `/admin/dashboard`.

## Auditoría

`AdminAudit` persiste toda acción no-read del SUPERADMIN. El `AdminAuditInterceptor` se aplica a nivel de controller via `@UseInterceptors`. Metadata incluye IP (de `req.ip`, con `TRUST_PROXY` habilitado en prod) + User-Agent + payload contextual según la acción. Consultable desde `GET /admin/audit` con filtros por actor, acción, target y rango de fechas.

## Consecuencias

### Positivas

- **Cero cross-tenant accidental**: el override `?clinicId=xxx` queda deprecado y eliminado de todos los controllers del panel.
- **Trazabilidad completa**: toda acción administrativa queda en `AdminAudit`. Importante para compliance en datos de salud (ver [[0004-pii-y-compliance]]).
- **Base para billing**: cuando llegue la fase 2, `Subscription` se monta sobre `Clinic.status` — la infraestructura ya está.
- **Cierre de deuda**: [[0005-auth-mvp-y-deuda]] §7 queda formalmente cerrado.

### Negativas / Deuda técnica

- **Migración de tests**: todos los specs que usaban el patrón `SUPERADMIN + ?clinicId=` override deben actualizarse para usar JWT de impersonation o el nuevo guard.
- **Sin MFA todavía**: el SUPERADMIN tiene acceso al panel de toda la plataforma y no tiene segundo factor. Recomendado implementar TOTP antes de exponer a Internet con clientes reales. **Warning explícito: no exponer el `/admin` sin MFA en producción con datos de terceros.**
- **`ARCHIVED` no borra datos**: es un soft-delete semántico. Compliance/DSAR (derecho al olvido de pacientes) queda para una fase futura.
- **JWT impersonado expira en 30 min**: si el super está activo en el panel de la clínica y el token expira, es redirigido al login. El `ImpersonationBanner` debe mostrar el tiempo restante como hint de UX.

## Alternativas descartadas

| Alternativa | Razón del rechazo |
|---|---|
| Mantener `?clinicId=xxx` como fallback | Deja el hueco de auditoría abierto. El objetivo es cerrarlo, no parchearlo. |
| Cookie/header en vez de JWT temporal para impersonation | Un JWT es autónomo: los guards existentes lo validan sin cambios de infraestructura. Una cookie requiere un store extra. |
| Sesión con `impersonatingClinicId` en Redis + cookie flag | Más partes móviles (TTL en Redis, sincronización cliente-servidor) para el mismo resultado que un JWT firmado. |

## Relacionado

- [[0005-auth-mvp-y-deuda]] §7 (cerrado por este ADR)
- [[0004-pii-y-compliance]] (contexto de compliance en datos de salud)
- [[notas/2026-08-14-impersonation-flow]] (diagrama del flujo de cookies y redirects)
