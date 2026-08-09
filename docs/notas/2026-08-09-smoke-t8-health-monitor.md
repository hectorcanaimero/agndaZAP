# Smoke test — T8 WahaHealthMonitor (BullMQ repeatable)

- Fecha: 2026-08-09
- Bloque: [[2026-08-09-bloque-waha-panel-conexion]] · [[2026-08-09-plan-bloque-waha-panel-conexion]]
- ADR: [[../adr/0008-panel-conexion-waha-y-observabilidad]]
- Commit T8: `6023584 feat(whatsapp): register waha-health-monitor BullMQ repeatable job`

## Setup

- Backend arrancado con `WAHA_HEALTH_INTERVAL_MIN=1 pnpm dev:backend` (log capturado en `/tmp/agendazap-smoke.log`).
- Backend viejo seguía activo en `:4000` — el nuevo bootstrap murió con `EADDRINUSE`, PERO el `queue.add(...)` alcanzó a ejecutarse antes del fail. Repeatable job quedó registrado en Redis.
- Backend viejo (compilado por `--watch` con el código nuevo) tomó los ticks.

## Resultados

Bootstrap OK (línea 35 del log):

```
[Bootstrap] waha-health-monitor programado cada 1m
```

Ticks corridos (Redis `bull:waha-health:completed` zset):

| Métrica | Valor |
|---|---|
| Jobs completados | 10 |
| Último `returnvalue` | `{"checked":1,"failed":0}` |
| Duración por tick | ~100ms (`finishedOn - processedOn`) |
| Retries | 0 |
| Próximo scheduled | +60s |

**El health monitor está funcionando end-to-end**: iteró clínicas (`demo-session` la única con `wahaSession` no vacía), consultó su status, retornó `failed=0`, loggeó tick.

## Gotcha detectado — doble repeatable

Se materializó el **riesgo #3** del plan:

```
46f2761f...  → every=60000ms  (1min — creado con WAHA_HEALTH_INTERVAL_MIN=1)
a3eb64f5...  → every=300000ms (5min — creado con default)
```

`jobId: 'waha-health-monitor-tick'` NO alcanza para deduplicar. BullMQ hashea `(jobId, every, cron, tz)` juntos — cambiar `every` produce un nuevo repeatable y el viejo queda huérfano corriendo en paralelo.

### Impacto

- Con dos repeatables, el worker ejecuta el tick **dos veces por minuto** (por el de 1min) + una vez cada 5min (por el de 5min). Superposición de cargas.
- El `checkAll()` es idempotente y barato (~100ms), pero acumula tráfico innecesario contra WAHA (~1 request/clínica por tick × 2 series).
- En prod, si un operator cambia `WAHA_HEALTH_INTERVAL_MIN` sin limpiar Redis, ambos intervalos coexisten.

### Fix operativo (runbook)

Antes de reiniciar el backend cuando cambia `WAHA_HEALTH_INTERVAL_MIN`, limpiar los repeatables:

```bash
docker exec agendazap-redis-1 redis-cli --scan --pattern 'bull:waha-health:*' \
  | xargs -I{} docker exec agendazap-redis-1 redis-cli DEL {}
```

Este comando también es el rollback documentado del commit T8 (`6023584`).

### Deuda pendiente

Cerrar el gotcha en código: al `bootstrap()`, ANTES de `queue.add(...)`, borrar todos los repeatables previos del queue `waha-health`. BullMQ ofrece `queue.removeRepeatable(jobName, opts)` — pero requiere conocer el `every` viejo. Alternativa: `queue.removeRepeatableByKey(key)` iterando `queue.getRepeatableJobs()`.

Snippet para próxima iteración:

```ts
const previous = await queue.getRepeatableJobs();
for (const job of previous) {
  await queue.removeRepeatableByKey(job.key);
}
await queue.add('tick', {}, { repeat: { every: intervalMs }, jobId: '...' });
```

Registrar como item nuevo en [[../adr/0008-panel-conexion-waha-y-observabilidad]] §Deuda al próximo touch de ese ADR (o incluir en el próximo bloque de fixes).

## Otros learnings

- **Tiempo del primer QR desde `POST /start`**: ~15-20s (WAHA + Chromium). Confirma que el polling de 3s del frontend produce 5-7 iteraciones antes de ver el QR — UX aceptable, no bloqueante.
- **`bull:waha-health:completed` es un `zset`**, no una lista. Cualquier introspección tiene que usar `zrevrange` para obtener los últimos.
- **`removeOnComplete: 100`** funciona — el zset se mantiene acotado, no crece indefinido.

## Próximos pasos abiertos

- Manual smoke Checkpoint B (frontend UX con celular real) — pendiente por parte del usuario.
- INDEX.md + bitacora.md — pendientes por conflicto con UX audit previo en el working tree.
- Ver deuda arriba sobre el double-repeatable.
