# Spec — AdminAudit + trail de impersonation (Sprint día 4)

**Fecha:** 2026-08-20 (adelantado — ejecutado 2026-08-18)
**Sprint:** Pre-lanzamiento 40 clínicas
**Alcance:** Día 4 (Jueves) — ~5h efectivas
**Cierra:** Hallazgo Alto #1 del review de seguridad + Nit del `extractIp` inconsistente

## Contexto

Del review de seguridad (Alto #1):

> Cuando un SUPERADMIN impersona una clínica, el JWT lleva `sub = super_user_id` + `role = CLINIC_ADMIN` + `impersonatedBy = super_user_id`. En ese estado el SUPERADMIN opera contra endpoints del panel que tocan PII de salud. **Ninguna de esas acciones queda auditada en `AdminAudit`** — el interceptor solo se aplica al controller del área `/admin/*`. El `START_IMPERSONATION` sí queda, pero después hay una ventana de 30 min ciega en el trail persistente.

Con 40 clínicas activas y datos reales de pacientes bajo LGPD, ese gap es bloqueante. Este spec cierra la deuda documentada en la Alta 1 + el Nit del `extractIp` inconsistente.

## Baseline verificado

**`AdminAudit` (schema.prisma):** actualmente solo tiene `actorUserId`, `action`, `targetType`, `targetId`, `metadata`, `ip`, `userAgent`, `createdAt`. **NO tiene `impersonatedBy`.**

**`AdminAction` enum:** `CREATE_CLINIC | UPDATE_CLINIC | SUSPEND_CLINIC | REACTIVATE_CLINIC | ARCHIVE_CLINIC | START_IMPERSONATION`. **No cubre mutations del panel.**

**`AdminAuditInterceptor`:**
- Aplicado por-controller con `@UseInterceptors` (solo `AdminClinicsController`)
- `.catch()` fire-and-forget (audit puede perderse silenciosamente)
- Reimplementa `extractIp` sin validar `TRUST_PROXY` (inconsistente con el resto del proyecto)
- Requiere decorador `@AdminAudit()` en cada handler → si no está, no audita

**Los 8+ controllers del panel** (`appointments`, `patients`, `conversations`, `services`, etc.) NO están cubiertos por el interceptor. Si un SUPERADMIN impersona y edita datos, queda solo en `logger.log` (stdout).

## Decisión arquitectónica

### Opción A · Añadir `@AdminAudit()` a cada controller del panel (descartada)

- Requiere tocar 8-10 controllers + 30+ handlers
- Frágil: si alguien agrega un endpoint nuevo y olvida el decorador → gap silente
- El interceptor sigue siendo per-controller

### Opción B · Interceptor GLOBAL condicional (elegida)

- Registrar `AdminAuditInterceptor` como `APP_INTERCEPTOR` global
- **Lógica dual:**
  - Si `user.impersonatedBy` presente + mutation (POST/PATCH/DELETE) → auditar SIEMPRE (con el nuevo `IMPERSONATED_WRITE`)
  - Si NO impersonation + decorador `@AdminAudit()` presente → auditar (backward compat con admin controllers)
  - Cualquier otro caso → skip
- **Ventaja:** cero cambio en controllers del panel. Todo endpoint nuevo bajo impersonation queda cubierto automáticamente.
- **Riesgo:** overhead en TODO request. Mitigación: early-return si method no es mutable o no hay `req.user`.

### Enum: granular vs genérico

**Elegido: genérico + metadata rica.** Un solo valor nuevo `IMPERSONATED_WRITE` en el enum. El detalle (método HTTP, path, targetType inferido) va a `metadata` como JSON. Ventajas:

- 1 migration en vez de 10+ enum values
- Query: `WHERE metadata->>'targetType' = 'Patient'` sigue siendo eficiente con GIN index (futuro)
- Extensible: agregar campo nuevo no requiere migration

## Acceptance criteria

### AC-1 · Migration aplica limpio
```
pnpm prisma migrate dev  →  crea archivo
pnpm prisma migrate deploy → aplica en prod
```
Sin errores. El enum `AdminAction` incluye `IMPERSONATED_WRITE`. El modelo `AdminAudit` tiene `impersonatedBy String?`. Index en `(impersonatedBy, createdAt)`.

### AC-2 · Mutation bajo impersonation queda en `AdminAudit`
```
Given SUPERADMIN impersonando clinic-abc (JWT con impersonatedBy=super-1)
When PATCH /api/patients/xxx con {name: "new"}
Then AdminAudit tiene un row con:
  action = 'IMPERSONATED_WRITE'
  actorUserId = super-1  (userId del JWT — real actor)
  impersonatedBy = super-1
  targetType inferido del path (ej. 'Patient')
  targetId = xxx (del req.params.id)
  metadata = { method: 'PATCH', path: '/api/patients/:id', clinicId: 'clinic-abc' }
  ip = <IP real, respetando TRUST_PROXY>
  userAgent = <UA del request>
```

### AC-3 · Mutation SIN impersonation NO se audita
```
Given CLINIC_ADMIN operando su propia clínica (JWT sin impersonatedBy)
When PATCH /api/patients/xxx
Then AdminAudit NO tiene row nuevo (evita ruido de operación normal)
```

### AC-4 · Mutation en /admin/* con `@AdminAudit()` sigue funcionando
```
Backward compat con Opción anterior — los controllers de /admin/* que ya
usan el decorador siguen auditando idéntico.
```

### AC-5 · GET request NO audita en ningún caso
```
Read-only nunca deja rastro auditable. Solo POST/PATCH/DELETE/PUT.
```

### AC-6 · `extractIp` respeta `TRUST_PROXY`
```
El interceptor delega en el helper compartido `common/extract-ip.ts`.
En prod (TRUST_PROXY=true) lee X-Forwarded-For. En dev sin proxy,
lee req.ip directo. NO acepta X-Forwarded-For si TRUST_PROXY=false.
```

### AC-7 · Audit failure NO tira 500 al cliente
```
Si el INSERT en AdminAudit falla (DB blip), la mutation original ya se
ejecutó → cliente recibe 200. El audit failure queda en:
- logger.error(...) → stdout → Axiom
- Se propaga a Sentry via SentryFilter
```
No-repudio comprometido pero visible en 2 sistemas separados (Axiom + Sentry).

## Task breakdown

| # | Task | Est |
|---|---|---|
| T-6.1 | Prisma migration: `IMPERSONATED_WRITE` enum + `impersonatedBy String?` + index | 1h |
| T-6.2 | Actualizar `AdminAuditService.logAction()` con `impersonatedBy` opcional | 0.5h |
| T-6.3 | Refactor `AdminAuditInterceptor` con lógica dual (impersonation vs decorador) + fix extractIp + inferencia de targetType desde path | 2h |
| T-6.4 | Registrar interceptor como `APP_INTERCEPTOR` global en `AdminModule` (o mover al `AppModule`) | 0.5h |
| T-6.5 | Tests: mutation con impersonation, mutation sin impersonation con decorador, mutation sin impersonation sin decorador, GET skip, audit failure no bloquea | 1h |

**Total:** 5h efectivas.

## Contratos técnicos

### Enum extendido
```prisma
enum AdminAction {
  CREATE_CLINIC
  UPDATE_CLINIC
  SUSPEND_CLINIC
  REACTIVATE_CLINIC
  ARCHIVE_CLINIC
  START_IMPERSONATION
  IMPERSONATED_WRITE   // NUEVO
}
```

### Modelo extendido
```prisma
model AdminAudit {
  // ... campos existentes ...
  impersonatedBy String?  // NUEVO — userId del actor real bajo impersonation
  // ... índices existentes ...
  @@index([impersonatedBy, createdAt])  // NUEVO
}
```

### Inferencia de targetType desde path

Mapper simple en el interceptor:
```ts
// /api/patients/xxx           → Patient
// /api/appointments/xxx/status → Appointment
// /api/conversations/xxx/reply → Conversation
// /api/services/xxx           → Service
// /api/professionals/xxx      → Professional
// /api/business-hours/xxx     → BusinessHours
// /api/time-off/xxx           → TimeOff
// /api/clinics/xxx            → Clinic
// /api/faq/xxx                → Faq
// fallback                    → "Unknown"
```

### `AdminAudit.metadata` shape para `IMPERSONATED_WRITE`

```json
{
  "method": "PATCH",
  "path": "/api/patients/:id",
  "clinicId": "<uuid del tenant impersonado>"
}
```

**Deliberadamente NO incluimos `body`** — puede tener PII y el request body ya lo loguea Pino con redact aplicado. `AdminAudit` es forensics de "quién tocó qué", no "con qué contenido".

## Definition of Done

- [ ] `pnpm prisma migrate dev` aplica limpio
- [ ] `pnpm test` verde en backend (todos los tests + los nuevos)
- [ ] `AdminAudit` table tiene el nuevo campo y el nuevo enum value
- [ ] Test: mutation impersonada → row en AdminAudit con todos los campos correctos
- [ ] Test: mutation normal (sin impersonation) → NO row en AdminAudit
- [ ] Test: extractIp usa el helper compartido
- [ ] Test: audit failure → logger.error + no throw (mutation OK)
- [ ] Update `docs/notas/2026-08-19-observabilidad-implementada.md` con la sección de audit trail
- [ ] ADR corto `docs/adr/0016-admin-audit-impersonation-trail.md`

## Referencias

- Review de seguridad (Hallazgo Alto #1)
- [[../adr/0014-superadmin-como-operador-saas|ADR 0014]] — SUPERADMIN + impersonation
- [[../adr/0004-pii-y-compliance|ADR 0004]] — motivación de compliance
