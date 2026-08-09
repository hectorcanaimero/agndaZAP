# Plan — Bloque WAHA: Panel de Conexión + Health Monitor

- Fecha: 2026-08-09
- Estado: aprobado, listo para /build
- Spec: [[2026-08-09-bloque-waha-panel-conexion]]
- ADR: [[../adr/0008-panel-conexion-waha-y-observabilidad]]

## 1. Resolved open questions

**Q1: WAHA QR endpoint.**
- URL: `GET /api/{session}/auth/qr` (legacy path — still current in `devlikeapro/waha:latest`).
- Method: `GET`.
- Auth header: `X-Api-Key: <apiKey>` (mismo header ya usado por `WahaService.headers()`).
- Con `Accept: application/json` retorna `{ mimetype: 'image/png', data: '<base64>' }` — este es el shape que elegimos.
- Alternativa con `Accept: image/png` retorna PNG binario (más pesado en Node, complica el proxy). Descartada.
- Estrategia defensiva: si WAHA responde 404 (sesión no en `SCAN_QR_CODE`) o 5xx → retornar `null` sin loguear cuerpo.
- Session start/stop/logout endpoints ya alineados con el ADR: `POST /api/sessions/{session}/logout` (borra credenciales) y `POST /api/sessions/start` (legacy, ya usado). Para logout usamos `/logout` (no `/stop`) porque el usuario quiere terminar la sesión y forzar re-QR en el próximo start.

**Q2: QR response shape.**
- `WahaService.getQrCode(session): Promise<string | null>` → devuelve string listo `data:image/png;base64,...` o `null`.
- Justificación:
  - Minimiza PII risk en logs (nunca loguear el string; sólo `qr: qr ? 'present' : 'absent'`).
  - Frontend consume directamente `<img src={qr}>` sin composición extra.
  - Evita exponer un endpoint proxy nuevo `/qr.png` (una ruta menos para asegurar, y sin binario cruzando Nest → Next).
  - El controller pasa el string tal cual al response — sin transformación adicional.

**Q3: `assertClinicScope` semantics.**
- Ubicación: `apps/backend/src/auth/tenant-context.util.ts` (no `common/`).
- Signature: `assertClinicScope(user: AuthUser, overrideClinicId?: string): string`.
- Con `overrideClinicId === undefined`:
  - CLINIC_ADMIN / PROFESSIONAL → devuelve `user.clinicId` (o 403 si falta).
  - SUPERADMIN → **400 BadRequest** ("SUPERADMIN debe especificar clinicId explícito").
- Podemos llamarlo con `assertClinicScope(user)` (sin segundo argumento) o `assertClinicScope(user, undefined)` — equivalentes.
- Recomendación para el controller nuevo: usar `assertClinicScope(user)` para obtener el `clinicId` string.

## 2. Dependency graph

```
[T1: WahaService primitives (logoutSession, getQrCode)]
         │
         ▼
[T2: WhatsappPanelController — GET /status]  ← CHECKPOINT A
         │
         ▼
[T3: WhatsappPanelController — POST /start + POST /logout]
         │
         ├──────────────────────────────────────┐
         ▼                                      ▼
[T4: Frontend SSR page + client (status + QR)]
         │
         ▼
[T5: Frontend — acciones + polling adaptativo]
         │
         ▼
[T6: Nav link "WhatsApp" en PanelShell]  ← CHECKPOINT B
         │
         ▼
[T7: HealthMonitor service (lógica pura) + tests]
         │
         ▼
[T8: HealthMonitor BullMQ wiring + smoke]
         │
         ▼
[T9: docs update]  ← CHECKPOINT C
```

T4 y T7 son independientes; pueden paralelizarse.

## 3. Vertical slices (tasks)

### T1 — WahaService primitives: `logoutSession` + `getQrCode`

- **Files:** `apps/backend/src/whatsapp/waha.service.ts` (+~50 LoC) + `waha.service.spec.ts` (nuevo).
- **Acceptance:**
  - `logoutSession(session)`: `POST /api/sessions/{session}/logout` con `X-Api-Key`. Loguea `error` si `!res.ok` y tira `Error('WAHA logout <status>')`.
  - `getQrCode(session)`: `GET /api/{session}/auth/qr` con `Accept: application/json`. `res.status === 404 || !res.ok` → `null`. Ok → parsea `{ mimetype, data }` → `data:${mimetype};base64,${data}`.
  - Nunca loguear `data`. Loguear `qr: qr ? 'present' : 'absent'`.
  - Tests unit: happy path logout, error logout, happy path QR, 404 QR → null, 500 QR → null.
- **Verify:** `pnpm --filter @agendazap/backend test -- waha.service.spec.ts`.
- **Deps:** ninguna. **Size:** S. **Rollback:** `git revert`.

### T2 — WhatsappPanelController: `GET /status`

- **Files:** create `whatsapp-panel.controller.ts` (~80 LoC) + `.spec.ts` (~120 LoC); modify `whatsapp.module.ts` (agregar controller + import de `PublicModule` para `REDIS_CLIENT` del `RateLimit`).
- **Acceptance:**
  - `@Controller('clinics/me/waha')`, `@UseGuards(RolesGuard)`, `@Roles('CLINIC_ADMIN', 'SUPERADMIN')`.
  - `@Get('status')` con `@UseGuards(RateLimit(20, 'waha-status'))`.
  - `clinicId = assertClinicScope(user)` → `prisma.clinic.findUniqueOrThrow({ where: { id: clinicId }, select: { wahaSession: true } })`.
  - `waha.getSessionStatus(session)`; si `'SCAN_QR_CODE'` → `waha.getQrCode(session)` y adjunta `qr`.
  - Response: `{ status, qr?, session }`. Nunca cachear `'UNKNOWN'`.
  - `logger.debug({ clinicId, status, qr: qr ? 'present' : 'absent' })`.
  - Tests: (1) CLINIC_ADMIN + WORKING → 200 sin qr. (2) CLINIC_ADMIN + SCAN_QR_CODE → 200 con qr. (3) SUPERADMIN sin override → 400 (por `assertClinicScope`). (4) WAHA down → UNKNOWN sin throw. (5) `getQrCode` retorna null → status queda SCAN_QR_CODE sin `qr`.
- **Verify:** `pnpm --filter @agendazap/backend test -- whatsapp-panel.controller.spec.ts`.
- **Deps:** T1. **Size:** M. **Rollback:** `git revert`.

### T3 — WhatsappPanelController: `POST /start` + `POST /logout`

- **Files:** modify controller (+40 LoC) + spec (+80 LoC).
- **Acceptance:**
  - `@Post('start')` `@HttpCode(202)` → `waha.startSession(session)` → `{ status: 'STARTING' }`. WAHA 5xx → `BadGatewayException` (502).
  - `@Post('logout')` `@HttpCode(200)` → `waha.logoutSession(session)` → `{ status: 'STOPPED' }`. Mismo 502 handling.
  - Ambos validan `assertClinicScope(user)` primero.
  - Tests: (1) start → 202. (2) logout → 200. (3) WAHA throws start → 502. (4) WAHA throws logout → 502. (5) SUPERADMIN sin override → 400.
- **Verify:** `pnpm --filter @agendazap/backend test -- whatsapp-panel.controller.spec.ts && curl ...`
- **Deps:** T2. **Size:** M. **Rollback:** `git revert`.

**CHECKPOINT A** — humano verifica los 3 endpoints con curl usando JWT dev antes de tocar frontend.

### T4 — Frontend: SSR page + `WhatsappConnectionClient` (status + QR)

- **Files:** `apps/web/src/app/[locale]/panel/config/whatsapp/page.tsx` (~50 LoC), `WhatsappConnectionClient.tsx` (~100 LoC), `messages/es.json`, `messages/pt.json`.
- **Acceptance:**
  - SSR carga `/api/clinics/me/waha/status` con `fetcher` + `getTokenFromCookies`.
  - Badge por status. Si `SCAN_QR_CODE` + qr → `<img src={qr} alt="QR" width={256} height={256} />`.
  - Botones "Conectar"/"Desconectar" renderizados pero `disabled` (wiring en T5).
  - Sin `new Date()`.
- **Verify:** `pnpm --filter @agendazap/web build` limpio. Manual: URL renderiza estado inicial.
- **Deps:** T3. **Size:** M. **Rollback:** `git revert` + `rm -rf` de directorios vacíos.

### T5 — Frontend: acciones + polling adaptativo

- **Files:** modify `WhatsappConnectionClient.tsx` (+80 LoC).
- **Acceptance:**
  - "Conectar" → `POST /start` → inicia polling.
  - "Desconectar" → confirm → `POST /logout` → detiene polling.
  - Polling: `STARTING`/`SCAN_QR_CODE`/`UNKNOWN` cada 3s; `WORKING` cada 15s; `STOPPED`/`FAILED` sin polling.
  - `useEffect` con `setTimeout` recursivo (no `setInterval`). Cleanup en unmount.
  - 502 → toast error. 429 → toast info + backoff a 10s.
- **Verify:** `pnpm --filter @agendazap/web build`. Manual: conectar → escanear con celular → WORKING → desconectar → STOPPED.
- **Deps:** T4. **Size:** M. **Rollback:** `git revert`.

### T6 — Nav link "WhatsApp" en `PanelShell` + i18n

- **Files:** modify `PanelShell.tsx` (+3 LoC), `messages/es.json`, `messages/pt.json`.
- **Acceptance:** item nuevo `panel.nav.whatsapp` → `/${locale}/panel/config/whatsapp`. Activo por prefijo. Desktop + mobile.
- **Verify:** `pnpm --filter @agendazap/web build`. Manual: highlight OK.
- **Deps:** T5. **Size:** S. **Rollback:** `git revert`.

**CHECKPOINT B** — humano hace smoke completo del flujo panel antes de invertir en health monitor.

### T7 — `HealthMonitor` service (lógica pura) + tests

- **Files:** create `health-monitor.service.ts` (~60 LoC) + `.spec.ts` (~100 LoC); modify `whatsapp.module.ts`.
- **Acceptance:**
  - `checkAll(): Promise<{ checked: number; failed: number }>`.
  - `prisma.clinic.findMany({ select: { id, wahaSession } })` — sólo con sesión.
  - Por clínica → `getSessionStatus`; si `'FAILED'` → `logger.warn({ clinicId, session, status })`. Cero PII.
  - NO warn para `STOPPED` ni `UNKNOWN`.
  - `logger.info({ event: 'health-monitor.tick', count })` al arrancar.
  - `getSessionStatus` throws → log error, continúa loop.
  - Tests: (1) 3 clínicas mix → 1 warn. (2) 1 UNKNOWN → 0 warns. (3) throws → no rompe loop.
- **Verify:** `pnpm --filter @agendazap/backend test -- health-monitor.service.spec.ts`.
- **Deps:** T1. **Size:** M. **Rollback:** `git revert`.

### T8 — `HealthMonitor` BullMQ wiring + smoke

- **Files:** create `health-monitor.processor.ts` (~40 LoC), modify `whatsapp.module.ts` (Queue provider `HEALTH_MONITOR_QUEUE`), modify `main.ts` (bootstrap worker + `queue.add('tick', {}, { repeat: { every: intervalMin * 60_000 }, jobId: 'waha-health-monitor-tick' })`).
- **Acceptance:**
  - Constantes: `WAHA_HEALTH_QUEUE = 'waha-health'`, `WAHA_HEALTH_JOB = 'tick'`.
  - `WAHA_HEALTH_INTERVAL_MIN` (default 5).
  - `jobId` fijo → idempotencia al restart.
  - Log "waha-health-monitor programado cada Xmin" al bootstrap.
  - Smoke doc'd en PR: `WAHA_HEALTH_INTERVAL_MIN=1` + `docker compose stop waha` → warn en logs a 1-2 min.
- **Verify:** `pnpm --filter @agendazap/backend build && test`.
- **Deps:** T7. **Size:** M. **Rollback:** `git revert` + `redis-cli DEL bull:waha-health:*`.

**CHECKPOINT C** — humano confirma end-to-end antes de tocar docs.

### T9 — Docs update: onboarding-clinica, INDEX, bitácora

- **Files:** modify `docs/onboarding-clinica.md` (§3, §4, §14: remover items 3 y 4 de deuda), `docs/INDEX.md` (agregar links a ADR 0008 + nota + este plan), `docs/bitacora.md` (entrada 2026-08-09), `docs/adr/0006-panel-mvp-y-deuda.md` (§Deuda: agregar "alerting externo sobre FAILED — post-piloto").
- **Acceptance:** todos los wikilinks resuelven. Bitácora con learnings del smoke.
- **Verify:** `rg "\[\[.*\]\]" docs/{onboarding-clinica,INDEX,bitacora}.md` sin broken. Obsidian: grafo OK.
- **Deps:** T8. **Size:** S. **Rollback:** `git revert`.

## 4. Checkpoints

- **A** después de T3 — curl a los 3 endpoints con JWT dev.
- **B** después de T6 — smoke UX end-to-end con celular real.
- **C** antes de T9 — confirmar bloque cerrado funcionalmente.

## 5. Risks and mitigations

| Riesgo | Prob | Mitigación |
|---|---|---|
| QR endpoint cambia entre versiones WAHA (`/api/{session}/auth/qr` vs `/api/sessions/{session}/qr`). | Media | Implementar legacy verificado; pinnear versión de compose en comment del `WahaService`. Si smoke falla → task T1.5 prueba moderno. |
| Polling storm con múltiples admins → 429 masivo. | Media | Rate-limit 20/min JWT + polling 3s. Si satura → agregar cache Redis 2s como task post-piloto. |
| BullMQ repeatable duplicado tras restart si cambia `jobId`/`every`. | Media | `jobId` fijo + `every` de env. Documentar `redis-cli DEL` en PR de T8. |
| `assertClinicScope(user, undefined)` con SUPERADMIN → 400. Spec DoD sugiere "SUPERADMIN happy path". Contradicción. | Alta | Test debe validar 400 para SUPERADMIN sin override. Mantener ADR (no override permitido). |
| QR string filtra a logs por `logger.log(response)`. | Baja pero grave | Regla dura: nunca loguear response completo. Sólo `{ status, qr: qr ? 'present' : 'absent' }`. Code-reviewer valida. |

## 6. Alcance fuera (spec)

1. Sin alerta externa (Slack/email) sobre `FAILED` — nueva deuda en ADR 0006.
2. Sin `POST /api/clinics` — deuda onboarding §14.1.
3. Sin UI para `reminderOffsetsH`/`confirmThresholdH`/`autoConfirm` — deuda §14.5.
4. Sin WebSocket — polling adaptativo alcanza (ADR 0006 §9).
5. Sin `AuditEvent` para `session_state_change` — deuda ADR 0006 §3.

## 7. Commit sequence (conventional, sin Co-Authored-By)

- T1: `feat(whatsapp): add logoutSession and getQrCode primitives to WahaService`
- T2: `feat(whatsapp): expose panel controller with GET /clinics/me/waha/status`
- T3: `feat(whatsapp): add POST /waha/start and /waha/logout to panel controller`
- T4: `feat(web): scaffold /panel/config/whatsapp SSR page with status + QR render`
- T5: `feat(web): wire connect/logout actions and adaptive polling on WhatsApp panel`
- T6: `feat(web): add WhatsApp nav link to PanelShell`
- T7: `feat(whatsapp): add WahaHealthMonitor service for periodic session checks`
- T8: `feat(whatsapp): register waha-health-monitor BullMQ repeatable job`
- T9: `docs(onboarding): mark WAHA panel connection done, log block closure`

## 8. Contradictions to resolve during /build

1. **SUPERADMIN behavior**: spec DoD sugiere "SUPERADMIN happy path" pero `assertClinicScope(superadmin, undefined)` → 400. Decisión: mantener ADR (sin override); test valida `SUPERADMIN sin override → 400`.
2. **Common utils location**: `assertClinicScope` vive en `apps/backend/src/auth/tenant-context.util.ts`, no en `common/`. Import path para nuevos módulos: `from '../auth/tenant-context.util'`.

## 9. Critical files

- `apps/backend/src/whatsapp/waha.service.ts`
- `apps/backend/src/whatsapp/whatsapp.module.ts`
- `apps/backend/src/main.ts`
- `apps/backend/src/auth/tenant-context.util.ts`
- `apps/web/src/app/[locale]/panel/PanelShell.tsx`
