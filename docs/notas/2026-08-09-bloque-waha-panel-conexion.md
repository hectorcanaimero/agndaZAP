# Bloque WAHA — Conexión desde el panel + health-monitor

- Fecha: 2026-08-09
- Relacionados: [[../adr/0008-panel-conexion-waha-y-observabilidad]],
  [[../adr/0002-waha-no-oficial]], [[../adr/0005-auth-mvp-y-deuda]],
  [[../adr/0006-panel-mvp-y-deuda]], [[../onboarding-clinica]]

## Objetivo

Que un `CLINIC_ADMIN` pueda conectar y desconectar la sesión de WhatsApp de
su clínica desde el panel (escaneando el QR sin salir de la app) y que las
sesiones que se caen a `FAILED` generen señal operativa vía logs. Cierra
[[../onboarding-clinica]] §14 items 3 y 4.

## Alcance dentro

1. Endpoints REST scopeados en
   `apps/backend/src/whatsapp/whatsapp-panel.controller.ts` (nuevo módulo o
   sub-módulo de `WhatsappModule` — decidir en `/plan`).
2. Extensión de `WahaService` (`apps/backend/src/whatsapp/waha.service.ts`)
   con `logoutSession(session)` y `getQrCode(session)`.
3. Job BullMQ `waha-health-monitor` en
   `apps/backend/src/whatsapp/health-monitor.job.ts` (nombre tentativo —
   decidir en `/plan`, alineado al patrón de `RemindersModule`).
4. Ruta `apps/web/src/app/[locale]/panel/config/whatsapp/page.tsx` (SSR
   inicial) + `WhatsappConnectionClient.tsx` (client component con polling
   adaptativo).
5. Link de navegación en el menú del panel apuntando a la nueva ruta.
6. Tests unit del controller (matriz de guards + happy path + errores WAHA)
   y del job (loguea en `warn` sólo cuando encuentra `FAILED`).

## Alcance fuera

1. **No hay alerta externa** (Slack/email/PagerDuty) sobre `FAILED` — se
   documenta como nueva deuda en [[../adr/0006-panel-mvp-y-deuda]].
2. **No hay `POST /api/clinics`** — sigue como deuda de onboarding
   ([[../onboarding-clinica]] §14 item 1).
3. **No hay UI para editar** `reminderOffsetsH` / `confirmThresholdH` /
   `autoConfirm` — sigue como deuda ([[../onboarding-clinica]] §14 item 5).
4. **No hay WebSocket** para status en tiempo real — el polling adaptativo
   es suficiente por [[../adr/0006-panel-mvp-y-deuda]] §9.
5. **No hay historial persistido** de eventos de sesión
   (`session_state_change`) — llegará con `AuditEvent` (deuda
   [[../adr/0006-panel-mvp-y-deuda]] §3).

## Contratos (endpoints)

Todos los endpoints requieren `Authorization: Bearer <jwt>` con rol
`CLINIC_ADMIN` o `SUPERADMIN`. El `session` **nunca** se acepta del cliente:
se deriva de `clinic.wahaSession` vía el scope del JWT.

| Método | Path                                | Guards                                                        | Request | Response (200/202)                                                                                                                                                                                                                    | Errores esperados                                                              |
|--------|-------------------------------------|---------------------------------------------------------------|---------|---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|--------------------------------------------------------------------------------|
| GET    | `/api/clinics/me/waha/status`       | Jwt + Roles(CLINIC_ADMIN, SUPERADMIN) + `assertClinicScope`   | —       | 200 `{ status: 'STARTING' \| 'SCAN_QR_CODE' \| 'WORKING' \| 'FAILED' \| 'STOPPED' \| 'UNKNOWN', qr?: string /* base64 PNG SOLO si status === 'SCAN_QR_CODE' */, session: string /* echo para debug — coincide con clinic.wahaSession */ }` | 401 (sin JWT), 403 (rol no permitido), 429 (rate-limit), 502 (WAHA caído → status `UNKNOWN`) |
| POST   | `/api/clinics/me/waha/start`        | Jwt + Roles(CLINIC_ADMIN, SUPERADMIN) + `assertClinicScope`   | `{}`    | 202 `{ status: 'STARTING' }`                                                                                                                                                                                                          | 401, 403, 502 (WAHA no responde)                                               |
| POST   | `/api/clinics/me/waha/logout`       | Jwt + Roles(CLINIC_ADMIN, SUPERADMIN) + `assertClinicScope`   | `{}`    | 200 `{ status: 'STOPPED' }`                                                                                                                                                                                                           | 401, 403, 502                                                                  |

Notas:

- Cuando WAHA responde 5xx al backend, `GET /status` devuelve
  `{ status: 'UNKNOWN', session }` sin cachear — el próximo poll re-intenta.
  Motivación: preferimos degradación visible sobre falso `WORKING`.
- 502 se reserva para POST (start/logout) donde el usuario **requiere**
  saber que la acción no se aplicó. En GET preferimos `UNKNOWN` para no
  romper el polling.

## Escenarios Gherkin

```gherkin
Escenario 1 — Conectar sesión inexistente
Given una clínica sin sesión activa
And un usuario CLINIC_ADMIN autenticado sobre esa clínica
When presiona "Conectar" en /panel/config/whatsapp
Then el backend responde 202 con { status: 'STARTING' }
And el próximo poll retorna { status: 'SCAN_QR_CODE', qr: '<base64>' }
And el frontend renderiza el QR como <img>

Escenario 2 — Escanear QR completa la conexión
Given una clínica en estado SCAN_QR_CODE
When el admin escanea el QR con el WhatsApp del número dedicado
Then el próximo poll retorna { status: 'WORKING' }
And el response NO incluye el campo qr

Escenario 3 — Desconectar sesión activa
Given una clínica con sesión WORKING
When el admin presiona "Desconectar" y confirma en el dialog
Then el backend llama a WahaService.logoutSession(session)
And responde 200 con { status: 'STOPPED' }
And el frontend deja de polear hasta próxima acción

Escenario 4 — Aislamiento multi-tenant (positivo)
Given un CLINIC_ADMIN de la clínica A con wahaSession='clinica-a'
When hace GET /api/clinics/me/waha/status
Then el backend usa session='clinica-a' derivado del JWT
And devuelve el status de la sesión de A (nunca de otra clínica)

Escenario 5 — Rol insuficiente
Given un usuario con rol PROFESSIONAL
When hace GET /api/clinics/me/waha/status
Then el backend responde 403 (RolesGuard rechaza)
And no se llama a WahaService

Escenario 6 — WAHA caído durante polling
Given WAHA responde 500 a getSessionStatus
When el frontend polea GET /status
Then el backend devuelve { status: 'UNKNOWN', session }
And NO cachea el error
And el próximo poll re-intenta

Escenario 7 — Job periódico detecta FAILED
Given el job waha-health-monitor corre cada 5 min
And una clínica X está en estado FAILED
When se dispara la iteración
Then el logger emite warn con { clinicId: X.id, session: X.wahaSession, status: 'FAILED' }
And no se emite información PII (nombres, teléfonos, mensajes)
```

## Reglas de seguridad y multi-tenant

- **`session` viene del JWT** (`clinic.wahaSession` resuelto por el scope),
  jamás del path/body/query. Precedente idéntico a
  [[../adr/0006-panel-mvp-y-deuda]] §1 (patrón `tenantWhere`).
- **`assertClinicScope(user, undefined)`** en cada handler. Sin override
  permitido en este bloque — un SUPERADMIN que necesite operar sobre WAHA
  de una clínica ajena usa la API directa de WAHA (el equipo técnico ya
  tiene esas credenciales).
- **QR nunca en logs**. Presencia sí, contenido no:
  `logger.debug({ clinicId, qr: qr ? 'present' : 'absent' })`. Nunca
  `logger.debug({ qr })` — el string es sensible mientras la sesión no
  esté establecida.
- **Rate-limit** en `GET /status`: 20/min por JWT usando el helper
  `RateLimit` existente ([[../adr/0003-rate-limit-casero-vs-throttler]]).
  Alternativa: 30/min si el polling client-side no baja de 2s. Decisión
  final en `/plan`.
- **POST /start** y **POST /logout**: sin rate-limit dedicado (el
  RolesGuard + `assertClinicScope` cubren el abuso; son acciones raras).
- **Session name en response**: se echa el `session` en el response para
  debug. NO es información sensible per se (es un slug internal), pero
  se documenta que aparece para evitar sorpresas en logs de red.

## Observabilidad

- **Job `waha-health-monitor`**:
  - Corre cada 5 min por default. Configurable via env
    `WAHA_HEALTH_INTERVAL_MIN`.
  - Loguea `info` al arrancar la iteración con `{ count: clinicsChecked }`.
  - Loguea `warn` por cada clínica con `status === 'FAILED'` con payload
    `{ clinicId, session, status }`. Cero PII.
  - No emite warn para `STOPPED` (es un estado válido cuando el admin
    desconectó a propósito) ni para `UNKNOWN` (transitorio, WAHA down).
  - Se registra en el módulo de BullMQ existente (patrón de
    `RemindersModule`) — no requiere infra nueva.
- **Métricas futuras** (deuda): counter
  `waha_session_status{clinic_id, status}` para Prometheus/OTel cuando
  se sume el stack de métricas. Hoy sólo logs estructurados.

## Open questions (para `/plan` y `/build`)

1. **Endpoint exacto de WAHA para el QR** — verificar contra docs de la
   versión que usa el compose (`devlikeapro/waha:latest`). Candidatos:
   - `GET /api/{session}/auth/qr` (retorna JSON con base64).
   - `GET /api/screenshot?session=X` (retorna PNG raw).
   - `GET /api/sessions/{session}/qr` (retorna PNG o JSON según flag).

   Impacto: la forma del helper `WahaService.getQrCode` depende de esto.
2. **Formato del QR** — WAHA en distintas versiones devuelve PNG raw
   binary, SVG, o base64 embebido en JSON. Definir el shape final del
   response de `getQrCode` en `/plan`. El frontend siempre espera base64
   para meter en `<img src="data:image/png;base64,...">`.
3. **¿Cachear el status en Redis por 2s para deduplicar polls
   concurrentes de la misma clínica?** — Sí si el rate-limit no alcanza
   (dos operadores con la pestaña abierta = 60/min al backend, x cada
   clínica). No si el volumen del piloto es 1-2 usuarios por clínica.
   Reevaluar tras smoke.
4. **`assertClinicScope` sin override** — hoy la utilidad acepta
   `undefined` como override y usa `user.clinicId`. Confirmar que el
   comportamiento con `undefined` es el que queremos (spec
   [[../adr/0006-panel-mvp-y-deuda]] §2 valida el caso divergente pero
   no dice explícitamente qué pasa con `undefined`).

## DoD (Definition of Done)

- [ ] Backend: los 3 endpoints responden con la matriz de guards correcta
      (test unit del controller cubre CLINIC_ADMIN happy, SUPERADMIN
      happy, PROFESSIONAL → 403, sin JWT → 401).
- [ ] Backend: el job periódico corre en modo dev con
      `WAHA_HEALTH_INTERVAL_MIN=1` y loguea correctamente.
- [ ] Backend: `pnpm test` pasa (mantener ≥180 tests verdes de
      [[../adr/0006-panel-mvp-y-deuda]] + nuevos del bloque).
- [ ] Backend: `rg 'clinicId:' apps/backend/src/whatsapp/` muestra sólo
      `scope.clinicId` o tipos/mocks — patrón [[../adr/0006-panel-mvp-y-deuda]] §1.
- [ ] Frontend: la ruta renderiza el estado inicial en SSR y muestra QR
      cuando aplica. Botones "Conectar" y "Desconectar" funcionan.
- [ ] Frontend: `pnpm build` limpio.
- [ ] Manual smoke:
  - (a) Conectar desde el panel de una clínica seed, escanear QR con
    otro celular, ver el estado pasar a WORKING.
  - (b) Desconectar y ver el estado pasar a STOPPED.
  - (c) Forzar FAILED matando el container de WAHA
    (`docker compose stop waha`), verificar log del job en <10 min
    (con `WAHA_HEALTH_INTERVAL_MIN=1` para acelerar).
- [ ] Actualizar [[../onboarding-clinica]] §3, §4 y §14 (items 3 y 4
      salen de la deuda; §3 y §4 pasan a documentar el flujo por panel).
- [ ] Actualizar [[../INDEX]] con links a la nueva ADR 0008 y a esta
      nota.
- [ ] Entry en [[../bitacora]] con la fecha de cierre y los learnings
      del smoke.
