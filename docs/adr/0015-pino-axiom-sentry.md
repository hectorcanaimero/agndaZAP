# ADR 0015 — Observabilidad: Pino + Axiom + Sentry

## Estado

Aceptada — 2026-08-18

## Contexto

Con el lanzamiento inminente de 40 clínicas piloto simultáneas por 60 días, la falta de observabilidad estructurada es un blocker. El logger de NestJS por default (`Logger` de `@nestjs/common`) escribe a stdout con formato humano, sin structured fields ni destination centralizado. Debugging cross-tenant sería impracticable: con 40 clínicas activas, buscar "por qué no llegó el recordatorio a la clínica X" en `docker logs` es imposible.

Adicionalmente, `docs/plans/2026-08-18-observabilidad-plan.md` §Riesgos activos exige:
- Logs con filtros por `clinicId` para diagnóstico rápido de tickets
- Correlación end-to-end (HTTP request → BullMQ job → outbound WhatsApp) con un `requestId`
- Redacción de PII (email, phone, name, notes, message body) antes de escribir el log — ver ADR 0004
- Captura de errores no controlados con contexto de tenant para triaje pre-cliente
- Fail-fast en producción si la observabilidad no está configurada (no salimos ciegos)

## Decisión

Stack elegido:

### Logs — Pino + Axiom (SaaS)

- **Pino** como logger core (a través del wrapper `nestjs-pino`). Motivos: ~5× más rápido que Winston, structured JSON por default, ecosistema maduro, redact nativo con `fast-redact`.
- **Axiom** como destination cloud (SaaS). Free tier 500 GB/mes + 30 días retention → suficiente para 40 clínicas. Cero infra que mantener durante el piloto.
- **AsyncLocalStorage** para request context. Un interceptor de Nest lo popula post-`JwtAuthGuard` con `requestId + clinicId + userId + impersonatedBy`. Un `mixin` de Pino inyecta esos campos en TODO log entry sin que el service tenga que pasarlos manualmente.
- **PII redaction**: 47 paths en `pii-redactor.ts` cubriendo campos root-level, wildcards nested (`*.email`) y paths exactos (`req.headers.authorization`).

### Errors — Sentry (SaaS)

- **`@sentry/nestjs`** en backend + **`@sentry/nextjs`** en frontend. Free tier: 5k errores/mes + session replay para bugs de UI.
- Filter global (`SentryFilter`) que reporta 500+ y errores no-HttpException. 4xx (validación, negocio) NO se envían — es ruido.
- Tags: `clinicId`, `userId`, `impersonatedBy`, `route` → dashboard filtrable por tenant.
- Init temprano en `main.ts` **antes** de `NestFactory.create()` para capturar errores de bootstrap.

### Correlación workers ↔ requests

BullMQ workers son standalone (no NestJS providers). No pueden inyectar `RequestContextService`. **Patrón adoptado:**

1. El producer (`RemindersService`, `FollowUpsService`) inyecta `RequestContextService`.
2. Al hacer `queue.add(...)`, agrega `requestId + clinicId` a `job.data`.
3. El worker consumer lee esos campos y hace `requestContext.run(store, handler)` — crea el scope aislado del job con el mismo `requestId` del request HTTP original.
4. Los `Sentry.captureException` dentro del worker heredan el contexto.

Resultado: un debug completo "clínica X recibió mensaje raro" se resuelve con UNA búsqueda por `clinicId` en Axiom que devuelve todos los logs (HTTP + jobs) del trace completo.

## Alternativas descartadas

| Alternativa | Razón del rechazo |
|---|---|
| **Winston** en vez de Pino | Winston es sync + más lento. Pino gana en throughput con menor CPU. Para 40 clínicas con ~4k msgs/día es material. |
| **Grafana Loki self-hosted** | Free y potente, pero requiere docker-compose extra + mantenimiento. Con 1 dev en el sprint, es rathole. Se evalúa post-piloto si Axiom se hace caro. |
| **Datadog / New Relic** | Costo prohibitivo para piloto ($15+/host/mes). Free tiers muy limitados. |
| **SigNoz** | Muy pulido pero self-hosted (ClickHouse + Cassandra dependencies). Descartado por complejidad de mantenimiento. |
| **Sentry self-hosted** | Requiere Docker Swarm/Kubernetes + 4-8 GB RAM. Free tier de SaaS resuelve para el piloto. |
| **Middleware (no Interceptor) para RequestContext** | Middleware corre ANTES del `JwtAuthGuard` → no tiene `req.user`. Interceptor fue la única opción correcta. |
| **`@sentry/profiling-node`** | Requiere package separado y overhead ~5% CPU. Sale del MVP; se evalúa si aparece un bottleneck. |

## Configuración obligatoria en producción

`main.ts` valida al bootstrap (fail-fast):
- `SENTRY_DSN` debe existir → sin él no vamos a canary
- `JWT_SECRET` ≥32 chars y sin prefix `dev-` (ya existía, se refuerza)

En dev todo es opt-in con `AXIOM_ENABLED=false` / `SENTRY_ENABLED=false` por default — no se ensucia el proyecto Sentry con noise local.

## Consecuencias

### Positivas

- **Filtro por tenant en <10s** desde Axiom UI → cierra el gap crítico para 40 clínicas.
- **Trace completo end-to-end** con `requestId` — resuelve "el mensaje no llegó" en 1 query, no 30 min de grep.
- **Zero PII leak garantizado** por whitelist de fields + 10 tests unitarios que validan la redacción.
- **Sentry alerts** al primer 500 → sabemos ANTES que la clínica escriba al soporte.
- **Compliance-friendly**: los logs tienen retention configurable (30 días default) + el audit trail estructurado va aparte a Postgres (ADR 0014).

### Negativas / Deuda técnica

- **Free tier de Axiom** (500 GB/mes): con 40 clínicas y `LOG_LEVEL=debug` se puede saturar. Mitigación: default a `info` en prod + skip de health checks en `autoLogging.ignore`.
- **Free tier de Sentry** (5k errors/mes): un bug repetido en loop lo revienta. Mitigación: filtrar errores esperados en el `SentryFilter` (ya se hace con HttpException < 500).
- **Migración incompleta a `PinoLogger`**: solo 3 controllers piloto migrados (auth, appointments, patients). Los otros ~15 controllers + services siguen con `Logger` de `@nestjs/common` que también fluye via `nestjs-pino` pero sin el structured API (`.info(obj, msg)`). Migración progresiva post-piloto.
- **Los tests siguen viendo output `[Nest] LOG`**: el `LoggerModule` custom no se carga en test envs (`Test.createTestingModule` puro). Solo afecta lectura de test output — cero impacto en producción.
- **Sentry SaaS**: dependency cloud. Si Sentry cae, perdemos error tracking hasta que vuelva. Aceptable para MVP.

## Relacionado

- [[0004-pii-y-compliance]] — motivación de la redacción
- [[0005-auth-mvp-y-deuda]] — JWT payload que se lee en el interceptor
- [[0014-superadmin-como-operador-saas]] — `impersonatedBy` en JWT que se propaga a logs
- [[../specs/2026-08-18-observabilidad-pino-axiom-sentry|Spec de observabilidad]]
- [[../plans/2026-08-18-observabilidad-plan|Plan de 21 tasks]]
- [[../notas/2026-08-19-observabilidad-implementada|Nota de implementación con smoke tests]]
