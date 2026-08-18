# Plan de implementación — Observabilidad (Lunes + Martes)

**Fecha:** 2026-08-18
**Basado en:** [[../specs/2026-08-18-observabilidad-pino-axiom-sentry|Spec Observabilidad Pino+Axiom+Sentry]]
**Sprint:** Pre-lanzamiento 40 clínicas
**Alcance:** 2 días (16h efectivas)

## Estado del codebase (baseline verificado)

- `apps/backend/src/main.ts` usa `Logger` de `@nestjs/common` directamente. Bootstrap con `bufferLogs: false`.
- `apps/backend/src/app.module.ts` no tiene módulo de logger custom. `AuthModule` registra `JwtAuthGuard` global.
- **BullMQ workers NO son NestJS providers** — son factories (`createFollowUpsWorker(connection, prisma, waha)`) que devuelven `Worker`. Instanciadas manualmente en `main.ts`. **Implicancia:** para inyectar logger/Sentry en ellas hay que pasarlos como parámetros a la factory, no vía DI.
- Deps backend NO instaladas: `pino`, `nestjs-pino`, `pino-http`, `pino-pretty`, `@axiomhq/pino`, `@sentry/nestjs`, `@sentry/node`.
- Deps web NO instaladas: `@sentry/nextjs`.
- Carpeta `apps/backend/src/common/` existe con solo `llm/`. Vamos a agregar `common/logger/` y `common/sentry/`.
- Sentry init debe ir **antes** de `NestFactory.create()` en `main.ts` para capturar errores de bootstrap.

## Dependency graph

```
T-1.1 install deps
     │
     ├─→ T-1.2 logger.config ──┬─→ T-1.4 logger.module ──→ T-1.5 main.ts wire
     │                          │                              │
     └─→ T-1.3 pii-redactor ────┘                              ▼
                                                        T-2.1 request-context
                                                              │
                                                        T-2.2 rc.middleware
                                                              │
                                                        T-2.3 register global
                                                              │
                                                        T-2.4 integration test
                                                              │
                                                        T-2.5 migrate 3 ctrls
                                                              │
                                                        ─── CHECKPOINT 1 ───
                                                              │
                                                        T-3.1 axiom transport
                                                              │
                                                        T-3.2 verify axiom
                                                              │
                                                        T-3.3 sentry init
                                                              │
                                                        T-3.4 sentry filter
                                                              │
                                                        T-3.5 test throw→sentry
                                                              │
                                                        ─── CHECKPOINT 2 ───
                                                              │
              ┌───────────────────────────────────────────────┤
              ▼                                               ▼
        T-4.1 wrap workers                              T-4.4 install @sentry/nextjs
              │                                               │
        T-4.2 propagate requestId                       T-4.5 wire Next
              │                                               │
        T-4.3 test job fail                             T-4.6 test error → sentry
              │                                               │
              └───────────────────┬───────────────────────────┘
                                  ▼
                            T-4.7 env vars & docker-compose
                                  │
                            ─── CHECKPOINT FINAL ───
```

## Bloque 1 — Lunes AM: Fundamentos Pino (4h)

### T-1.1 · Instalar deps del backend (0.5h) · **dev principal**

Comando único:
```bash
cd apps/backend
pnpm add pino nestjs-pino pino-http @axiomhq/pino @sentry/nestjs @sentry/node
pnpm add -D pino-pretty
```

**Acceptance:** `pnpm --filter @showly/backend build` sigue verde. Versiones agregadas al `package.json`.

### T-1.2 · Crear `common/logger/logger.config.ts` (1h) · **dev principal**

Ubicación: `apps/backend/src/common/logger/logger.config.ts`

Exporta `pinoConfig()` factory que construye la config de Pino con:
- Level por env (`LOG_LEVEL`, default `info` en prod, `debug` en dev, `silent` en test)
- Transport a Axiom **solo si** `AXIOM_ENABLED === 'true'`
- Transport a `pino-pretty` **solo si** `LOG_PRETTY === 'true'` (dev local)
- Redact paths de PII (importados desde `pii-redactor.ts`)
- Base fields: `service: 'showly-backend'`, `env: NODE_ENV`
- Formatters de nivel (numérico → string)

**Acceptance:** archivo compila, exporta `pinoConfig(): PinoHttpOptions`.

### T-1.3 · Crear `common/logger/pii-redactor.ts` + test (1h) · **delegable a subagente**

Ubicación: `apps/backend/src/common/logger/pii-redactor.ts`

Exporta:
```ts
export const PII_REDACT_PATHS: string[];  // los 13 paths del spec §4.3
export const PII_REDACT_CENSOR = '[REDACTED]';
```

Test `apps/backend/src/common/logger/pii-redactor.spec.ts`:
- Objeto plano con `email` → redactado
- Nested `req.body.password` → redactado
- Array `patients[0].phone` → redactado con wildcard
- `id`, `patientId`, `clinicId` → **NO** redactados
- WhatsApp `payload.body` → redactado

**Acceptance:** test verde. `pnpm --filter @showly/backend test pii-redactor` pasa.

### T-1.4 · Crear `common/logger/logger.module.ts` (0.5h) · **dev principal**

Ubicación: `apps/backend/src/common/logger/logger.module.ts`

Wraps `LoggerModule.forRootAsync` de `nestjs-pino` con `pinoConfig()`. Exporta como módulo global.

**Acceptance:** archivo compila, `@Module` marcado con `@Global()`.

### T-1.5 · Integrar Pino en `main.ts` reemplazando Logger de Nest (1h) · **dev principal**

Modificar `apps/backend/src/main.ts`:
1. `NestFactory.create(AppModule, { bufferLogs: true })` (habilitar buffering para que Pino capture logs de bootstrap)
2. `app.useLogger(app.get(Logger))` (el `Logger` de `nestjs-pino`, no de Nest)
3. Registrar `LoggerModule` en `AppModule` (import global)
4. Reemplazar `new Logger('Bootstrap')` por logger de nestjs-pino
5. Los `logger.log('...')` mantienen la misma API — cero cambios de firma

**Acceptance manual:**
```bash
cd apps/backend && LOG_LEVEL=debug pnpm start:dev
# En otra terminal:
curl http://localhost:4000/api/health
```
Ver en stdout JSON estructurado con `level`, `time`, `msg`, `service`, `env`.

### 🚦 Checkpoint 1 — Fin Lunes AM

**Pregunta go/no-go:** ¿logs JSON estructurados en stdout con campos correctos?

- **GO:** avanzar al Bloque 2 (request context).
- **NO-GO opción A:** downgrade a `nestjs-pino` default (sin redact custom, sin transport a Axiom todavía) → seguir con Bloque 2 y volver a T-1.2/1.3 el martes.
- **NO-GO opción B:** si Pino no anda para nada → reprogramar sprint. Sentry solo (skip Axiom) el martes.

---

## Bloque 2 — Lunes PM: Request Context + Correlation ID (4h)

### T-2.1 · Crear `common/logger/request-context.ts` (1h) · **dev principal**

Ubicación: `apps/backend/src/common/logger/request-context.ts`

Exporta:
```ts
export const requestContext: AsyncLocalStorage<RequestContextData>;
export class RequestContextService {
  get<K extends keyof RequestContextData>(key: K): RequestContextData[K] | undefined;
  set<K extends keyof RequestContextData>(key: K, value: RequestContextData[K]): void;
  run<T>(data: RequestContextData, fn: () => T): T;
}
type RequestContextData = {
  requestId: string;
  clinicId?: string;
  userId?: string;
  impersonatedBy?: string;
};
```

**Acceptance:** compila, sin tests de unidad (es un wrapper de AsyncLocalStorage — trivial).

### T-2.2 · Crear `common/logger/request-context.middleware.ts` + test (1h) · **delegable a subagente**

Ubicación: `apps/backend/src/common/logger/request-context.middleware.ts`

Middleware que:
1. Lee `x-request-id` del header; si no viene, genera `crypto.randomUUID()`.
2. Extrae `clinicId`, `userId`, `impersonatedBy` del JWT decoded (si el request está autenticado — leer de `req.user` después del JwtAuthGuard). **Nota:** el middleware corre ANTES del guard, así que el JWT no está decoded todavía. Solución: usar un `Interceptor` en vez de middleware para acceder a `req.user`, o parsear el JWT manualmente sin verificar firma en el middleware (solo para logging — la firma sí se verifica en el guard).
3. Envuelve el resto del request con `requestContext.run({requestId, clinicId, userId, impersonatedBy}, next)`.

**Decisión de implementación:** usar **`NestInterceptor`** (no middleware) porque necesitamos leer `req.user` después del JwtAuthGuard. El interceptor corre después de guards. Trade-off: es levemente más raro pero funcionalmente correcto.

Test `request-context.interceptor.spec.ts`:
- Request sin `x-request-id` → genera uno.
- Request con `x-request-id: abc-123` → lo usa.
- Request autenticado → `clinicId` y `userId` disponibles en el contexto.

**Acceptance:** test verde.

### T-2.3 · Registrar interceptor global (0.5h) · **dev principal**

En `apps/backend/src/common/logger/logger.module.ts`:
```ts
providers: [
  RequestContextService,
  { provide: APP_INTERCEPTOR, useClass: RequestContextInterceptor },
],
```

**Acceptance:** `pnpm build` verde.

### T-2.4 · Integration test — request completo con clinicId en log (1h) · **dev principal**

Test manual (documentado en el ADR corto al final):
```bash
# Login como CLINIC_ADMIN
TOKEN=$(curl -s -X POST http://localhost:4000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@clinicademo.com","password":"..."}' | jq -r .accessToken)

# Request autenticado con requestId propio
curl -H "Authorization: Bearer $TOKEN" \
     -H "X-Request-Id: test-abc-123" \
     http://localhost:4000/api/appointments
```
En stdout debe aparecer log con `requestId=test-abc-123`, `clinicId=<uuid>`, `userId=<uuid>`.

**Acceptance:** manual verificado + capturas al ADR.

### T-2.5 · Migrar 3 controllers piloto a `@InjectPinoLogger` (0.5h) · **dev principal**

Controllers piloto: `auth.controller.ts`, `appointments.controller.ts`, `patients.controller.ts`.

Cambiar:
```ts
// Antes:
import { Logger } from '@nestjs/common';
private readonly logger = new Logger(FooController.name);

// Después:
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
constructor(@InjectPinoLogger(FooController.name) private readonly logger: PinoLogger) {}
```

**Nota:** los `logger.log(...)` existentes con string interpolation (`by=${user.userId}`) los dejamos como están por ahora. La migración a structured (`this.logger.info({ userId: user.userId }, 'action')`) va aparte — sería un refactor grande. Solo cambiamos el import y la instancia.

**Acceptance:** `pnpm build` verde, `pnpm test` verde (los specs viejos siguen pasando porque la API de `.log()` es compatible).

### 🚦 Checkpoint 2 — Fin Lunes PM

**Pregunta go/no-go:** ¿Correlation ID atraviesa request completo?

- **GO:** avanzar al Bloque 3 (Axiom + Sentry).
- **NO-GO:** hardcodear el `requestId` en un interceptor mínimo sin AsyncLocalStorage (fallback: solo en logs de request completion, no propagado a services). Seguir con Bloque 3.

---

## Bloque 3 — Martes AM: Axiom + Sentry backend (4h)

### T-3.1 · Configurar transport de Pino → Axiom (1h) · **dev principal**

En `common/logger/logger.config.ts` agregar al array de transports:
```ts
if (process.env.AXIOM_ENABLED === 'true') {
  transports.push({
    target: '@axiomhq/pino',
    options: {
      dataset: process.env.AXIOM_DATASET_LOGS,
      token: process.env.AXIOM_TOKEN,
      orgId: process.env.AXIOM_ORG_ID,
    },
    level: 'info',
  });
}
```

**Acceptance:** `pnpm build` verde. `AXIOM_ENABLED=true` en `.env.local` de dev.

### T-3.2 · Verificar Axiom recibe logs de dev local (0.5h) · **dev principal**

1. Crear `.env` local con `AXIOM_ENABLED=true`, `AXIOM_TOKEN=xaat-xxx`, `AXIOM_DATASET_LOGS=showly-prod` (dataset compartido).
2. `pnpm dev:backend` + hacer 5 requests.
3. Abrir Axiom UI → dataset `showly-prod` → filtrar `env=development` → ver los logs.

**Acceptance:** logs aparecen en Axiom con los 8 campos del schema (§4.1 del spec).

### T-3.3 · Crear `common/sentry/sentry.config.ts` + init temprano en main.ts (1h) · **dev principal**

Ubicación: `apps/backend/src/common/sentry/sentry.config.ts`

Exporta `initSentry()` que llama `Sentry.init({...})` con:
- `dsn: process.env.SENTRY_DSN`
- `environment: process.env.SENTRY_ENVIRONMENT`
- `release: process.env.SENTRY_RELEASE`
- `tracesSampleRate: parseFloat(SENTRY_TRACES_SAMPLE_RATE || '0.1')`
- `enabled: process.env.SENTRY_ENABLED === 'true'`
- `integrations: [nodeProfilingIntegration()]`

En `main.ts` **al principio de bootstrap()**:
```ts
if (process.env.SENTRY_ENABLED === 'true') {
  initSentry();
}
```

Fail-fast en prod: si `NODE_ENV==='production'` y `SENTRY_DSN` no está seteado, error.

**Acceptance:** `pnpm build` verde. Con `SENTRY_ENABLED=true` en dev, `Sentry.getClient()` no es null.

### T-3.4 · Crear `common/sentry/sentry.filter.ts` global (1h) · **delegable a subagente**

Ubicación: `apps/backend/src/common/sentry/sentry.filter.ts`

`@Catch()` global ExceptionFilter que:
1. Captura toda exception no manejada.
2. Extrae `clinicId`, `userId`, `impersonatedBy`, `route` del `RequestContextService`.
3. Llama `Sentry.captureException(err, { tags: {...}, user: { id: userId } })`.
4. **NO** oculta el error — sigue el flujo normal (deja que Nest responda 500 al cliente con el error genérico).
5. Excepciones esperadas (`HttpException` con status < 500) **NO** se envían a Sentry — solo 500+ y throws no controlados.

Test `sentry.filter.spec.ts`:
- Mock de `Sentry.captureException`.
- Throw un `Error` desde un controller falso → verificar que captureException se llamó con tags correctos.
- Throw un `BadRequestException` (400) → NO se envía a Sentry.

Registrar en `common/sentry/sentry.module.ts`:
```ts
providers: [{ provide: APP_FILTER, useClass: SentryFilter }]
```

**Acceptance:** test verde.

### T-3.5 · Test integration — throw → Sentry event con tags (0.5h) · **dev principal**

Crear temporalmente un endpoint de test:
```ts
// apps/backend/src/health/health.controller.ts (temp)
@Get('crash-test')
crashTest() { throw new Error('sentry integration test'); }
```

1. Con `SENTRY_ENABLED=true` en dev y `SENTRY_ENVIRONMENT=development`.
2. Login → curl al endpoint → 500.
3. Abrir Sentry UI → proyecto `showly-backend` → verificar evento con tags `clinicId`, `userId`, `route`.
4. **Eliminar el endpoint** después de verificar.

**Acceptance:** evento visible en Sentry con los 3 tags.

### 🚦 Checkpoint 3 — Fin Martes AM

**Pregunta go/no-go:** ¿Axiom recibe logs + Sentry backend captura errores?

- **GO:** avanzar al Bloque 4 (BullMQ + Next).
- **NO-GO Axiom:** revertir el transport, seguir solo stdout, agendar debug para el sábado.
- **NO-GO Sentry backend:** debug bloqueante — sin Sentry no vamos a canary. Timebox 2h más, si no cierra: escalar / pausar sprint.

---

## Bloque 4 — Martes PM: BullMQ + Next.js Sentry + env vars (4h)

### T-4.1 · Wrapear los 3 workers de BullMQ con Sentry capture (1h) · **dev principal**

En `apps/backend/src/reminders/reminders.processor.ts`, `follow-ups/follow-ups.processor.ts`, `whatsapp/health-monitor.processor.ts`:

En el handler async del `new Worker(queueName, async (job) => { ... }, opts)`:
```ts
async (job) => {
  return await requestContext.run(
    { requestId: job.data.requestId ?? crypto.randomUUID(), clinicId: job.data.clinicId },
    async () => {
      try {
        // logic original
      } catch (err) {
        Sentry.captureException(err, {
          tags: { queue: job.queueName, jobId: job.id, attempt: job.attemptsMade + 1 },
          extra: { data: job.data },
        });
        throw err;  // rethrow para que BullMQ marque failed + retry
      }
    }
  );
}
```

**Acceptance:** los 3 workers compilan y siguen funcionando.

### T-4.2 · Propagar `requestId` en `job.data` (0.5h) · **dev principal**

En los `queue.add(...)` de `reminders.service.ts` y `follow-ups.service.ts`, agregar `requestId` al `job.data`:
```ts
await queue.add('send-reminder', {
  appointmentId,
  requestId: this.ctx.get('requestId'),
  clinicId: this.ctx.get('clinicId'),
});
```

**Acceptance:** `pnpm build` verde. Verificar en el spec siguiente (T-4.3).

### T-4.3 · Test — job que falla aparece en Sentry (0.5h) · **dev principal**

Simular manualmente: encolar un job con `appointmentId=<inexistente>` → el processor lo intenta procesar → falla → verificar evento en Sentry con `queue=reminders`, `jobId=xxx`.

**Acceptance:** evento visible.

### T-4.4 · Instalar `@sentry/nextjs` + configurar (1h) · **dev principal**

```bash
cd apps/web
pnpm add @sentry/nextjs
npx @sentry/wizard@latest -i nextjs --skip-connect
```

El wizard crea:
- `sentry.client.config.ts`
- `sentry.server.config.ts`
- `sentry.edge.config.ts`
- Modifica `next.config.mjs` con `withSentryConfig`

Revisar y ajustar cada archivo para usar tags custom (`clinicId` si está disponible del middleware, `userId`).

**Acceptance:** `pnpm --filter @showly/web build` verde.

### T-4.5 · Test — error en Next aparece en Sentry (0.5h) · **dev principal**

Crear página temporal `/sentry-test/page.tsx` que hace `throw new Error('nextjs sentry test')`. Visitar. Verificar evento en Sentry proyecto `showly-web`. Eliminar página.

**Acceptance:** evento visible con `runtime=nodejs` o `runtime=edge`.

### T-4.6 · Actualizar `.env.example` + `docker-compose.prod.yml` (0.5h) · **dev principal**

Agregar las 10 env vars nuevas del spec §5 a ambos archivos. Documentar cuáles son secrets y cuáles públicas.

**Acceptance:** `docker-compose config` no tira warnings de env faltantes.

### 🚦 Checkpoint Final — Fin Martes PM

**Pregunta go/no-go:** ¿DoD del spec §9 cumplido?

Checklist:
- [ ] `pnpm build` verde en backend y web
- [ ] `pnpm test` verde con los 4 specs nuevos
- [ ] Log estructurado en stdout con 8 campos
- [ ] `throw new Error` → Sentry con tags
- [ ] `req.body.password` → `[REDACTED]` en logs
- [ ] Axiom recibe logs filtrables por `clinicId`
- [ ] Job de BullMQ que falla → Sentry con `queue=follow-ups`
- [ ] `.env.example` actualizado
- [ ] `docker-compose.prod.yml` con envs

**Deliverables adicionales:**
- Nota `docs/notas/2026-08-19-observabilidad-implementada.md` con capturas de Axiom + Sentry
- ADR corto `docs/adr/0015-pino-axiom-sentry.md` con la decisión de stack
- Update `docs/INDEX.md` con los 2 links nuevos

**GO:** cerrar el bloque, arrancar Miércoles con el spec de health checks.
**NO-GO:** documentar qué falta, decidir si se recupera Miércoles noche o se corre a Sábado.

---

## Resumen: 15 tasks, 16h estimadas

| # | Task | Est | Delegable | Bloque |
|---|---|---|---|---|
| T-1.1 | Instalar deps backend | 0.5h | No | Lun AM |
| T-1.2 | logger.config.ts | 1h | No | Lun AM |
| T-1.3 | pii-redactor + test | 1h | **Sí** | Lun AM |
| T-1.4 | logger.module.ts | 0.5h | No | Lun AM |
| T-1.5 | main.ts wire Pino | 1h | No | Lun AM |
| T-2.1 | request-context.ts | 1h | No | Lun PM |
| T-2.2 | rc.interceptor + test | 1h | **Sí** | Lun PM |
| T-2.3 | Registrar global | 0.5h | No | Lun PM |
| T-2.4 | Integration test | 1h | No | Lun PM |
| T-2.5 | Migrar 3 ctrls | 0.5h | No | Lun PM |
| T-3.1 | Axiom transport | 1h | No | Mar AM |
| T-3.2 | Verificar Axiom | 0.5h | No | Mar AM |
| T-3.3 | sentry.config init | 1h | No | Mar AM |
| T-3.4 | sentry.filter + test | 1h | **Sí** | Mar AM |
| T-3.5 | Test throw → Sentry | 0.5h | No | Mar AM |
| T-4.1 | Wrap workers | 1h | No | Mar PM |
| T-4.2 | Propagar requestId | 0.5h | No | Mar PM |
| T-4.3 | Test job fail | 0.5h | No | Mar PM |
| T-4.4 | Instalar @sentry/nextjs | 1h | No | Mar PM |
| T-4.5 | Test error en Next | 0.5h | No | Mar PM |
| T-4.6 | env vars + compose | 0.5h | No | Mar PM |

**Total:** 15h efectivas + 1h buffer = 16h en 2 días.

## Delegación a subagentes

Tasks marcadas "Sí" en la tabla → delegables a subagente `general-purpose`:
- T-1.3 (pii-redactor + tests) — trivial, sin contexto de negocio.
- T-2.2 (rc.interceptor + tests) — requiere contexto del JWT payload; briefing corto.
- T-3.4 (sentry.filter + tests) — patrón estándar de NestJS ExceptionFilter.

**Trade-off:** delegar ahorra ~2h del dev principal pero suma overhead de briefing (~15 min por task). Recomendado solo si el dev principal está saturado. Por default: dev principal hace todo secuencialmente para mantener contexto.

## Riesgos activos (del spec §10)

1. `nestjs-pino` peleando con el Logger custom — timebox 3h en T-1.5.
2. Redact paths incompletos — mitigar con test exhaustivo en T-1.3.
3. `@sentry/nextjs` roto en App Router 15 — kill switch en T-4.4: si no anda, dejar solo backend.

## Próximo paso

1. Confirmar plan.
2. Yo creo las 21 tasks en el sistema de tracking (TaskCreate).
3. Empezamos Lunes a la mañana con T-1.1.
