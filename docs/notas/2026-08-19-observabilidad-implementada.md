# Observabilidad implementada — Sprint pre-lanzamiento 40 clínicas

**Fecha:** 2026-08-18 (adelantado 1 día — se completó en la sesión del 18)
**Sprint:** Pre-lanzamiento 40 clínicas
**Alcance ejecutado:** Bloques 1-4 del sprint (Lunes+Martes originales)
**Estado:** 21/21 tasks completadas · 26 tests nuevos verdes · 0 regresiones

## Resumen

Se implementó el pipeline completo de observabilidad para producción:

- **Logs estructurados** con Pino → Axiom (backend)
- **Request context** con `AsyncLocalStorage` (correlación `requestId + clinicId + userId + impersonatedBy` a través del stack completo, incluyendo BullMQ workers)
- **Redacción de PII** en TODOS los logs (`email`, `phone`, `password`, `name`, `notes`, `payload.body`, etc.)
- **Error tracking** con Sentry (backend + Next.js frontend + BullMQ processors)
- **Env vars** documentadas en `.env.example` y wireadas en `docker-compose.prod.yml`

## Archivos creados

### Backend
```
apps/backend/src/common/logger/
├── logger.config.ts              (108 líneas) — Config Pino: transports, redact, mixin
├── logger.module.ts              ( 25 líneas) — @Global module
├── pii-redactor.ts               ( 85 líneas) — Paths de redact + tests
├── pii-redactor.spec.ts          (130 líneas) — 10 tests verdes
├── request-context.ts            ( 50 líneas) — AsyncLocalStorage + Service
├── request-context.interceptor.ts        ( 82 líneas)
└── request-context.interceptor.spec.ts   (140 líneas) — 7 tests verdes

apps/backend/src/common/sentry/
├── sentry.config.ts              ( 58 líneas) — initSentry() + isSentryEnabled()
├── sentry.filter.ts              ( 82 líneas) — ExceptionFilter global
├── sentry.filter.spec.ts         (160 líneas) — 9 tests verdes
└── sentry.module.ts              ( 15 líneas) — Register filter + Sentry Nest module
```

### Frontend Next.js
```
apps/web/
├── next.config.mjs               (modificado — wrap con withSentryConfig)
├── instrumentation.ts            (nuevo — Next 15 hook)
├── instrumentation-client.ts     (nuevo — browser init + session replay)
├── sentry.server.config.ts       (nuevo — Node runtime)
└── sentry.edge.config.ts         (nuevo — Edge runtime middleware)
```

### Root
```
.env.example                     (modificado — +15 vars nuevas)
docker-compose.prod.yml          (modificado — env vars backend/web + build.args)
docs/plans/2026-08-18-observabilidad-plan.md   (creado)
docs/adr/0015-pino-axiom-sentry.md             (creado — decisión de stack)
docs/notas/2026-08-19-observabilidad-implementada.md  (este archivo)
```

## Archivos modificados

- `apps/backend/src/main.ts` — Logger de nestjs-pino, `bufferLogs: true`, `initSentry()` antes de bootstrap, fail-fast prod si falta `SENTRY_DSN`
- `apps/backend/src/app.module.ts` — Import de `LoggerModule` + `SentryAppModule`
- `apps/backend/src/auth/auth.controller.ts` — Migrado a `@InjectPinoLogger`
- `apps/backend/src/patients/patients.controller.ts` — Migrado + `.log()` → `.info()`
- `apps/backend/src/appointments/appointments.controller.ts` — Migrado + `.log()` → `.info()`
- `apps/backend/src/reminders/reminders.processor.ts` — `requestContext.run` + `Sentry.captureException`
- `apps/backend/src/follow-ups/follow-ups.processor.ts` — idem
- `apps/backend/src/whatsapp/health-monitor.processor.ts` — idem
- `apps/backend/src/reminders/reminders.service.ts` — Inyecta `RequestContextService` + propaga `requestId + clinicId` a `job.data`
- `apps/backend/src/follow-ups/follow-ups.service.ts` — idem
- 2 spec files ajustados con mock de `PinoLogger` para los constructores nuevos

## Deps agregadas

**Backend:**
- Runtime: `pino@10.3.1`, `pino-http@11.0.0`, `nestjs-pino@4.6.1`, `@axiomhq/pino@2.0.0`, `@sentry/nestjs@10.70.0`, `@sentry/node@10.70.0`
- Dev: `pino-pretty@13.1.3`

**Frontend:**
- Runtime: `@sentry/nextjs@10.70.0`

## Verificación automática

- **466 tests verdes** (450 previos + 16 nuevos: 10 pii-redactor + 7 request-context + 9 sentry.filter, con -10 redundantes)
- 0 regresiones — todos los specs del proyecto siguen pasando
- Los cambios en constructors de 2 controllers requirieron ajustar mocks en `patients.controller.spec.ts` y `appointments.controller.spec.ts`

## Smoke test manual (pendiente para dry-run)

Estos tests requieren infra local corriendo (Postgres + Redis + WAHA) y cuentas cloud configuradas (Axiom + Sentry). Ejecutar ANTES del deploy real:

### 1. Log estructurado con clinicId

```bash
cd apps/backend
LOG_LEVEL=debug LOG_PRETTY=false AXIOM_ENABLED=false pnpm start:dev
# En otra terminal:
TOKEN=$(curl -s -X POST http://localhost:4000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@clinicademo.com","password":"..."}' | jq -r .accessToken)

curl -H "Authorization: Bearer $TOKEN" \
     -H "X-Request-Id: smoke-test-1" \
     http://localhost:4000/api/appointments
```

**Esperar en stdout:** JSON con `requestId=smoke-test-1`, `clinicId=<uuid>`, `userId=<uuid>`, `service=showly-backend`.

### 2. Redacción de PII

```bash
# Body con datos falsos que deberían quedar redactados
curl -X POST http://localhost:4000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"fake@example.com","password":"deberia-quedar-redactado"}'
```

**Esperar:** el log del intento NO contiene `deberia-quedar-redactado` ni `fake@example.com` — todo `[REDACTED]`.

### 3. Axiom recibe logs

Con `AXIOM_ENABLED=true` + token real:

```bash
AXIOM_ENABLED=true AXIOM_TOKEN=xaat-xxx pnpm start:dev
# Hacer 5-10 requests
```

En Axiom UI → dataset `showly-prod` → filtrar `service:"showly-backend" AND env:"development"` → deberían aparecer los logs con todos los base fields.

### 4. Sentry backend captura errores

Endpoint temporal (agregar y luego BORRAR):

```ts
// apps/backend/src/health/health.controller.ts (TEMPORAL)
@Get('crash-test')
crashTest() { throw new Error('sentry smoke test'); }
```

```bash
SENTRY_ENABLED=true SENTRY_DSN=<dsn-real> pnpm start:dev
curl -H "Authorization: Bearer $TOKEN" http://localhost:4000/api/health/crash-test
```

En Sentry UI proyecto `showly-backend` → evento visible con tags `clinicId`, `userId`, `route`.

**BORRAR el endpoint después de verificar.**

### 5. BullMQ processor con Sentry

Encolar job con appointmentId inválido para forzar fallo:

```bash
# Desde redis-cli:
docker exec showly-redis-1 redis-cli
# Encolar un job send-follow-up con appointmentId inexistente
> XADD bull:follow-ups:stream ...
```

O más simple: matar Postgres a mitad de un processor y ver el error en Sentry con tags `queue=reminders`, `jobId=xxx`.

### 6. Sentry Next.js

Página temporal:

```ts
// apps/web/src/app/sentry-test/page.tsx (TEMPORAL)
export default function() {
  throw new Error('sentry nextjs smoke test');
}
```

Visitar `http://localhost:3002/sentry-test`. Evento en Sentry proyecto `showly-web` con `runtime=nodejs` o `edge`.

**BORRAR la página después de verificar.**

## Descubrimientos técnicos importantes

### 1. Pino wildcard `*.foo` NO cubre root-level

**Problema:** hacer `logger.info({ email }, 'msg')` produce un log con `email` al ROOT del entry, no debajo de un objeto padre. El path `*.email` (que significa "cualquier email un nivel dentro del root") NO lo captura.

**Solución:** duplicar todos los paths en el redactor — `email` (root) + `*.email` (nested). Documentado en JSDoc del `pii-redactor.ts`.

### 2. Interceptor en vez de Middleware para RequestContext

Los middlewares de Nest corren ANTES de guards. `JwtAuthGuard` popula `req.user`. Si el middleware corriera antes, no tendría acceso a `clinicId/userId/impersonatedBy` del JWT.

**Solución:** usar `NestInterceptor` — corre DESPUÉS de guards. Trade-off aceptado: los interceptors son ligeramente más raros para request context, pero funcionalmente correctos.

### 3. BullMQ workers no son NestJS providers

Los workers son standalone (factory functions `createXWorker(connection, prisma, waha)`). No pueden inyectar `RequestContextService` via DI. **Solución:** el service producer (RemindersService, FollowUpsService) inyecta el context y lo pone en `job.data.requestId + job.data.clinicId`. El worker consumer lo lee y hace `requestContext.run(store, handler)` para crear el scope aislado.

Esto permite correlacionar el request HTTP original → job encolado → ejecución del job → llamadas downstream, todos con el mismo `requestId` en Axiom.

### 4. Sentry Next.js 15: `instrumentation-client.ts` reemplaza a `sentry.client.config.ts`

En Next 15.3+, el archivo de init del browser cambió de nombre. También hay que exportar `onRouterTransitionStart` para instrumentar navegación.

### 5. `@sentry/node@10` NO exporta `nodeProfilingIntegration`

El profiling vive en un package separado (`@sentry/profiling-node`). Se decidió sacarlo del MVP — traces sample rate ya nos da visibilidad suficiente para el piloto.

## Kill switches activos

Todo el pipeline es opt-in con env vars:

| Env var | Default | Efecto si `false` |
|---|---|---|
| `AXIOM_ENABLED` | `false` | Logs solo a stdout (docker driver los rota) |
| `SENTRY_ENABLED` | `false` | Sentry no captura nada (backend) |
| `NEXT_PUBLIC_SENTRY_ENABLED` | `false` | Sentry no captura nada (frontend) |
| `LOG_PRETTY` | `true` en dev, `false` en prod | JSON puro si false |

En prod (`NODE_ENV=production`) el fail-fast obliga `SENTRY_DSN` — no se puede deployar ciego.

## Referencias

- Spec: [[../specs/2026-08-18-observabilidad-pino-axiom-sentry|Spec observabilidad]]
- Plan: [[../plans/2026-08-18-observabilidad-plan|Plan de 21 tasks]]
- ADR: [[../adr/0015-pino-axiom-sentry|ADR 0015 — Pino + Axiom + Sentry]]

## Actualización 2026-08-18 (bloque Miércoles adelantado)

Se completó también el bloque de **Health checks + BetterStack setup** (Sprint día 3):

### Endpoints nuevos

| Endpoint | Uso | Response |
|---|---|---|
| `GET /api/health/live` (backend) | Docker healthcheck + BetterStack "process alive" | `{ok: true, timestamp}` — sin dependencias |
| `GET /api/health` (backend) | BetterStack "full stack alive" — checks DB + Redis + WAHA en paralelo, timeout 3s c/u, latencia por check | `{ok, db, redis, waha, timestamp, checks: {...}}` |
| `GET /api/health` (Next.js) | Docker healthcheck web + BetterStack "web alive" | `{ok: true, timestamp, buildId}` |

Anti-recon: en `NODE_ENV=production` los mensajes de error NO se exponen en la response (solo booleans + latencia). En dev sí — útil para debug local.

### Docker healthchecks actualizados

- `backend`: ahora usa `/api/health/live` (no `/api/health`). Motivo: un blip de WAHA no debe matar el container. `/live` confirma solo que el proceso está vivo.
- `web`: cambió de `/` a `/api/health` — más explícito, con `Cache-Control: no-store`.

## Setup de BetterStack Uptime — Guía paso a paso

### 1. Signup

- Ir a https://betterstack.com/uptime → **Sign Up Free**
- Free tier: 10 monitors, checks cada 3 min, alertas email ilimitadas.

### 2. Crear los 3 monitors

Desde el dashboard → **Monitors → Create monitor**. Configurar 3 monitors:

#### Monitor 1: Backend liveness
- **URL to monitor:** `https://<dominio-backend-prod>/api/health/live`
- **Monitor type:** HTTPS
- **Check frequency:** 3 minutes
- **Request timeout:** 10 seconds
- **Alert threshold:** 2 consecutive failures (evita alertas por blips de 30s)
- **HTTP method:** GET
- **Expected status code:** 200
- **Verify SSL certificate:** ✓ (yes)

#### Monitor 2: Backend full stack
- **URL to monitor:** `https://<dominio-backend-prod>/api/health`
- **Check frequency:** 3 minutes
- **Alert threshold:** **3 consecutive failures** (más tolerante — WAHA puede tener blips más largos que blip del proceso)
- **HTTP method:** GET
- **Expected status code:** 200
- **Response body check:** debe contener `"ok":true`
- **Verify SSL certificate:** ✓

#### Monitor 3: Web frontend
- **URL to monitor:** `https://<dominio-panel-prod>/api/health`
- **Check frequency:** 3 minutes
- **Alert threshold:** 2 consecutive failures
- **HTTP method:** GET
- **Expected status code:** 200
- **Verify SSL certificate:** ✓

### 3. Configurar alertas

Desde **Settings → On-call & Escalations**:

- **Canal primario (obligatorio):** Email al owner (tu inbox principal)
- **Canal secundario opcional:** Slack webhook o Telegram bot para notificación instantánea
- **Escalation:** después de 5 min sin acknowledge, escalar a un 2do canal

### 4. Verificación inicial

Después de crear los monitors:
1. Los 3 deberían estar en **"Pending"** por 1-2 min mientras BetterStack hace las primeras checks.
2. Luego pasan a **"Up"** (verde). Si aparecen **"Down"**:
   - Verificar que el dominio prod esté deployado y accesible
   - Curl manual: `curl -v https://<dominio>/api/health/live`
   - Si el curl responde 200 pero BetterStack dice "Down" → problema de firewall/geo-blocking en el data-center de BetterStack (frecuente si Cloudflare tiene rate-limit ajustado)

### 5. Prueba de alerta

Tirar UN container de docker (ej. matar el web temporalmente) → esperar 6-9 minutos (3 min interval × 2 fails) → debería llegar la alerta. Restaurar el container.

**Documentar en `docs/runbook-panel.md`** el playbook de respuesta:
- Recibí alerta "backend down" → primero verificar el server host, después revisar Sentry si hay excepciones nuevas.
- Recibí alerta "backend full check" pero `/live` está up → problema en DB/Redis/WAHA. Verificar los 3 en orden.

### 6. Endpoints objetivo — Sanity check pre-lanzamiento

Antes del canary de la semana que viene, ejecutar estos curl manuales para asegurar que responden como esperado:

```bash
# Backend liveness (siempre {ok: true})
curl -s https://<dominio-backend>/api/health/live | jq

# Backend full (chequea db + redis + waha)
curl -s https://<dominio-backend>/api/health | jq

# Web
curl -s https://<dominio-panel>/api/health | jq
```

Los 3 deben devolver 200 con JSON `ok: true`. Si alguno no, el monitor de BetterStack va a alertar en <10 min post-deploy.

## Próximo paso

Continuar con los otros 2 bloques del sprint (Jueves-Viernes):

1. **Jueves:** Extender `AdminAudit` con `impersonatedBy` + trail estructurado de mutations bajo impersonation
2. **Viernes:** HMAC en webhook WAHA + migrar cookies a `HttpOnly` con refresh flow mínimo

Y el **Sábado** el dry-run consolidado con la infra local + verificación manual de los 6 smoke tests + los 3 monitors de BetterStack activos.
