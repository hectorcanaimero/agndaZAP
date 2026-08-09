# ADR 0008 — Panel de conexión WAHA + observabilidad de sesiones

- Fecha: 2026-08-09
- Estado: propuesto
- Relacionados: [[0002-waha-no-oficial]], [[0005-auth-mvp-y-deuda]], [[0006-panel-mvp-y-deuda]], [[../onboarding-clinica]]

## Contexto

Hoy el escaneo del QR para vincular una clínica a WhatsApp pasa por el
**dashboard nativo de WAHA** (`/dashboard`, protegido por basic-auth compartido).
Esto no escala por dos razones concretas:

1. **Fuga cross-tenant**: el dashboard de WAHA expone TODAS las sesiones de
   TODAS las clínicas. Cualquier operador con esas credenciales puede ver el
   QR, el estado y la conversación de cualquier clínica. Contradice frontal
   la regla dura de multi-tenant de [[0006-panel-mvp-y-deuda]] §1.
2. **Silencio operativo**: cuando una sesión cae a `FAILED` (baneo temporal,
   celular apagado, WhatsApp Web abierto en paralelo — todos los riesgos que
   [[0002-waha-no-oficial]] asume), NO hay señal al operador. La clínica se
   entera cuando un paciente reclama que "el bot no contesta".

El bloque está listado como deuda en [[../onboarding-clinica]] §14 items 3 y 4
(`GET /api/clinics/:id/waha/status` y `POST /api/clinics/:id/waha/start`).

## Decisión

Meter la UX de conexión WAHA dentro del panel scopeado por clínica **y** sumar
un job periódico de health-check de sesiones. Se tratan como un solo paquete
indivisible: la UX sin observabilidad simplemente mueve el fallo silencioso
del dashboard de WAHA al panel — mismo problema, distinto lugar.

## Alcance concreto

### Backend

- `WhatsappPanelController` nuevo con 3 endpoints:
  - `GET /api/clinics/me/waha/status` — devuelve `{ status, qr?, session }`.
  - `POST /api/clinics/me/waha/start` — arranca la sesión, responde 202.
  - `POST /api/clinics/me/waha/logout` — cierra la sesión, responde 200.
- El `session` **siempre** se deriva de `clinic.wahaSession` vía el JWT scope.
  Nunca se acepta como path/query/body param. Precedente idéntico a
  [[0006-panel-mvp-y-deuda]] §1: `scope` es la única fuente de verdad.
- Guards: `JwtAuthGuard` (implícito global) + `RolesGuard` con
  `@Roles('CLINIC_ADMIN', 'SUPERADMIN')` + `assertClinicScope(user, undefined)`
  (sin override — no hay razón operativa para que un SUPERADMIN opere sobre
  WAHA de una clínica ajena por HTTP; si lo necesita, usa la API directa).
- Extender `WahaService` con:
  - `logoutSession(session: string): Promise<void>` — POST a
    `/api/sessions/{session}/logout` (verificar contra docs de la versión).
  - `getQrCode(session: string): Promise<string | null>` — devuelve base64 PNG
    o `null` si la sesión no está en `SCAN_QR_CODE`. El endpoint exacto de
    WAHA hay que verificarlo contra docs — es una **pregunta abierta**
    documentada en la spec del bloque (puede ser `/api/{session}/auth/qr`,
    `/api/screenshot?session=X` o `/api/sessions/{session}/qr` según versión).

### Observabilidad

- Job BullMQ repeatable `waha-health-monitor` cada 5 min (configurable via
  `WAHA_HEALTH_INTERVAL_MIN`, default `5`).
- Itera `Clinic.findMany`, llama `WahaService.getSessionStatus`, y loguea
  a `warn` cuando encuentra `FAILED`. Cero PII en logs — sólo
  `{ clinicId, session, status }`.
- Reusa el patrón BullMQ ya establecido por `RemindersModule` (no se agrega
  librería nueva ni infra nueva).

### Frontend

- Ruta nueva: `apps/web/src/app/[locale]/panel/config/whatsapp/page.tsx` (SSR
  del estado inicial) + `WhatsappConnectionClient.tsx` (client component).
- Polling adaptativo desde el client:
  - Estados transientes (`STARTING`, `SCAN_QR_CODE`) → poll cada 2s.
  - `WORKING` → poll cada 15s.
  - `STOPPED` / `FAILED` → no poll (espera acción del usuario).
- Render del QR como `<img src={data:image/png;base64,...} />` cuando el
  status es `SCAN_QR_CODE`.
- Botones: **Conectar** (POST /start), **Desconectar** (POST /logout con
  confirm dialog).
- Sin WebSocket — coherente con [[0006-panel-mvp-y-deuda]] §9 (WS diferido
  hasta >10 clínicas concurrentes).

## Consecuencias

- **(+)** `CLINIC_ADMIN` se auto-onboardea la conexión WhatsApp sin pedirle
  al operador de AgendaZap acceso al dashboard de WAHA. Elimina un handoff
  manual en el playbook de [[../onboarding-clinica]] §3.
- **(+)** Sesiones caídas se vuelven visibles vía logs (setup para futuro
  alerting externo). El equipo de AgendaZap ve el `warn` en el tail de logs
  antes de que la clínica se queje.
- **(+)** El dashboard nativo de WAHA se deja sólo para debug del equipo
  técnico de AgendaZap, no para operación de las clínicas.
- **(−)** Un endpoint más de polling en el panel. Mitigación: rate-limit
  20/min por JWT en `GET /status`. Con polling de 2s el cliente pediría
  30/min — el rate-limit fuerza a que el frontend baje a 3s en transiente,
  o levantamos el límite a 30/min si el UX 2s es dogma. **Decisión a
  cerrar en /plan**: se prefiere 20/min + client @ 3s (más margen a
  bursts legítimos y tabs olvidados).
- **(−)** Deuda que crea: alerting externo (Slack / email / PagerDuty)
  sobre `FAILED`. Hoy queda sólo en logs. Se documenta como nuevo item
  en la deuda del panel (nueva entrada en [[0006-panel-mvp-y-deuda]] §
  al cierre del bloque).

## Alternativas descartadas

- **Exponer el dashboard de WAHA por-clínica con un proxy y filtrado**:
  WAHA no soporta multi-tenancy nativa. El filtrado sería a nivel proxy
  (nginx/Caddy) — frágil, hay que reescribir HTML del dashboard, y
  cualquier update de WAHA que cambie el markup lo rompe. Descartado.
- **WebSocket para status en tiempo real**: over-engineering para el
  estado actual. El polling adaptativo cubre el flujo de conexión (que
  dura minutos, no segundos) sin infra nueva. Reevaluar en el disparador
  de [[0006-panel-mvp-y-deuda]] §9.
- **Delegar el monitoreo a un cron externo (systemd timer, cron del host)**:
  rompe la portabilidad del monorepo. Hoy todo el scheduling corre en
  BullMQ dentro del backend — sumar un binario externo obliga a documentar
  y desplegarlo aparte. Descartado.
- **Consolidar el monitoreo en un job on-demand disparado por el status
  endpoint** (checkear FAILED al vuelo): rompe el principio de que la
  observabilidad no depende de que alguien mire. El operador puede pasar
  horas sin abrir el panel y la clínica en `FAILED` sigue silenciosa.

## Seguimiento

- Al cerrar el bloque, actualizar [[../onboarding-clinica]] §3, §4 y §14
  (items 3 y 4 salen de la lista de deuda).
- Al cerrar el bloque, agregar item nuevo en [[0006-panel-mvp-y-deuda]] §
  para "alerting externo sobre FAILED".
- Verificación (mismo criterio ADR 0006): ripgrep de `clinicId:` en
  `apps/backend/src/whatsapp/` sólo debe mostrar derivaciones de
  `scope.clinicId`, tipos, o mocks.
