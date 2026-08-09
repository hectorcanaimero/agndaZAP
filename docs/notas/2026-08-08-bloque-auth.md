# 2026-08-08 — Bloque 5: Auth (JWT + guards multi-tenant + RBAC)

Wiring del módulo de autenticación. Login con JWT firmado, guard global
deny-by-default, RBAC básico y seed extendido con usuarios dev.

## Endpoints agregados

| Método | Ruta                    | Auth               | Rate-limit                       | Notas                                |
| ------ | ----------------------- | ------------------ | -------------------------------- | ------------------------------------ |
| POST   | `/api/auth/login`       | Público (`@Public`) | 10/min IP + 5/15min email hash   | Devuelve `{ accessToken }`           |
| GET    | `/api/auth/me`          | JWT                | —                                | User + `clinic` (null si SUPERADMIN) |

> **Nota (post-audit)**: `GET /api/auth/admin-ping` fue **removido** de la
> superficie HTTP. El comportamiento del `RolesGuard` sigue cubierto por
> tests unitarios en `auth.controller.spec.ts` (describe "RolesGuard").

## Guard global

`JwtAuthGuard` se registra en `AuthModule` como `APP_GUARD`. **Todas** las rutas
requieren Bearer token por default. Rutas públicas marcadas con `@Public()`:

- `POST /api/auth/login` (opt-out puntual)
- `PublicController` completo (`GET /api/public/clinics/:slug`, `/availability`, `POST /appointments`)
- `WebhookController` completo (`POST /webhooks/waha`)

## Cómo firmar / verificar JWT

```bash
# 1) Obtener token
curl -X POST http://localhost:4000/api/auth/login \
  -H 'content-type: application/json' \
  -d '{"email":"admin@demo.dev","password":"demo1234"}'
# → { "accessToken": "eyJ..." }

# 2) Consumir endpoint protegido
curl -H "Authorization: Bearer <token>" http://localhost:4000/api/auth/me

# 3) Decodificar payload (sin verificar firma) — util para debug
TOKEN=eyJ...
python3 -c "import base64,json; p='$TOKEN'.split('.')[1]; p+='='*(4-len(p)%4); print(json.dumps(json.loads(base64.urlsafe_b64decode(p)), indent=2))"
```

Payload: `{ sub: <userId>, clinicId: <clinicId|null>, role: 'SUPERADMIN'|'CLINIC_ADMIN'|'PROFESSIONAL', iat, exp }`.
Expiración: **24h**.

## Credenciales del seed (⚠️ SÓLO DEV)

Estas cuentas viven en `apps/backend/prisma/seed.ts` con passwords hasheadas via
`bcrypt(10)`. **Nunca** usarlas en producción — rotarlas antes del piloto.

| Email                    | Password    | Rol            | Clínica        |
| ------------------------ | ----------- | -------------- | -------------- |
| `super@agendazap.dev`    | `super1234` | `SUPERADMIN`   | `null`         |
| `admin@demo.dev`         | `demo1234`  | `CLINIC_ADMIN` | `demo`         |

## Env vars

Todas validadas en `main.ts` con fail-fast para `NODE_ENV=production`:

- `JWT_SECRET` — dev fallback: `dev-jwt-secret`. En prod: mínimo 32 chars
  **y** no puede empezar con `dev-`. Generar con `openssl rand -base64 48`.
- `TRUST_PROXY` — `"true"` sólo cuando el backend está detrás de un proxy
  confiable (Cloudflare, nginx, ALB). Sin él, el rate-limit por IP colapsa
  a una sola bucket porque `req.ip` es la IP del proxy.
- `WEBHOOK_TOKEN` — obligatorio en producción. Sin token seteado, el
  `WebhookController` devuelve 403 fail-closed. WAHA debe configurarse
  con `WHATSAPP_HOOK_HEADERS='x-webhook-token: <token>'`.

Ver `.env.example` en la raíz del monorepo para el listado completo con
comentarios (recién creado post-audit; `.gitignore` en la raíz asegura que
`.env` no se commitee accidentalmente).

## Decisiones y trade-offs

- **`bcrypt` con 10 rounds**: sweet-spot MVP (~100 ms/hash). Cuando el volumen
  de login lo permita, subir a 12+.
- **Anti-timing en login**: si el email no existe, corremos igual una
  `bcrypt.compare` contra un hash dummy (`DUMMY_HASH` en `password.util.ts`)
  para que el response time no revele enumeración.
- **Anti-enumeración**: mismo mensaje `"credenciales inválidas"` para "user no
  existe" y "password mala".
- **Guard global deny-by-default**: registrado como `APP_GUARD` en `AuthModule`.
  Cualquier endpoint nuevo queda protegido por default. `@Public()` es opt-out
  explícito.
- **HS256 single-signer**: alcanza para MVP. Migración a RS256/JWKS cuando
  necesitemos rotación multi-instancia.
- **No `passport-local`**: usamos DTO + `AuthService.login` directo. Menos deps,
  menos magia; el flujo de credenciales cabe en 20 líneas.
- **Cero PII en logs**: solo `userId` + `role`. NUNCA emails, IPs (salvo en el
  rate-limit guard) ni passwords.

## Deuda documentada — post-piloto

Lo siguiente está **fuera de alcance** por ahora. Cerrar antes de multi-cliente:

- **Refresh tokens**: hoy accessToken expira en 24h y el user re-loguea.
  Migrar a par access(15m)+refresh(7d) cuando llegue el panel.
- **Password reset**: no hay endpoint. Sólo `hashPassword` en seed. Va a
  requerir email transaccional (Postmark/Resend) + expiración de tokens.
- **MFA**: postergado. TOTP con `otplib` cuando el piloto lo pida.
- **Session revocation / denylist**: hoy un JWT filtrado es válido hasta expirar.
  Al agregar refresh tokens, agregar denylist en Redis por `jti`.
- **Rate-limit por email además de IP**: hoy sólo por IP. Si un atacante rota
  IPs (residenciales), el rate-limit no ayuda. Agregar contador por email
  cuando tengamos evidencia real.
- **Bloqueo temporal de cuenta** tras N intentos fallidos: post-piloto.
- **Auditoría de login**: hoy el log queda en stdout. Persistir eventos de
  auth (login ok/fail, cambios de rol) cuando llegue el compliance formal.

## Tests

- `apps/backend/src/auth/auth.service.spec.ts` — login flow, anti-timing,
  multi-tenant, `me()`.
- `apps/backend/src/auth/auth.controller.spec.ts` — DTO validation,
  `RolesGuard`, contrato JWT firmado/verificado.
- Total del backend: **76 tests verdes** (57 previos + 19 nuevos).

## Smoke E2E ejecutado

Todos los siguientes pasaron:

- Login válido → 200 `{ accessToken }` con payload `{ sub, clinicId, role: CLINIC_ADMIN }`.
- `GET /auth/me` con token → 200 user + clinic, **sin** password.
- `GET /auth/me` sin token → 401.
- `GET /auth/admin-ping` con CLINIC_ADMIN → 200.
- `GET /auth/admin-ping` con JWT de PROFESSIONAL → 403.
- `GET /api/public/clinics/demo` → 200 (guard global respeta `@Public()`).
- `POST /webhooks/waha` → 200 (webhook público).
- 11 logins con password mala → 429 `Retry-After: 60`.

## Archivos

- `apps/backend/src/auth/` — módulo completo.
- `apps/backend/src/app.module.ts` — importa `AuthModule`.
- `apps/backend/src/main.ts` — `JWT_SECRET` en required env.
- `apps/backend/src/public/public.controller.ts` — `@Public()` a nivel controller.
- `apps/backend/src/public/public.module.ts` — exporta `REDIS_CLIENT`.
- `apps/backend/src/whatsapp/webhook.controller.ts` — `@Public()`.
- `apps/backend/prisma/seed.ts` — 2 users dev idempotentes.
- `.env` — `JWT_SECRET=dev-jwt-secret`.
