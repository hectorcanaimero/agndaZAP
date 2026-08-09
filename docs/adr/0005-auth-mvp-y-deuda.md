# ADR 0005 — Auth MVP: alcance, decisiones y deuda para post-piloto

- Fecha: 2026-08-08
- Estado: aceptado (piloto)
- Relacionados: [[0004-pii-y-compliance]], [[../notas/2026-08-08-bloque-auth]]

## Contexto

El **Bloque Auth** cubre login + JWT + RBAC + guards multi-tenant + rate-limit
por IP y por email. Es un MVP funcional para el piloto con 1 clínica: cero
CRUDs de usuarios en runtime, cero panel de admin, cero password reset. El seed
crea 2 usuarios dev y ese es todo el "gestor de identidades" que existe.

Este ADR documenta las decisiones tomadas y la deuda **explícita** que se
posterga para post-piloto. Todo lo que NO está acá se considera pendiente
sin justificación.

## Decisiones (implementadas)

### 1. HS256 forzado en verify y sign

- `JwtStrategy` incluye `algorithms: ['HS256']` en el super.
- `JwtModule.register` fija `signOptions.algorithm: 'HS256'`.
- Sin este pinning, `jsonwebtoken` intenta verificar contra todos los
  algoritmos soportados por default — un atacante que conociera el `JWT_SECRET`
  podría firmar con HS384/HS512 y el token seguiría siendo aceptado.
- Test dedicado en `src/auth/jwt-algorithms.spec.ts`.

### 2. JWT expiration 24h sin refresh

- Balance UX (no re-login diario) vs blast radius si un token filtra.
- `expiresIn` vive en `JwtModule.register` (single source of truth). El
  service ya NO lo pasa a `signAsync`.
- **Deuda**: par access(15m)+refresh(7d) + denylist en Redis por `jti` cuando
  llegue el panel de admin.

### 3. bcrypt(10) para MVP

- Sweet-spot: ~100 ms/hash en hardware moderno. Aceptable para volúmenes de
  piloto (< 100 logins/hora).
- **Deuda**: subir a bcrypt(12) con re-hash on-login (comparar con `getRounds`
  y re-hashear si es menor) cuando el volumen lo permita.

### 4. `MinLength(8)` en `LoginDto`

- Umbral bajo pero coherente: para LOGIN sirve `>= 8` porque no exponemos
  reglas al atacante (no informa al usuario "tu password de 6 chars no
  cumple política" — ya se aceptó al crearla).
- **Deuda**: subir a 12 en el DTO de **creación/reset** cuando llegue.

### 5. Rate-limit por IP + por email hasheado

- **Por IP** (`RateLimit(10, 'auth-login')`): fixed window 60s. Mitigación
  de ráfagas del mismo host.
- **Por email** (`login_fail:<sha256(email).slice(0,16)>`): fixed window
  15 min, máximo 5 fails. Defensa contra rotación de IP (residencial,
  botnets). Login OK borra la clave.
- Nunca guardamos el email en claro en Redis — sha256 truncado a 16 hex chars.
- Cero PII en logs: sólo IP + status.

### 6. Sin MFA, sin password reset, sin denylist de JWT (por ahora)

- **MFA**: postergado hasta que un piloto lo pida. TOTP con `otplib` cuando
  se necesite.
- **Password reset**: no hay flow. Sólo `hashPassword` en seed. Requiere
  email transaccional (Postmark/Resend) + `PasswordResetToken` con
  expiración corta.
- **Denylist de JWT**: hoy un token filtrado es válido hasta que expire.
  Aceptable con expiración de 24h; al agregar refresh tokens, agregar
  denylist en Redis por `jti`.

### 7. `TenantContext` + `assertClinicScope` + `isSuperadmin` = precondición del Bloque Panel

- **Estado**: **NO implementado todavía**. Todavía no lo necesitamos porque
  ningún endpoint scoped por clínica existe (los endpoints públicos usan
  slug del path, no el JWT).
- **Regla**: antes de tocar el primer CRUD scoped del panel, hay que
  introducir estos helpers. Sin ellos, un `SUPERADMIN` sin `clinicId`
  puede colar queries a cualquier tenant si el código no lo blindea
  explícitamente.
- Shape sugerido:
  ```ts
  // TenantContext = decorator + guard que:
  //  - extrae req.user (userId, clinicId, role)
  //  - decide si el usuario puede operar sobre el clinicId del path/query
  //  - falla con 403 si intenta cross-tenant sin ser SUPERADMIN
  ```

### 8. `professionalId` en JWT payload — deuda

- Hoy el payload es `{ sub, clinicId, role }`. Para endpoints scoped por
  profesional (ej: "mis citas de hoy") vamos a necesitar `professionalId`
  en el token — sino cada request pega a la tabla `Professional` para
  resolver `userId → professionalId`.
- **Migración necesaria** (no ejecutar ahora): sumar `professionalId String?
  @unique @db.Uuid` en `User` cuando llegue el rol.
- Postergado hasta que `PROFESSIONAL` empiece a consumir endpoints reales.

### 9. Auditoría de eventos de auth

- **Hoy**: log a `logger.log/warn` — queda en stdout. Sólo `userId + role`
  para el ok, `ip + status` para el fail.
- **Deuda**: cuando llegue el panel de admin, persistir en tabla `AuthEvent`:
  `{ id, userId?, ip, kind: 'LOGIN_OK'|'LOGIN_FAIL'|'ROLE_CHANGE', occurredAt }`.
  Retención 90 días. Consultable desde el panel de admin de la clínica
  correspondiente (y globalmente por superadmin).

### 10. Seed guard contra `NODE_ENV=production`

- El seed crea usuarios con passwords conocidos (`super1234`, `demo1234`) y
  una clínica hardcodeada. Correrlo en prod es un vector obvio.
- Fix: al inicio de `main()` se tira `Error('seed no debe correr en producción')`
  si `NODE_ENV === 'production'`.

### 11. `WEBHOOK_TOKEN` obligatorio en producción

- Antes: el chequeo estaba comentado y el webhook aceptaba requests sin token.
- Ahora: en `NODE_ENV=production` sin `WEBHOOK_TOKEN` seteado → 403 en el
  handler ("WEBHOOK_TOKEN no configurado en producción"). Fail-closed.
- WAHA debe configurarse con `WHATSAPP_HOOK_HEADERS='x-webhook-token: <token>'`
  para enviar el header custom que validamos.
- **Deuda**: migrar a `WEBHOOK_HMAC` (firma) cuando WAHA lo soporte estable.

### 12. `JWT_SECRET` validado en fail-fast

- En prod: `main.ts` valida `JWT_SECRET.length >= 32` y que no empiece con
  `dev-`. Cualquier violación → crash al bootstrap.
- Motivo: es el smell obvio de olvido de rotación al pasar de dev a prod.

### 13. `TRUST_PROXY` toggle explícito

- Nuevo toggle env: `TRUST_PROXY=true` → Express aplica `set('trust proxy', 1)`.
- Sin él, detrás de Cloudflare/nginx todos los `req.ip` son la IP del proxy
  y el rate-limit por IP colapsa a una sola bucket. Con él, se resuelve
  correctamente al primer valor del `X-Forwarded-For`.
- Sanitización de XFF sigue en `extractIp()` (validación regex + slice 45).

### 14. Elimina `admin-ping` de la superficie HTTP

- El endpoint dummy `GET /api/auth/admin-ping` se eliminó. Sirvió como
  smoke-test del `RolesGuard` durante el desarrollo, pero **expone rol al
  atacante** (sabe qué role tiene el user) sin agregar valor operativo.
- El comportamiento del guard sigue cubierto por tests unitarios en
  `auth.controller.spec.ts` (describe "RolesGuard" — 4 casos).

## Consecuencias

- **Piloto (1 clínica)**: cada clínica opera con dev creds rotadas antes del
  go-live. La deuda es aceptable porque el blast radius es acotado (1 tenant,
  ~50 pacientes/semana, sin usuarios externos).
- **Escalar a >5 clínicas o exponer login público** (self-signup): antes de
  eso, ejecutar el roadmap de esta ADR — al menos refresh tokens + denylist,
  password reset, `TenantContext` helper, y `AuthEvent` persistido.
- **Auditorías externas**: este documento + [[0004-pii-y-compliance]] son
  el punto de partida — resumen el estado real, no el deseado.

## Roadmap de cierre (orden sugerido)

1. `TenantContext` + `assertClinicScope` + `isSuperadmin` (precondición del panel).
2. Refresh tokens + denylist en Redis.
3. Password reset flow (email + `PasswordResetToken`).
4. bcrypt(12) + re-hash on-login.
5. `AuthEvent` persistido (tabla + retención).
6. MFA (TOTP con `otplib`).
7. `professionalId` en JWT + migración correspondiente.

## Alternativas descartadas

- **JWT stateless SIN rate-limit por email**: baja fricción, alto riesgo. Un
  atacante con botnet residencial rota IPs y hace credential stuffing hasta
  agotar cupo por IP × cantidad de IPs. Descartado.
- **Session cookies + Redis session store**: overhead operativo mayor sin
  ganancia clara para MVP con 1 tenant. Descartado.
- **Bloquear go-live hasta cerrar TODA la deuda**: mata el piloto. Sin
  producto en el mundo no aprendemos qué medidas realmente importan.

## Seguimiento

Cada item de deuda debe:
1. Tener issue abierta en el tracker (Plane).
2. Al cerrar, actualizar la sección correspondiente con
   `**Estado (YYYY-MM-DD)**: cerrado — ver commit / PR / migración`.
