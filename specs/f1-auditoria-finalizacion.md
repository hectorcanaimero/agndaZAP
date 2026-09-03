# F1 — Auditoría de finalización (pre-lanzamiento 40 clínicas)

Fase de auditoría integral del sistema Showly en su estado pre-canary (piloto
40 clínicas, fecha objetivo 2026-08-25). El objetivo NO es escribir código,
sino comparar el estado real del repo contra los artefactos de planificación
(`docs/PRD.md`, `docs/SPEC.md`, `docs/ARCHITECTURE.md`, `docs/adr/*`,
`docs/runbook-lanzamiento.md`, `docs/ux/*`) y emitir hallazgos accionables.

**Contrato de salida (todas las tasks de esta fase).** Cada task produce un
reporte markdown en `docs/auditoria/<task-id>.md` (crear el directorio si no
existe) y, al terminar, una línea resumen en el resultado de la dispatch.
Cada hallazgo dentro del reporte sigue este formato exacto:

```
- [P0|P1|P2] <título corto>
  - Gap: qué falta / qué rompe, vs qué artefacto (PRD §, SPEC §, ADR NNNN, runbook).
  - Evidencia: paths y líneas concretas (file:line), o "no existe / está stub".
  - Impacto lanzamiento: por qué importa para el piloto de 40 clínicas.
  - Recomendación: acción concreta (fix puntual o candidata a task de finalización).
```

Severidades: **P0** = bloquea el lanzamiento / fuga de datos / rompe el happy
path. **P1** = importante, debe estar antes del GO de las 40. **P2** = deuda
post-piloto. No inventar hallazgos: si un área está correcta, decirlo
explícitamente ("sin hallazgos P0/P1").

## F1.1 — Docs vs código (gap analysis)

Verificar que lo que promete el producto esté realmente implementado, y que
los contratos de SPEC reflejen el estado actual (incluye ADRs 0014-0017 y los
sprints de observabilidad/health/admin-audit que SPEC aún no contempla).

### F1.1.T1 — Gap analysis backend vs PRD/SPEC/ARCH

Mapear cada feature, contrato de API y regla de negocio de `PRD.md` §3,
`SPEC.md` §1-§2 y `ARCHITECTURE.md` contra los módulos reales de
`apps/backend/src`. Producir tabla gap: implementado / parcial / missing /
stub, con el módulo y archivo correspondiente.

- **Modelo**: opencode/gpt-5.5-codex
- **Estimación**: 6h
- **Razón**: Lectura y cruce de docs contra ~24 módulos NestJS; GPT-5.5 equilibra precisión y costo.
- **Files**:
  - `docs/PRD.md`
  - `docs/SPEC.md`
  - `docs/ARCHITECTURE.md`
  - `apps/backend/src`

### F1.1.T2 — Gap analysis frontend vs PRD §3

Mapear panel admin, página pública `/agendar/[clinicSlug]`, landing, `/admin/*`
e invitación (`/invite/[token]`) contra lo prometido en `PRD.md` §3 (panel web
y flujo público). Verificar qué pantallas existen, cuáles son placeholder y
cuáles faltan.

- **Modelo**: opencode/gpt-5.5-codex
- **Estimación**: 5h
- **Razón**: Recorrido de la estructura `app/` de Next.js + componentes; GPT-5.5.
- **Dependencies**: F1.1.T1
- **Files**:
  - `apps/web/src/app`
  - `apps/web/src/components`
  - `docs/PRD.md`

### F1.1.T3 — Reconciliar SPEC.md con los sprints post-08-18

`SPEC.md` quedó desactualizado: no documenta SUPERADMIN/`/admin/*`, leads,
feedback, follow-ups, invitations, i18n es/pt, observabilidad ni webhook HMAC
(ver `docs/adr/0014`–`0017` y `docs/specs/*`). Producir un diff concreto de lo
que hay que agregar/corregir en `SPEC.md` (y en `ARCHITECTURE.md` si aplica),
listo para una futura task de edición.

- **Modelo**: opencode/deepseek-v4-pro
- **Estimación**: 3h
- **Razón**: Síntesis de contratos con juicio de arquitectura; premium justificado.
- **Dependencies**: F1.1.T1
- **Files**:
  - `docs/SPEC.md`
  - `docs/ARCHITECTURE.md`
  - `docs/adr/0014-superadmin-como-operador-saas.md`
  - `docs/adr/0015-pino-axiom-sentry.md`
  - `docs/adr/0016-admin-audit-impersonation-trail.md`
  - `docs/adr/0017-webhook-hmac-cookie-hardening.md`
  - `docs/specs`

## F1.2 — Backend: core de agendamiento

El corazón del producto. Auditar reglas de disponibilidad, creación atómica de
cita y transiciones de estado contra `SPEC.md` §2.

### F1.2.T1 — Audit motor de disponibilidad

Auditar `scheduling/availability.service.ts` y `scheduling.service.ts` contra
las reglas de `SPEC.md` §2 "Disponibilidad": slot válido (BusinessHour,
solapamiento con citas activas, TimeOff, futuro en TZ), paso `durationMin +
bufferMin`, y cálculo SIEMPRE en Luxon con la TZ de la clínica. Detectar usos
de `Date` naive.

- **Modelo**: opencode/gemini-3.1-pro
- **Estimación**: 4h
- **Razón**: Lógica de negocio densa con edge cases de TZ; Gemini 3.1 Pro.
- **Dependencies**: F1.1.T1
- **Files**:
  - `apps/backend/src/scheduling/availability.service.ts`
  - `apps/backend/src/scheduling/scheduling.service.ts`
  - `docs/SPEC.md`

### F1.2.T2 — Audit creación atómica + transiciones de cita

Auditar `appointments/appointment-status.util.ts`, creación en
`appointments`/`scheduling` y el constraint `@@unique([professionalId,
startAt])` en `schema.prisma`. Verificar transiciones permitidas (SPEC §2),
rechazo 422 de transiciones inválidas, estado inicial según `autoConfirm`, y
que la creación valide atómicamente el slot libre.

- **Modelo**: opencode/gpt-5.5-codex
- **Estimación**: 4h
- **Razón**: Verificación de invariantes de negocio + constraint; GPT-5.5.
- **Dependencies**: F1.1.T1
- **Files**:
  - `apps/backend/src/appointments/appointment-status.util.ts`
  - `apps/backend/src/appointments/appointments.controller.ts`
  - `apps/backend/prisma/schema.prisma`
  - `docs/SPEC.md`

### F1.2.T3 — Audit CRUDs de catálogo y agenda (tenant scoping + validación)

Auditar `services`, `professionals`, `business-hours`, `time-off`,
`appointments` y `patients`: validación con class-validator en DTOs, y que
cada query filtre por `clinicId` (sin fuga cross-tenant). Revisar que el
profesional tenga horario propio o herede el de la clínica.

- **Modelo**: opencode/gpt-5.5-codex
- **Estimación**: 5h
- **Razón**: Revisión transversal de CRUDs + tenant scoping; GPT-5.5.
- **Dependencies**: F1.1.T1
- **Files**:
  - `apps/backend/src/services`
  - `apps/backend/src/professionals`
  - `apps/backend/src/business-hours`
  - `apps/backend/src/time-off`
  - `apps/backend/src/appointments`
  - `apps/backend/src/patients`

## F1.3 — Backend: anti no-show + bot

El diferenciador del producto. Auditar recordatorios (idempotencia, offsets,
cancelación) y la FSM del bot (confirmación determinista, handoff).

### F1.3.T1 — Audit motor de recordatorios

Auditar `reminders/reminders.service.ts` y `reminders.processor.ts` contra
`SPEC.md` §2 "Recordatorios": jobs por offset futuro (pasados se omiten),
`jobId` determinista (`reminder:{id}`, `risk:{apptId}`), confirmar cancela
check-risk, cancelar/reprogramar elimina jobs, y umbral EN_RIESGO + alerta a
recepción.

- **Modelo**: opencode/gpt-5.5-codex
- **Estimación**: 4h
- **Razón**: Idempotencia y ciclo de vida de jobs BullMQ; GPT-5.5.
- **Dependencies**: F1.1.T1
- **Files**:
  - `apps/backend/src/reminders/reminders.service.ts`
  - `apps/backend/src/reminders/reminders.processor.ts`
  - `docs/SPEC.md`

### F1.3.T2 — Audit FSM del bot + determinismo de confirmaciones

Auditar `bot/bot.service.ts` y `bot/intent.service.ts`: pasos
`ASK_SERVICE → ASK_PROFESSIONAL → ASK_SLOT → CONFIRM`, resolución determinista
de confirmaciones (`sí`/`cancelar`/`reagendar`) ANTES del LLM, nunca crear/cancelar
sin confirmación explícita, `Conversation.state = HUMAN` silencia al bot, y
estado retomable vía `flowStep`/`flowData`.

- **Modelo**: opencode/gpt-5.5-codex
- **Estimación**: 5h
- **Razón**: FSM con estados + interacción LLM; GPT-5.5.
- **Dependencies**: F1.1.T1
- **Files**:
  - `apps/backend/src/bot/bot.service.ts`
  - `apps/backend/src/bot/intent.service.ts`
  - `docs/SPEC.md`

### F1.3.T3 — Audit feedback + follow-ups + leads

Auditar `feedback`, `follow-ups` y `leads` (ADR 0012 feedback post-atención, y
el sprint de marketing/leads). Verificar que estén wireados en el flujo del
bot y que los jobs de follow-up se programen/cancelen coherentemente con las
citas. Es una revisión mecánica de completitud.

- **Modelo**: opencode-go/deepseek-v4-flash
- **Estimación**: 2h
- **Razón**: Revisión de completitud sin lógica compleja; DeepSeek V4 Flash alcanza.
- **Dependencies**: F1.3.T2
- **Files**:
  - `apps/backend/src/feedback`
  - `apps/backend/src/follow-ups`
  - `apps/backend/src/leads`
  - `docs/adr/0012-feedback-post-atencion.md`

## F1.4 — Multi-tenant + auth + seguridad

Cero fuga entre tenants y datos de salud (PII/PHI) son críticos para el
piloto. Auditar con modelo premium y criterio de OWASP.

### F1.4.T1 — Audit aislamiento multi-tenant

Auditar que TODA query de negocio filtre por `clinicId` (vía `TenantContext` o
decorador), que guards de JWT + roles protejan cada ruta, y que la página
pública valide `slug` correctamente. Buscar activamente fugas cross-tenant
(acceso a dato de otro tenant por ID directo).

- **Modelo**: opencode/deepseek-v4-pro
- **Estimación**: 6h
- **Razón**: Riesgo de fuga de PHI entre tenants; DeepSeek V4 Pro para el análisis crítico.
- **Dependencies**: F1.1.T1
- **Files**:
  - `apps/backend/src/auth`
  - `apps/backend/src/common`
  - `apps/backend/src/public`
  - `apps/backend/src/clinics`
  - `docs/adr/0005-auth-mvp-y-deuda.md`

### F1.4.T2 — Audit webhook + WAHA + rate limiting

Auditar `whatsapp/webhook-auth.util.ts`, `webhook.controller.ts`,
`public/rate-limit.guard.ts` y el rate-limit del bot (ADR 0007): verificación
HMAC + token, rechazo 403, idempotencia de eventos, y que el rate-limit
proteja el presupuesto de LLM y el endpoint público anti-spam.

- **Modelo**: opencode/deepseek-v4-pro
- **Estimación**: 4h
- **Razón**: Superficie de ataque expuesta a internet; DeepSeek V4 Pro.
- **Dependencies**: F1.1.T1
- **Files**:
  - `apps/backend/src/whatsapp/webhook-auth.util.ts`
  - `apps/backend/src/whatsapp/webhook.controller.ts`
  - `apps/backend/src/public/rate-limit.guard.ts`
  - `docs/adr/0007-rate-limit-bot.md`
  - `docs/adr/0017-webhook-hmac-cookie-hardening.md`

### F1.4.T3 — Audit PII/PHI + logging + cookies

Auditar `common/logger/pii-redactor.ts`, config de cookies (`Strict`, HttpOnly,
Secure), consentimiento básico del paciente, y exposición de PHI en logs o
respuestas. Contra `docs/adr/0004-pii-y-compliance.md` y la deuda de cookies de
`docs/adr/0017`.

- **Modelo**: opencode/deepseek-v4-pro
- **Estimación**: 4h
- **Razón**: Compliance de datos de salud; DeepSeek V4 Pro.
- **Dependencies**: F1.1.T1
- **Files**:
  - `apps/backend/src/common/logger`
  - `apps/backend/src/auth`
  - `docs/adr/0004-pii-y-compliance.md`
  - `docs/adr/0017-webhook-hmac-cookie-hardening.md`

### F1.4.T4 — Audit SUPERADMIN + impersonation + AdminAudit

Auditar `admin/*` (impersonation con JWT temporal de 30 min, métricas
cross-tenant, suspensión/reactivación de clínicas) y el trail estructurado de
`AdminAudit` (ADR 0014 y 0016). Verificar que toda mutación bajo impersonation
quede auditada y que un token de impersonation no pueda usarse fuera de su
contexto/temporalidad.

- **Modelo**: opencode/deepseek-v4-pro
- **Estimación**: 5h
- **Razón**: Poder de operador SaaS con riesgo de abuso; DeepSeek V4 Pro.
- **Dependencies**: F1.1.T1
- **Files**:
  - `apps/backend/src/admin`
  - `docs/adr/0014-superadmin-como-operador-saas.md`
  - `docs/adr/0016-admin-audit-impersonation-trail.md`

## F1.5 — Web panel + página pública

Auditar UX, estados de UI, a11y, i18n y el flujo público. Verificar el cierre
de los hallazgos P0/P1/P2 de `docs/ux/*` (audit 2026-08-09).

### F1.5.T1 — Audit estados de UI + flujos del panel

Auditar el panel: estados loading/error/empty visibles, protección contra
doble submit, `ConfirmDialog` en vez de `confirm()` nativo, reply-lock y
staleness en conversaciones, y foco en modales. Verificar explícitamente el
cierre de los P0 de `docs/ux/*`.

- **Modelo**: opencode/gpt-5.5-codex
- **Estimación**: 6h
- **Razón**: UI con estados complejos; GPT-5.5.
- **Dependencies**: F1.1.T2
- **Files**:
  - `apps/web/src/components`
  - `apps/web/src/app/[locale]/panel`
  - `docs/ux`

### F1.5.T2 — Audit a11y + responsive + i18n es/pt

Auditar accesibilidad (focus trap, contrastes, labels, targets táctiles),
comportamiento responsive (tablas → cards en mobile, drawer de navegación) y
cobertura i18n es/pt. Verificar que no haya claves hardcodeadas en español ni
missing keys en `messages/*.json`.

- **Modelo**: opencode/gpt-5.5-codex
- **Estimación**: 5h
- **Razón**: A11y + i18n requieren criterio; GPT-5.5.
- **Dependencies**: F1.1.T2
- **Files**:
  - `apps/web/src/app`
  - `apps/web/src/i18n`
  - `apps/web/messages`

### F1.5.T3 — Audit página pública + endpoint público

Auditar `app/[locale]/agendar/[clinicSlug]` y `apps/backend/src/public`:
carga SSR por slug, formulario con consentimiento, selección de
servicio/profesional/slot, POST sin auth con rate-limit y anti-spam (Redis), y
que cree cita + recordatorios igual que el bot (sin duplicar lógica).

- **Modelo**: opencode/gpt-5.5-codex
- **Estimación**: 5h
- **Razón**: Flujo SSR + endpoint expuesto; GPT-5.5.
- **Dependencies**: F1.1.T2
- **Files**:
  - `apps/web/src/app/[locale]/agendar`
  - `apps/backend/src/public`
  - `docs/adr/0003-rate-limit-casero-vs-throttler.md`

### F1.5.T4 — Audit /admin + flujo de invitación + onboarding

Auditar `app/[locale]/admin/*` y el flujo `invite/[token]` + wizard de
onboarding first-time (notas 2026-08-11): crear clínica, invitar admin, aceptar
invitación, escanear QR WAHA. Revisión de completitud del flujo.

- **Modelo**: opencode-go/deepseek-v4-flash
- **Estimación**: 3h
- **Razón**: Recorrido de flujo sin lógica densa; DeepSeek V4 Flash alcanza.
- **Dependencies**: F1.5.T1
- **Files**:
  - `apps/web/src/app/[locale]/admin`
  - `apps/web/src/app/[locale]/invite`
  - `docs/onboarding-clinica.md`

## F1.6 — Mobile + infra + observabilidad

Verificar la app Flutter (gap conocido: `apps/mobile` es solo un README), el
deploy y la observabilidad del sprint.

### F1.6.T1 — Audit app Flutter vs PRD Fase 4

Confirmar el estado real de `apps/mobile` (hoy solo contiene `README.md`). Si
está vacía/stub, documentarlo como gap P0/P1 con el alcance que falta (login,
agenda del profesional, confirmar/bloquear, push) para una futura fase.

- **Modelo**: opencode-go/deepseek-v4-flash
- **Estimación**: 1h
- **Razón**: Verificación de existencia; DeepSeek V4 Flash alcanza.
- **Dependencies**: F1.1.T1
- **Files**:
  - `apps/mobile`
  - `docs/PRD.md`

### F1.6.T2 — Audit infra + deploy + parity de env

Auditar `docker-compose.yml`, `docker-compose.prod.yml`,
`docker-compose.coolify.yml`, Caddy, y la parity entre `.env.example` y las
variables que el código realmente lee. Verificar healthchecks de containers y
`start_period` del backend. Contra `docs/runbook-lanzamiento.md` y
`docs/deploy.md`.

- **Modelo**: opencode/gemini-3.1-pro
- **Estimación**: 4h
- **Razón**: Config infra con riesgo de deploy roto; Gemini 3.1 Pro.
- **Dependencies**: F1.1.T1
- **Files**:
  - `docker-compose.yml`
  - `docker-compose.prod.yml`
  - `docker-compose.coolify.yml`
  - `.env.example`
  - `docs/runbook-lanzamiento.md`
  - `docs/deploy.md`

### F1.6.T3 — Audit observabilidad + health checks

Auditar pipeline Pino + Axiom + Sentry (`common/logger`, `common/sentry`,
`health`), endpoint `/api/health/live` y checks WAHA, y que el redactor de PII
no rompa logs estructurados. Contra `docs/adr/0015` y `docs/specs/2026-08-18`
y `2026-08-19`.

- **Modelo**: opencode/gpt-5.5-codex
- **Estimación**: 4h
- **Razón**: Observabilidad cross-cutting; GPT-5.5.
- **Dependencies**: F1.1.T1
- **Files**:
  - `apps/backend/src/common/logger`
  - `apps/backend/src/common/sentry`
  - `apps/backend/src/health`
  - `apps/web/src/app/api/health`
  - `docs/adr/0015-pino-axiom-sentry.md`

## F1.7 — Testing + smoke E2E

Verificar que la lógica de negocio crítica esté cubierta por tests y que el
smoke E2E documentado siga siendo válido.

### F1.7.T1 — Inventario de cobertura de tests backend

Generar inventario de tests `.spec.ts` por módulo (qué hay, qué falta) y
cruzar contra las reglas de negocio críticas de `SPEC.md` §2: disponibilidad,
transiciones, recordatorios, bot, tenant isolation. Listar módulos sin tests.

- **Modelo**: opencode-go/deepseek-v4-flash
- **Estimación**: 2h
- **Razón**: Inventario mecánico; DeepSeek V4 Flash alcanza.
- **Dependencies**: F1.1.T1
- **Files**:
  - `apps/backend/src`

### F1.7.T2 — Audit de calidad de tests vs escenarios Gherkin

Mapear los escenarios Gherkin de `SPEC.md` §3 contra los tests existentes
(`scheduling.service.spec.ts`, `appointment-status.util.spec.ts`,
`bot.service.spec.ts`, etc.). Detectar escenarios sin cobertura y verificar
que exista al menos un test que falle ante fuga cross-tenant.

- **Modelo**: opencode/gpt-5.5-codex
- **Estimación**: 4h
- **Razón**: Cruce de escenarios con criterio; GPT-5.5.
- **Dependencies**: F1.7.T1
- **Files**:
  - `apps/backend/src`
  - `docs/SPEC.md`

### F1.7.T3 — Validar smoke E2E contra la app actual

Revisar `docs/smoke-e2e.md` contra la app real y detectar pasos rotos,
endpoints renombrados o escenarios obsoletos. Producir la lista de correcciones
necesarias para que el checklist sea ejecutable antes del canary.

- **Modelo**: opencode-go/deepseek-v4-flash
- **Estimación**: 2h
- **Razón**: Verificación de checklist; DeepSeek V4 Flash alcanza.
- **Dependencies**: F1.1.T1
- **Files**:
  - `docs/smoke-e2e.md`
  - `apps/backend/src`
  - `apps/web/src/app`

## F1.8 — Síntesis y tareas de finalización

Consolidar los reportes de toda la fase y derivar el plan de finalización.

### F1.8.T1 — Consolidar findings en reporte priorizado

Leer los reportes de `docs/auditoria/` (F1.1–F1.7), deduplicar, y consolidar
en un único reporte `docs/auditoria/RESUMEN-finalizacion.md` ordenado por
severidad (P0 → P1 → P2) con mapeo a artefacto y recomendación. Incluir un
juicio global de "go / no-go" para el canary de 40 clínicas.

- **Modelo**: opencode/deepseek-v4-pro
- **Estimación**: 4h
- **Razón**: Síntesis estratégica de muchos inputs; DeepSeek V4 Pro.
- **Dependencies**: F1.1.T1, F1.1.T2, F1.1.T3, F1.2.T1, F1.2.T2, F1.2.T3, F1.3.T1, F1.3.T2, F1.3.T3, F1.4.T1, F1.4.T2, F1.4.T3, F1.4.T4, F1.5.T1, F1.5.T2, F1.5.T3, F1.5.T4, F1.6.T1, F1.6.T2, F1.6.T3, F1.7.T1, F1.7.T2, F1.7.T3
- **Files**:
  - `docs/auditoria`

### F1.8.T2 — Derivar spec de finalización (F2) desde los findings

A partir de `docs/auditoria/RESUMEN-finalizacion.md`, escribir
`specs/f2-finalizacion.md` en formato atomizer (fase → paquete → task) con las
tareas concretas para cerrar los P0/P1 y la deuda P2 priorizada. Cada task debe
heredar severidad, artefacto y paths del finding origen. NO ejecutar código:
solo producir el spec.

- **Modelo**: opencode/deepseek-v4-pro
- **Estimación**: 5h
- **Razón**: Traducción findings→spec requiere juicio; DeepSeek V4 Pro.
- **Dependencies**: F1.8.T1
- **Files**:
  - `docs/auditoria/RESUMEN-finalizacion.md`
  - `specs/f2-finalizacion.md`
