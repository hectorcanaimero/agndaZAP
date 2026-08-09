# ADR 0003 — Rate-limit casero con Redis vs `@nestjs/throttler`

- Fecha: 2026-08-08
- Estado: Aceptado
- Relacionados: [[bloque-3-pagina-publica]]

## Contexto

El Bloque 3 (página pública `/agendar/[clinicSlug]`) expone un `POST` sin auth para
crear citas y un `GET` público para leer el snapshot de la clínica + disponibilidad.
Ambos endpoints necesitan rate-limit anti-spam/anti-bot. Requisitos:

- Límite distinto por endpoint (POST 5/min, GET 30/min).
- Clave por **IP + slug** (una IP puede legítimamente hablar con varias clínicas).
- Debe funcionar con múltiples instancias del backend detrás de un LB.
- Devolver `429` con `Retry-After: 60` a la 6ta request.
- Compatible con `X-Forwarded-For` (proxy inverso adelante).

## Alternativas evaluadas

### A) `@nestjs/throttler` + `@nest-lab/throttler-storage-redis`

- (+) Solución "oficial" de Nest, con decoradores idiomáticos (`@Throttle`).
- (–) Dos deps nuevas (throttler + storage). Su default in-memory NO sirve con más
  de una instancia.
- (–) API basada en `TrackerBy` extendida cuando queremos combinar IP+slug (nuestro
  caso). Termina siendo tanto código como una implementación propia.
- (–) Añade superficie de dependencias sin dar mucho valor incremental.

### B) Guard casero + `ioredis` (elegido)

- (+) Cero deps nuevas: reusa `ioredis` (ya presente para BullMQ) y `parseRedis()`
  de `RemindersModule`.
- (+) 60 líneas de código con la política exactamente que queremos.
- (+) Trivial testear con un mock de `pipeline().incr()/.expire()/.exec()`.
- (+) Fixed window por bucket de 60s con TTL auto-limpio: 1 comando (INCR) + 1
  ocasional (EXPIRE). Barato.
- (–) Burst en el filo de la ventana (peor caso 2N en 61s). Aceptable — la defensa
  real anti-doble-reserva es el `@@unique([professionalId, startAt])` en DB.

## Decisión

Adoptar la opción **B**: `apps/backend/src/public/rate-limit.guard.ts` con la
factory `RateLimit(limit: number)` que produce un guard Nest inyectable. Se aplica
con `@UseGuards(RateLimit(N))` por endpoint.

## Consecuencias

- El Redis usado es el mismo de BullMQ; si Redis cae, el guard hace fail-open y
  loguea a error (documentado inline). Alternativa fail-closed = DoS a nosotros
  mismos.
- Las claves expiran solas por `EXPIRE 60`; no hace falta housekeeping.
- Cuando escalemos a políticas más finas (sliding window, per-user además de
  per-IP) probablemente valga la pena revisar la decisión.
- Cero PII en logs: sólo IP + slug + status (consistente con la regla del CLAUDE.md).

## Referencias

- Código: `apps/backend/src/public/rate-limit.guard.ts`, `.../public.controller.ts`.
- Tests: `apps/backend/src/public/public.controller.spec.ts` (bloque `RateLimit guard`).
