# Runbook de lanzamiento — Piloto 40 clínicas

**Fecha objetivo:** semana del 2026-08-25 (canary)
**Duración piloto:** 60 días
**Owner:** Héctor (dev único)

Este runbook es la secuencia ejecutable para deployar Showly al piloto real. Cada bloque tiene un check verificable y un rollback obvio.

## Pre-requisitos (chequeá esto ANTES del día D)

- [ ] Cuentas cloud creadas: **Axiom** (dataset `showly-prod`), **Sentry** (proyectos `showly-backend` + `showly-web`), **BetterStack** (uptime)
- [ ] DSNs de Sentry validados (ya hicimos el test de conexión — ver [[notas/2026-08-19-observabilidad-implementada]] §validación)
- [ ] Servidor prod disponible (Hetzner, DigitalOcean, etc.) con Docker + Docker Compose
- [ ] Dominios apuntando al server:
  - `<dominio-panel>` → server prod (para el web + `/api/*` del panel)
  - `<dominio-backend>` → server prod (para el API del backend detrás de Caddy)
- [ ] Caddyfile en `/srv/showly/Caddyfile` configurado para hacer reverse proxy a `backend:4000` y `web:3002`

## Bloque 1 · Preparar `.env.production` (30 min)

Copiar `.env.example` como `.env.production` y llenar con secrets reales generados. Comandos para generar:

```bash
# JWT_SECRET (48 bytes base64)
openssl rand -base64 48

# WEBHOOK_TOKEN (32 chars hex)
openssl rand -hex 32

# WEBHOOK_HMAC_SECRET (48 bytes base64 — usar si WAHA soporta HMAC)
openssl rand -base64 48

# Passwords para WAHA (2 distintos, uno por servicio)
openssl rand -base64 24  # WAHA_DASHBOARD_PASSWORD
openssl rand -base64 24  # WHATSAPP_SWAGGER_PASSWORD

# Postgres password
openssl rand -base64 24  # POSTGRES_PASSWORD
```

Checklist `.env.production` completo:

### DB / Redis / WAHA
- [ ] `DATABASE_URL` con password real
- [ ] `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`
- [ ] `REDIS_URL=redis://redis:6379`
- [ ] `WAHA_API_KEY`, `WAHA_DASHBOARD_USERNAME/PASSWORD`, `WHATSAPP_SWAGGER_USERNAME/PASSWORD`
- [ ] `WEBHOOK_TOKEN` (fallback)
- [ ] `WEBHOOK_HMAC_SECRET` (recomendado si WAHA Plus disponible)

### Auth + CORS
- [ ] `JWT_SECRET` (≥32 chars, sin prefix `dev-`)
- [ ] `CORS_ORIGINS=https://<dominio-panel>,https://<dominio-backend>`
- [ ] `TRUST_PROXY=true` (Caddy detrás)
- [ ] `NODE_ENV=production`

### LLMs
- [ ] `DEEPSEEK_API_KEY`, `GEMINI_API_KEY`, `OPENAI_API_KEY`

### Mail
- [ ] `RESEND_API_KEY` (para invitaciones de admin)
- [ ] `EMAIL_FROM="Showly <no-reply@dominio-real.com>"`
- [ ] `APP_BASE_URL=https://<dominio-panel>`

### Observability (NUEVO del sprint)
- [ ] `LOG_LEVEL=info` (no `debug` en prod — quema quota de Axiom)
- [ ] `LOG_PRETTY=false`
- [ ] `AXIOM_ENABLED=true`, `AXIOM_TOKEN`, `AXIOM_DATASET_LOGS=showly-prod`, `AXIOM_ORG_ID`
- [ ] `SENTRY_ENABLED=true`, `SENTRY_DSN=<backend-dsn>`, `SENTRY_ENVIRONMENT=production`
- [ ] `SENTRY_TRACES_SAMPLE_RATE=0.1` (10%; subir si querés más traces)
- [ ] `NEXT_PUBLIC_SENTRY_ENABLED=true`, `NEXT_PUBLIC_SENTRY_DSN=<web-dsn>`
- [ ] `NEXT_PUBLIC_SENTRY_ENVIRONMENT=production`
- [ ] `SENTRY_ORG`, `SENTRY_PROJECT`, `SENTRY_AUTH_TOKEN` (build-time para sourcemaps)

### Release tracking (opcional pero recomendado)
- [ ] `SENTRY_RELEASE=git-$(git rev-parse --short HEAD)` — inyectar antes del `up -d --build`
- [ ] `NEXT_PUBLIC_SENTRY_RELEASE` mismo valor

### Webhook auth (NUEVO)
- [ ] `ALLOW_WEBHOOK_WITHOUT_TOKEN` → **NO setear** (o `"false"`). Solo dev.

### Frontend Next
- [ ] `NEXT_PUBLIC_API_URL=https://<dominio-backend>`

**Verificación:** correr `docker compose -f docker-compose.prod.yml --env-file .env.production config` — no debe tirar warnings de env faltantes.

## Bloque 2 · Migración de DB (10 min)

Con Postgres corriendo:

```bash
# En el server, o localmente apuntando a la DB prod:
cd /path/to/showly
pnpm --filter @showly/backend prisma migrate deploy
```

Verificar que aplica las 2 migrations nuevas del sprint:
- `20260814231620_saas_admin` (ADR 0014, ya existía)
- `20260815003545_invitations` (ya existía)
- `20260818130000_admin_audit_impersonation` (ADR 0016, NUEVA del sprint)

**Rollback:** las migraciones son additive-only (agregar columnas + enum values + indexes). Si algo sale mal, no borra data. `DROP COLUMN` manual si necesario.

## Bloque 3 · Build + Deploy (20 min)

```bash
# Setear release tag para Sentry
export SENTRY_RELEASE="git-$(git rev-parse --short HEAD)"
export NEXT_PUBLIC_SENTRY_RELEASE="$SENTRY_RELEASE"

# Build + Up
docker compose -f docker-compose.prod.yml --env-file .env.production up -d --build

# Verificar containers up
docker compose -f docker-compose.prod.yml ps
```

**Expected:** los 5 containers `db`, `redis`, `waha`, `backend`, `web`, `caddy` en `Up (healthy)`. El backend puede tardar 60s en pasar a healthy (start_period).

**Si algún container queda `Up (unhealthy)`:**
- Backend unhealthy → `docker logs showly-backend-1 --tail 100` — buscar el `Error: Faltan env vars` o similar
- Web unhealthy → `docker logs showly-web-1 --tail 100` — probablemente falta `NEXT_PUBLIC_*` en build.args
- WAHA unhealthy → puede tardar el primer arranque (descarga Chromium). Esperar 2 min y re-check

## Bloque 4 · Smoke tests post-deploy (15 min)

Ejecutar EN ORDEN, cada uno debe pasar antes del siguiente:

### 4.1 · Health endpoints
```bash
# Backend liveness (debe devolver {ok: true} instantáneo)
curl -s https://<dominio-backend>/api/health/live | jq

# Backend full (debe devolver ok:true + db+redis+waha:true + latencyMs)
curl -s https://<dominio-backend>/api/health | jq

# Web (debe devolver ok:true + timestamp + buildId)
curl -s https://<dominio-panel>/api/health | jq
```

### 4.2 · Auth + panel
```bash
# Login con user admin creado (seed o manual)
curl -s -X POST https://<dominio-backend>/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"tu@email.com","password":"tu-pass"}'
```
Debe devolver `{accessToken: "..."}`. Guardar el token para próximos pasos.

### 4.3 · Observability funciona
- **Axiom:** abrir dashboard → dataset `showly-prod` → filtro `service:"showly-backend"` → deberías ver logs de los 3 curl anteriores en <30s
- **Sentry:** abrir proyecto `showly-backend` → forzar un error temporal con endpoint dummy o esperar que aparezca alguno natural
- **BetterStack:** los 3 monitors deberían estar en verde (up)

### 4.4 · Webhook auth funciona
```bash
# Sin token/HMAC → debe rechazar 403
curl -X POST https://<dominio-backend>/webhooks/waha \
  -H "Content-Type: application/json" \
  -d '{"event":"message"}'
# Expected: 403 Forbidden

# Con token válido → debe aceptar 200
curl -X POST https://<dominio-backend>/webhooks/waha \
  -H "Content-Type: application/json" \
  -H "x-webhook-token: <TU-WEBHOOK-TOKEN>" \
  -d '{"event":"message","session":"nonexistent"}'
# Expected: 200 (session unknown pero auth OK)
```

## Bloque 5 · Alertas activas (5 min)

- [ ] BetterStack: los 3 monitors en verde con notificación email OK
- [ ] Sentry: alerta por email al primer error 500 (test con endpoint dummy → borrar)
- [ ] Axiom: opcional, crear alert "backend service down" basado en log rate

## Bloque 6 · Canary 1-2 clínicas (48h)

**NO abrir a las 40 clínicas todavía.**

- [ ] Elegir 1-2 clínicas "amigables" (personas que puedan avisar rápido si algo falla)
- [ ] Onboardearlas manualmente vía admin panel: crear clínica → invitar admin → escanear QR de WhatsApp
- [ ] Durante las próximas **48h monitorear**:
  - Sentry: cero errores 500 no-esperados
  - Axiom: latencias P95 <500ms para endpoints del panel
  - BetterStack: uptime 100%
  - Feedback directo de la clínica sobre UX / bugs

## Bloque 7 · Go / no-go para las 40

Después de 48h de canary limpio:

**GO ✅** → abrir onboarding para los 38 restantes en tandas de 10 por día
**NO-GO ❌** → identificar bugs bloqueantes, fix, redeploy, extender canary

## Rollback plan

Si algo explota post-deploy:

### Rollback rápido (5 min)
```bash
# Ir al commit anterior estable
git checkout <sha-anterior>
export SENTRY_RELEASE="git-$(git rev-parse --short HEAD)"
docker compose -f docker-compose.prod.yml --env-file .env.production up -d --build
```

### Rollback de DB (destructivo, evitar)
Las migrations del sprint son additive. Si necesitás rollback destructivo:
```sql
ALTER TABLE "AdminAudit" DROP COLUMN "impersonatedBy";
DROP INDEX "AdminAudit_impersonatedBy_createdAt_idx";
-- IMPERSONATED_WRITE enum value NO se puede eliminar (Postgres limitation)
```

## Contactos de emergencia

- Sentry alerts → tu email principal
- BetterStack alerts → tu email + Slack/Telegram si configurado
- Axiom → dashboard manual (no alerts críticas por default)

## Próximas iteraciones (post-piloto)

Ver deuda documentada en:
- [[adr/0017-webhook-hmac-cookie-hardening]] §deuda-post-piloto — migración a cookies HttpOnly (2-3 días)
- [[adr/0015-pino-axiom-sentry]] §deuda — evaluar migración a Loki self-hosted si Axiom quota se hace cara
- [[notas/2026-08-19-observabilidad-implementada]] §próximo-paso — expansion del `AdminAudit` con `metadata.body` sanitizado si compliance lo pide
