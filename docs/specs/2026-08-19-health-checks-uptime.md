# Spec — Health checks + Uptime monitoring (Sprint día 3)

**Fecha:** 2026-08-19 (adelantado — se ejecuta en la sesión del 18)
**Sprint:** Pre-lanzamiento 40 clínicas
**Alcance:** Día 3 (Miércoles) — ~6h efectivas

## Estado actual (baseline)

- Backend `/api/health` **YA EXISTE** en `apps/backend/src/health/health.controller.ts` con checks de DB y Redis. **Falta el check de WAHA** — servicio externo crítico del piloto.
- Frontend Next.js NO tiene health endpoint — hay que crear `apps/web/src/app/api/health/route.ts`.
- BetterStack Uptime NO configurado — usuario abre cuenta free, yo dejo listos los endpoints target.

## Asunciones

1. BetterStack free tier: 10 monitors, checks cada 3 min, alertas email + Slack/Telegram opcional.
2. Los health checks son públicos (no requieren auth) — cualquier oráculo externo debe poder llamarlos.
3. Los health checks NO deben aparecer en Axiom (ya excluidos en `logger.config.ts:autoLogging.ignore`).
4. Todos responden 200 con JSON `{ok, checks, timestamp}` — el oráculo interpreta el `ok` boolean (no HTTP 5xx) porque un blip momentáneo no debe abrir incidente.

## Acceptance criteria

### AC-1 · Backend health completo
```
GET /api/health responde:
{
  "ok": true|false,
  "db": true|false,
  "redis": true|false,
  "waha": true|false,
  "timestamp": "2026-08-18T15:30:00.000Z"
}
```
El `ok` es AND de los 3 checks. Cada check tiene timeout individual de 3s (no bloquea si un servicio cuelga). Si WAHA no responde, `waha: false` pero el endpoint sigue respondiendo 200.

### AC-2 · Endpoint liveness minimal
```
GET /api/health/live responde:
{ "ok": true, "timestamp": "..." }
```
Sin dependencias — solo confirma que el proceso está vivo. Usado por BetterStack para separar "backend proceso caído" vs "backend proceso vivo pero DB/WAHA caídos".

### AC-3 · Frontend health
```
GET /api/health (Next.js route handler)
Responde: { "ok": true, "timestamp": "...", "buildId": "..." }
```
`buildId` = SHA del bundle (env `NEXT_PUBLIC_BUILD_ID` o `process.env.NODE_ENV`). Confirma que el server Next está sirviendo. No verifica que el backend esté vivo (eso lo hace el monitor separado del backend).

### AC-4 · BetterStack monitors configurados
Al final del día, los 4 monitors están activos:
| Monitor | URL | Frecuencia | Expected |
|---|---|---|---|
| Backend liveness | `https://<backend-host>/api/health/live` | 3 min | 200 |
| Backend full | `https://<backend-host>/api/health` | 3 min | 200 + `ok: true` |
| Web | `https://<web-host>/api/health` | 3 min | 200 |
| WAHA (opcional) | via backend health | — | — |

Alertas via email al owner. Escalation opcional a Telegram/Slack.

## Estructura del código

### Backend — modificaciones
```
apps/backend/src/health/
├── health.controller.ts       (MODIFICADO — sumar check WAHA + endpoint /live)
├── health.controller.spec.ts  (MODIFICADO — sumar tests de WAHA + /live)
└── health.module.ts           (MODIFICADO — importar WhatsappModule para inyectar WahaService)
```

### Frontend — nuevo
```
apps/web/src/app/api/health/
└── route.ts                   (NUEVO — Next.js route handler)
```

## Contratos

### `GET /api/health` (backend)
Responde 200 SIEMPRE, con:
```ts
type HealthResponse = {
  ok: boolean;              // true si TODOS los checks pasan
  db: boolean;
  redis: boolean;
  waha: boolean;
  timestamp: string;        // ISO 8601 UTC
  checks: {
    db: { ok: boolean; latencyMs?: number; error?: string };
    redis: { ok: boolean; latencyMs?: number; error?: string };
    waha: { ok: boolean; latencyMs?: number; error?: string };
  };
};
```

El bloque `checks` tiene detalle para debugging manual (latencia, mensaje de error). Los `db/redis/waha` planos son legacy — mantienen compat con Docker healthcheck actual.

### `GET /api/health/live` (backend)
```ts
type LivenessResponse = {
  ok: true;
  timestamp: string;
};
```
Siempre `ok: true`. Si este endpoint no responde, el proceso está caído.

### `GET /api/health` (Next.js)
```ts
type WebHealthResponse = {
  ok: true;
  timestamp: string;
  buildId?: string;
};
```

## Convenciones

- **Timeout por check**: 3s. Un check que tarda más se marca como `false` (Promise.race con timeout).
- **Zero PII**: cero contenido de DB o Redis en la response — solo booleans + latency.
- **Idempotencia**: llamar el endpoint 100 veces no debe generar side effects.
- **Level `info` en logs**: los health checks van a stdout con nivel `info` (ya excluidos de auto-log en pinoConfig).

## Env vars nuevas

Ninguna nueva. Todos los checks usan las envs existentes (`DATABASE_URL`, `REDIS_URL`, `WAHA_BASE_URL`).

## Definition of Done

- [ ] `pnpm test` verde backend + web
- [ ] `/api/health` responde con 4 booleans + bloque `checks` detallado
- [ ] `/api/health/live` responde `{ok: true}` sin tocar DB/Redis/WAHA
- [ ] `/api/health` en Next.js responde `{ok: true, timestamp, buildId?}`
- [ ] Tests unitarios: check WAHA down, check DB down, check timeout individual
- [ ] Docs actualizados en `docs/notas/2026-08-19-observabilidad-implementada.md` con checklist BetterStack

## Task breakdown

| # | Task | Est | Delegable |
|---|---|---|---|
| T-5.1 | Sumar check WAHA a HealthController con timeout 3s | 1h | No |
| T-5.2 | Crear endpoint `/api/health/live` minimal | 0.5h | No |
| T-5.3 | Refactorear response para incluir bloque `checks` con latencia | 0.5h | No |
| T-5.4 | Actualizar `health.controller.spec.ts` con casos WAHA + /live + timeout | 1h | Sí |
| T-5.5 | Crear `apps/web/src/app/api/health/route.ts` | 0.5h | No |
| T-5.6 | Documentar setup BetterStack + monitors en la nota final | 0.5h | No |
| T-5.7 | Actualizar `docker-compose.prod.yml` healthcheck del backend para usar `/live` | 0.5h | No |

**Total:** 4.5h efectivas + 1.5h buffer.

## Riesgos

- **WAHA endpoint de health inconsistente**: WAHA community responde `/api/health`, pero algunas versiones cambian el path. Mitigación: check envuelto en try/catch con timeout.
- **BetterStack alert fatigue**: si el free tier de BetterStack manda alerta por cada blip de 30s, se vuelve ruido. Mitigación: configurar `retry` en el monitor (fallar 2 checks consecutivos antes de alertar).
- **Health endpoint como vector de recon**: alguien externo puede pollear `/api/health` para saber qué versiones tenemos. Mitigación: NO exponer versión de dependencias en la respuesta.

## Referencias

- Spec observabilidad: [[2026-08-18-observabilidad-pino-axiom-sentry]]
- Plan del sprint completo: [[../plans/2026-08-18-observabilidad-plan]]
- `docker-compose.prod.yml` healthcheck actual (usar `/live` en vez de `/`)
