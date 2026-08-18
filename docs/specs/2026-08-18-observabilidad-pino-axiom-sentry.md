# Spec — Observabilidad estructurada (Sprint pre-lanzamiento 40 clínicas)

**Fecha:** 2026-08-18
**Autor:** Héctor / Claude
**Sprint:** Pre-lanzamiento piloto 40 clínicas
**Alcance:** Días 1-2 del sprint (Lunes + Martes)
**Estado:** Draft — pendiente de confirmación

## Asunciones (confirmadas 2026-08-18)

1. Full-time del dev durante 2 días (16h efectivas).
2. Cuentas cloud ya abiertas por el usuario:
   - Axiom: dataset `showly-prod` (único), token en `.env`.
   - Sentry: proyecto Node.js `showly-backend`, proyecto Next.js `showly-web`, DSN en `.env`.
3. Deploy target: `docker-compose.prod.yml` existente detrás de Caddy en VPS de producción.
4. **NO hay VPS de staging** — la validación pre-deploy se hace localmente con `docker-compose.prod.yml` + `.env.production` (sandbox) y con dataset `showly-prod` de Axiom filtrado por tag `env=development`.
5. Environments soportados: `production`, `development`, `test`.
6. Log level default: `info` en prod, `debug` en dev, `silent` en test.
7. Sentry sample rate: `1.0` de errors, `0.1` de traces (piloto de bajo volumen).
8. PII a redactar: `email`, `phone`, `password`, `token`, `secret`, `authorization`, `cookie`, `name`, `firstName`, `lastName`, `notes`, `reason`, `body` (del mensaje de WhatsApp).

Si algo de esto no coincide, avisar antes de codear.

---

## 1. Objetivo

Instrumentar Showly con logs estructurados (Pino → Axiom) y error tracking (Sentry) antes del piloto con 40 clínicas, para poder:

1. **Diagnosticar por clínica:** filtrar cualquier log por `clinicId` en <10 s desde la UI de Axiom.
2. **Correlacionar request:** trazar un request de web → backend → BullMQ processor por un `requestId` único.
3. **No filtrar PII:** ningún campo sensible de paciente aparece en los logs enviados a Axiom.
4. **Alertar en tiempo real:** cualquier `500`, exception no manejada, o job de BullMQ que falle, dispara notificación en Sentry en <1 min.

**Non-goals (otros specs del sprint):**
- Health check endpoints (Miércoles — spec propio).
- Extender `AdminAudit` con `impersonatedBy` (Jueves — spec propio).
- HMAC en webhook WAHA (Viernes — spec propio).
- Migración de cookies a `HttpOnly` (Viernes — spec propio).
- Grafana Loki self-hosted (post-piloto).
- APM/tracing distribuido completo (post-piloto).

---

## 2. Acceptance criteria (Gherkin)

### AC-1: Log estructurado con clinicId
```gherkin
Scenario: request autenticado deja log con clinicId
  Given un usuario CLINIC_ADMIN de la clínica "acme" logueado
  When hace GET /api/appointments
  Then Axiom recibe un log JSON con campos:
    | level     | "info"                    |
    | msg       | "GET /api/appointments"   |
    | clinicId  | <uuid de acme>            |
    | userId    | <uuid del user>           |
    | requestId | <uuid único del request>  |
    | route     | "/api/appointments"       |
    | method    | "GET"                     |
    | status    | 200                       |
    | latencyMs | <número>                  |
```

### AC-2: Correlation ID propagado
```gherkin
Scenario: correlation ID atraviesa web → backend → job
  Given un request POST /api/appointments desde el panel
  And el backend encola un job de recordatorio
  When el processor de BullMQ ejecuta ese job
  Then todos los logs del web-request, el backend-request y el job-processor
    comparten el mismo requestId
```

### AC-3: PII redactada
```gherkin
Scenario: log de paciente NO expone datos sensibles
  Given un endpoint POST /api/patients con body { name: "Juan Pérez", phone: "+54911..." }
  When el request es procesado
  Then el log en Axiom contiene body.name = "[REDACTED]"
  And el log en Axiom contiene body.phone = "[REDACTED]"
  And el log NO contiene los valores reales
```

### AC-4: Error no manejado en Sentry
```gherkin
Scenario: exception en un endpoint aparece en Sentry
  Given un endpoint que hace throw new Error("boom")
  When un usuario dispara ese endpoint
  Then Sentry captura el error con tags:
    | environment    | "production"     |
    | clinicId       | <uuid>           |
    | userId         | <uuid>           |
    | impersonatedBy | <uuid o null>    |
    | route          | "/api/whatever"  |
  And el response al cliente NO expone el stack trace
```

### AC-5: Job de BullMQ que falla
```gherkin
Scenario: job de recordatorio que falla se captura
  Given un job de send-reminder en la queue reminders
  And el job lanza una excepción durante el processor
  Then Sentry captura el error con tags:
    | queue    | "reminders"     |
    | jobId    | <id>            |
    | attempt  | <número>        |
    | clinicId | <uuid>          |
  And el job se marca como failed en BullMQ (retry policy respetada)
```

---

## 3. Estructura del proyecto (archivos nuevos/modificados)

### Backend (`apps/backend/`)

**Nuevos:**
```
src/
├── common/
│   ├── logger/
│   │   ├── logger.module.ts          # Módulo global que exporta Pino configurado
│   │   ├── logger.config.ts          # Config de Pino: transports, redact, formatters
│   │   ├── request-context.ts        # AsyncLocalStorage con {requestId, clinicId, userId, impersonatedBy}
│   │   ├── request-context.middleware.ts  # Middleware que setea el context por request
│   │   ├── pii-redactor.ts           # Whitelist de campos y helper redact()
│   │   └── logger.module.spec.ts
│   └── sentry/
│       ├── sentry.module.ts          # Init de Sentry en boot
│       ├── sentry.config.ts          # DSN, environment, release, sample rates
│       ├── sentry.filter.ts          # ExceptionFilter que reporta a Sentry con tags
│       └── sentry.filter.spec.ts
```

**Modificados:**
```
src/
├── main.ts                       # Usar Pino como Logger, init Sentry temprano
├── app.module.ts                 # Registrar LoggerModule global + APP_FILTER Sentry
├── follow-ups/follow-ups.processor.ts  # Inyectar Sentry en catch de processor
├── bot/bot.service.ts            # Reemplazar Logger de Nest por Pino inyectado
└── whatsapp/webhook.controller.ts # idem
```

### Web (`apps/web/`)

**Nuevos:**
```
src/
├── lib/sentry/
│   ├── sentry.client.config.ts    # Client-side init
│   ├── sentry.server.config.ts    # Server-side init
│   └── sentry.edge.config.ts      # Edge-runtime init (middleware)
```

**Modificados:**
```
next.config.mjs                # Wrap con withSentryConfig
instrumentation.ts             # Init Sentry (Next 15 pattern)
src/app/[locale]/layout.tsx    # Propagar requestId como header a llamadas fetch
src/lib/api.ts                 # Injectar x-request-id desde crypto.randomUUID() en cada fetch
```

### Root

**Modificados:**
```
.env.example
docker-compose.prod.yml
apps/backend/package.json    # +pino, +nestjs-pino, +@axiomhq/pino, +@sentry/nestjs, +@sentry/node
apps/web/package.json        # +@sentry/nextjs
```

---

## 4. Contratos técnicos

### 4.1 Log schema (backend → Axiom)

Todo log del backend cumple:

```ts
type LogEntry = {
  level: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';
  time: number;              // epoch ms
  msg: string;
  service: 'showly-backend';
  env: 'production' | 'staging' | 'development';

  // Request context (opcional — presente si hay request activo)
  requestId?: string;        // uuid v4
  clinicId?: string;         // uuid
  userId?: string;           // uuid
  impersonatedBy?: string;   // uuid — presente solo si el JWT es de impersonation

  // Request metadata (solo en logs de request completion)
  route?: string;
  method?: string;
  status?: number;
  latencyMs?: number;

  // Job metadata (solo en logs de BullMQ)
  queue?: string;
  jobId?: string;
  attempt?: number;

  // Error metadata (solo en logs de error)
  err?: {
    type: string;
    message: string;
    stack: string;            // presente solo en dev/staging, redactado en prod
  };
};
```

### 4.2 Correlation ID

- Header estándar: `x-request-id`
- Generación: si el request llega SIN header, el middleware genera un `crypto.randomUUID()`.
- Propagación: el `WahaService`, `MailService`, `FollowUpsService`, y cualquier queue producer inyecta el `requestId` en el `job.data.requestId` o en los headers del outbound HTTP.
- Consumo en processors: el processor lee `job.data.requestId` y lo carga al `AsyncLocalStorage` antes de ejecutar.

### 4.3 PII redaction (Pino redact)

Path expressions para `pino.redact`:

```ts
[
  // Request
  'req.headers.authorization',
  'req.headers.cookie',
  'req.body.password',
  'req.body.token',
  'req.body.currentPassword',
  'req.body.newPassword',

  // Response — solo redactamos si accidentalmente logueamos el body
  'res.body.token',
  'res.body.password',

  // Common object shapes (usar wildcard con precaución — pino soporta '*.password')
  '*.password',
  '*.token',
  '*.secret',
  '*.apiKey',
  '*.authorization',

  // PII de paciente
  '*.email',
  '*.phone',
  '*.name',
  '*.firstName',
  '*.lastName',
  '*.notes',
  '*.reason',

  // WhatsApp body del mensaje
  '*.messageBody',
  'payload.body',
]
```

Reemplazo: `'[REDACTED]'`.

**Nota:** los IDs (`patientId`, `appointmentId`, etc.) NO se redactan — son necesarios para diagnosticar.

### 4.4 Sentry tags contract

Todo evento en Sentry lleva:

```ts
{
  environment: string;      // 'production' | 'staging'
  release: string;          // git sha corto o package.json version
  tags: {
    clinicId?: string;
    userId?: string;
    impersonatedBy?: string;
    route?: string;         // solo en errors de request
    queue?: string;         // solo en errors de job
  };
  user: {                   // Sentry user context
    id?: string;            // userId
    ip_address?: string;
  };
  extra: {                  // datos adicionales, no indexed
    requestId?: string;
    jobId?: string;
    attempt?: number;
  };
}
```

---

## 5. Env vars nuevas

```bash
# .env.example — agregar
# --- Observability ---

# Axiom (dataset único showly-prod, environment se distingue por el tag env=... en cada log)
AXIOM_DATASET_LOGS=showly-prod
AXIOM_TOKEN=xaat-xxx                                    # ingest token
AXIOM_ORG_ID=showly                                     # slug de la org
AXIOM_ENABLED=true                                      # false en local dev por default (evita ruido)

# Sentry (backend)
SENTRY_DSN=https://xxx@sentry.io/xxx
SENTRY_ENVIRONMENT=production                            # production | development
SENTRY_RELEASE=                                          # inyectado por CI (git sha corto)
SENTRY_TRACES_SAMPLE_RATE=0.1                           # 10% de traces
SENTRY_ENABLED=true

# Sentry (frontend Next)
NEXT_PUBLIC_SENTRY_DSN=https://xxx@sentry.io/xxx        # público, DSN es no-secret
NEXT_PUBLIC_SENTRY_ENVIRONMENT=production
SENTRY_AUTH_TOKEN=                                       # solo build-time, para sourcemap upload

# Logger
LOG_LEVEL=info                                           # trace|debug|info|warn|error|fatal|silent
LOG_PRETTY=false                                         # true solo en dev local
```

En `docker-compose.prod.yml` estas van a la sección `environment` del backend + web (excepto `SENTRY_AUTH_TOKEN` que va solo al `build.args`).

---

## 6. Convenciones de código

### 6.1 Uso del Logger

**PERMITIDO:**
```ts
// En un service o controller:
constructor(@InjectPinoLogger(MyService.name) private readonly logger: PinoLogger) {}

this.logger.info({ patientId, action: 'create' }, 'patient created');
this.logger.warn({ retries: 3, err }, 'waha send failed, retrying');
```

**PROHIBIDO:**
```ts
// NO usar console.log/error/warn — bypasea Pino y Axiom
console.log('foo');

// NO instanciar Logger de @nestjs/common — no tiene structured fields
private logger = new Logger(MyService.name);

// NO loguear objetos sin destructurar campos sensibles
this.logger.info({ patient }, 'created');  // ❌ mete todo el objeto
this.logger.info({ patientId: patient.id }, 'created');  // ✅ solo el ID
```

### 6.2 Request context

**PERMITIDO en cualquier service:**
```ts
constructor(private readonly ctx: RequestContextService) {}

const clinicId = this.ctx.get('clinicId');
const requestId = this.ctx.get('requestId');
```

**No** pasar `clinicId` como parámetro solo para logging — usar el context.

### 6.3 Sentry manual capture

Reservado para casos donde el catch NO relanza:

```ts
try {
  await this.riskyOperation();
} catch (err) {
  Sentry.captureException(err, { tags: { operation: 'risky' } });
  // fallback silencioso
  return defaultValue;
}
```

Para errores que se relanzan (llegan al ExceptionFilter global), NO capturar manualmente — el filter lo hace.

---

## 7. Testing strategy

### 7.1 Unit tests (`pnpm --filter @showly/backend test`)

**Nuevos specs a crear:**
- `pii-redactor.spec.ts` — casos: objeto plano, nested, arrays, campos que NO se redactan.
- `request-context.middleware.spec.ts` — un request con y sin `x-request-id`, propagación al AsyncLocalStorage.
- `sentry.filter.spec.ts` — mock de Sentry.captureException, verificar tags correctos.
- `logger.module.spec.ts` — smoke test de que Pino se instancia con redact + level correctos.

**Regression tests existentes que NO deben romperse:**
- Todos los `*.spec.ts` que hacen assertions sobre `logger.log` de NestJS necesitan actualizarse para el nuevo Pino API.

### 7.2 Integration test manual local (Sábado — sin staging)

Checklist en `docs/notas/2026-08-23-sprint-dryrun.md` (crear al final). Todo local con `docker-compose.prod.yml` + `.env.production` sandbox:

- [ ] `pnpm dev:backend` → hacer request autenticado → verificar log estructurado en stdout.
- [ ] `docker-compose -f docker-compose.prod.yml up` local con `.env.production` sandbox → verificar que Axiom recibe logs con `env=development` (dataset compartido `showly-prod`) y filtro por `clinicId` funciona.
- [ ] Forzar `throw` en un endpoint → verificar en Sentry el evento con `environment=development` y tags correctos.
- [ ] Encolar un job → matar el processor mid-execution → verificar retry + evento en Sentry.
- [ ] Grep en logs de un request completo con `requestId=xxx` → todos los eventos (web → backend → job) aparecen.
- [ ] Simular 3 clínicas con seed data → hacer requests desde cada una → verificar en Axiom que los logs son filtrables por `clinicId` sin cruzarse.
- [ ] **Canary check pre-lanzamiento:** el domingo, con el deploy real, invitar 1-2 clínicas amigables PRIMERO y verificar 24h de logs limpios antes de abrir a los 40.

### 7.3 Perf sanity check

- El overhead de Pino sobre NestJS Logger debe ser <5% en un endpoint típico (medido con `autocannon` en el `/api/health` — creado el miércoles).
- El envío a Axiom es async (transport worker thread), NO debe bloquear el request path.

---

## 8. Boundaries — qué SÍ, qué preguntar, qué NO

### SIEMPRE

- Usar `PinoLogger` inyectado. No `console.*`, no `Logger` de NestJS.
- Redactar cualquier campo nuevo que contenga PII, agregando al array de `redact` paths.
- Propagar `requestId` en todo call outbound (fetch, BullMQ, mail).
- Testear con `expect().toHaveBeenCalledWith(objectContaining({ clinicId }))` para verificar log structure.

### PREGUNTAR ANTES

- Cambiar el sample rate de Sentry en producción (afecta costo).
- Agregar un nuevo dataset en Axiom (afecta billing).
- Enviar logs a un destino adicional (ej. Datadog, CloudWatch) — decisión de arquitectura.
- Cambiar el retention policy de Axiom (free tier = 30 días, cambiar requiere plan pago).
- Migrar de Sentry SaaS a Sentry self-hosted.

### NUNCA

- Loguear passwords, tokens, JWTs, cookies, o body de mensajes de WhatsApp en claro.
- Enviar `SENTRY_AUTH_TOKEN` al frontend (solo build-time).
- Hacer `Sentry.captureException` dentro de un catch que relanza (doble captura).
- Bloquear el request path esperando confirmación de Axiom (siempre async).
- Loguear el objeto `patient` o `user` completos — solo los IDs.
- Deployar sin `SENTRY_DSN` seteado en prod (fail-fast en `main.ts` si falta).

---

## 9. Definition of Done

Al final del martes:

- [ ] `pnpm --filter @showly/backend build` compila sin warnings.
- [ ] `pnpm --filter @showly/backend test` verde (incluidos los 4 specs nuevos).
- [ ] `pnpm --filter @showly/web build` compila.
- [ ] Un request local a `/api/appointments` genera un log JSON con los 8 campos del schema en stdout.
- [ ] Un `throw new Error('test')` en un endpoint aparece en Sentry con tags `clinicId`, `userId`, `route`.
- [ ] Un log con `req.body.password` muestra `[REDACTED]` en stdout.
- [ ] Docker-compose local con `.env.production` sandbox envía logs a Axiom (dataset `showly-prod`, tag `env=development`) y son filtrables por `clinicId`.
- [ ] Un job de `follow-ups` que falla genera un evento en Sentry con `queue=follow-ups`.
- [ ] `.env.example` actualizado con las 10 vars nuevas.
- [ ] `docker-compose.prod.yml` con las envs seteadas.
- [ ] Nota corta en `docs/notas/2026-08-19-observabilidad-implementada.md` con capturas del dashboard de Axiom + Sentry.
- [ ] ADR corto `docs/adr/0015-pino-axiom-sentry.md` con la decisión de stack.
- [ ] `docs/INDEX.md` actualizado con los links de la nota y el ADR.

---

## 10. Riesgos y kill switches

| Riesgo | Prob | Kill switch |
|---|---|---|
| `nestjs-pino` pelea con el `Logger` custom del proyecto | Alta | Timebox 3h el lunes. Si no cierra, usar `nestjs-pino` en modo default (sin custom formatters) y refactorizar el martes. |
| Redact paths de Pino no capturan un shape nested | Media | Agregar tests unitarios del redactor con casos reales (paciente, appointment, mensaje WA) antes de deployar. |
| Sentry Next.js SDK rompe con App Router 15 | Media | Backend primero (lunes). Si el martes al mediodía no anda en Next, mantener Sentry solo backend + dejar spec de frontend para el viernes. |
| Axiom cae o el token no funciona en staging | Baja | Pino sigue escribiendo a stdout como fallback. Docker retiene 7 días de logs — recuperable. |
| El overhead de Pino satura el CPU del container | Muy baja | Baseline: Pino es 5x más rápido que Winston. Si aparece, cambiar `transport` a async worker. |
| PII se filtra por un path que olvidamos | Media | Post-deploy inmediato: hacer 10 requests con datos ficticios de paciente y grep en Axiom por `+549`, `@gmail`, etc. Si aparece → rollback + agregar path. |

---

## 11. Próximo paso

Al aprobar este spec:

1. Crear cuentas en Axiom + Sentry (usuario, en paralelo).
2. Correr `/plan` sobre este spec para generar el task breakdown day-by-day.
3. Arrancar `/build` bloque por bloque, con `/test` intercalado.

## Referencias

- [[../adr/0005-auth-mvp-y-deuda|ADR 0005 — Auth MVP]] (para entender el JWT y `impersonatedBy`)
- [[../adr/0014-superadmin-como-operador-saas|ADR 0014 — SUPERADMIN operator]] (contexto del `impersonatedBy` en el JWT)
- [[../adr/0004-pii-y-compliance|ADR 0004 — PII y compliance]] (motivación de la redacción)
- Pino docs: https://getpino.io
- Axiom NestJS integration: https://axiom.co/docs/guides/pino
- Sentry NestJS: https://docs.sentry.io/platforms/javascript/guides/nestjs/
- Sentry Next.js 15: https://docs.sentry.io/platforms/javascript/guides/nextjs/
