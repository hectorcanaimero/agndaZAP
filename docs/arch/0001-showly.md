---
type: arch
project_id: showly
version: 0.1
depends_on:
  - PRD.md
  - SPEC.md
  - ARCHITECTURE.md
  - adr/0001-monorepo.md
  - adr/0002-waha-no-oficial.md
  - adr/0004-pii-y-compliance.md
  - adr/0005-auth-mvp-y-deuda.md
  - adr/0007-rate-limit-bot.md
  - adr/0014-superadmin-como-operador-saas.md
  - adr/0015-pino-axiom-sentry.md
  - adr/0017-webhook-hmac-cookie-hardening.md
consumed_by:
  - archify
generated_by: orch-arch
generated_at: 2026-08-22
title: Arquitectura Showly — Agendamiento por WhatsApp + anti no-show
---

# ARCH: Showly — Agendamiento por WhatsApp + anti no-show

## 1. Contexto

Showly es un SaaS multi-tenant de agendamiento para clínicas y consultorios en
LATAM. El problema: las clínicas pierden 20–30% de ingresos por no-shows y por
gestionar citas a mano por WhatsApp. El producto resuelve esto con (1) un bot
de WhatsApp que agenda conversacionalmente, (2) un motor de recordatorios anti
no-show con confirmación del paciente, y (3) un panel web + app móvil para
gestionar la operación.

El sistema está en **fase final pre-lanzamiento** (piloto de 40 clínicas,
canary 2026-08-25). Esta arquitectura documenta el estado real implementado:
backend NestJS con ~24 módulos, web Next.js (panel + página pública + admin
SaaS), motor de disponibilidad, recordatorios BullMQ, RAG FAQ con pgvector, y
un área de operador SaaS (SUPERADMIN + impersonation + auditoría).

Ángulos técnicos clave que condicionan todo el diseño:
- **Multi-tenant desde el día uno**: `clinicId` en toda entidad y en el JWT;
  cero fuga entre tenants es requisito de seguridad de datos de salud.
- **WhatsApp no oficial (WAHA)**: una sesión por clínica; resiliencia ante
  desconexión y baneo es un riesgo de producto.
- **Costo por conversación < $0.01**: LLM barata con router multi-provider,
  cache y confirmaciones deterministas antes de invocar el modelo.
- **Zona horaria por clínica**: toda lógica de agenda/recordatorios en Luxon
  con la TZ del tenant; nunca `Date` naive.

## 2. Decisiones de arquitectura (ADR-like)

### ADR-01: Monorepo pnpm + Flutter fuera del workspace
- **Contexto**: backend, web y shared comparten contratos TS; Flutter tiene toolchain Dart aparte.
- **Decisión**: monorepo pnpm con `apps/{backend,web,mobile}` y `packages/shared`; Flutter vive en el repo pero fuera del workspace pnpm.
- **Alternativas descartadas**: Nx/Turborepo (overkill para 3 apps); repos separados (rompe el shared de contratos).
- **Consecuencias**: un solo `pnpm install`, contratos compartidos vía `@showly/shared`; Flutter se maneja con su propio toolchain.

### ADR-02: WAHA (no oficial) para WhatsApp
- **Contexto**: la API oficial de WhatsApp (Cloud API) es cara y de aprobación lenta para el MVP.
- **Decisión**: WAHA self-hosted (Docker), una sesión por clínica, engine Baileys (NOWEB).
- **Alternativas descartadas**: WhatsApp Cloud API oficial (fase posterior), Evolution API.
- **Consecuencias**: habilita el MVP rápido y barato; asume riesgo de baneo (mitigado con números dedicados + volumen moderado + plan de migración oficial).

### ADR-03: Motor de disponibilidad propio con constraint atómico
- **Contexto**: el doble-booking es el error fatal del dominio; debe ser imposible por diseño, no por validación suelta.
- **Decisión**: `AvailabilityService` calcula slots (BusinessHour + solapamiento + TimeOff + TZ + buffer) y la creación valida atómicamente con `@@unique([professionalId, startAt])` + transacción.
- **Alternativas descartadas**: solo validación en app (race condition); librería de calendario externa.
- **Consecuencias**: el constraint DB es la última línea de defensa; el motor es testable y puro en Luxon/TZ.

### ADR-04: Multi-tenant por `clinicId` inyectado (zero-trust)
- **Contexto**: datos de salud; una fuga entre tenants es un incidente grave.
- **Decisión**: `clinicId` en toda tabla y en el JWT; guard de query inyecta el `clinicId` del token; sin override `?clinicId=` (eliminado en ADR 0014).
- **Alternativas descartadas**: row-level security de Postgres (más robusto pero no implementado en el MVP); esquemas por tenant.
- **Consecuencias**: aislamiento a nivel aplicación + constraints DB; RLS queda como hardening futuro.

### ADR-05: Confirmación determinista antes del LLM
- **Contexto**: el LLM malinterpreta; confirmar/cancelar debe ser predecible y barato.
- **Decisión**: las confirmaciones (`sí`/`cancelar`/`reagendar`) se resuelven por regla determinista ANTES de invocar el LLM; el bot nunca crea/cancela sin confirmación explícita del paciente.
- **Alternativas descartadas**: todo por LLM (costo + latencia + errores).
- **Consecuencias**: ahorro de tokens y comportamiento predecible; el LLM queda para intención y FAQ.

### ADR-06: SUPERADMIN como operador SaaS vía impersonation
- **Contexto**: el operador necesita gestionar tenants sin operar endpoints de clínica directamente.
- **Decisión**: rol `SUPERADMIN` con panel `/admin/*`; impersonation con JWT temporal de 30 min (`impersonatedBy` en el claim); toda mutación queda en `AdminAudit`.
- **Alternativas descartadas**: override `?clinicId=` (eliminado — riesgo de fuga); credenciales compartidas.
- **Consecuencias**: operación auditable y acotada en tiempo; el trail de `AdminAudit` es requisito de compliance.

### ADR-07: RAG FAQ con pgvector + strip de markdown
- **Contexto**: respuestas a preguntas frecuentes sin inventar (grounding por clínica).
- **Decisión**: FAQ → chunks → embeddings en pgvector; query por embedding → top-k → LLM responde citando; si no hay match, handoff a humano.
- **Alternativas descartadas**: fine-tune por clínica (costoso); búsqueda full-text simple (sin semántica).
- **Consecuencias**: respuestas grounded por tenant; `title` opcional y strip de markdown antes del embedding (ADR 0009).

### ADR-08: Observabilidad Pino + Axiom + Sentry + health checks
- **Contexto**: piloto de 40 clínicas necesita alerta temprana de fallos y trazabilidad de errores.
- **Decisión**: logs estructurados Pino con redactor de PII → Axiom; errores → Sentry (backend + web, release-tagged); health checks `/api/health/live` (DB + Redis + WAHA) para BetterStack.
- **Alternativas descartadas**: Loki self-hosted (deuda post-piloto si Axiom se encarece).
- **Consecuencias**: visibilidad end-to-end; el redactor de PII garantiza que los logs no filtren datos de salud.

### ADR-09: Webhook WAHA con HMAC + token
- **Contexto**: `POST /webhooks/waha` es un endpoint público que inyecta mensajes; debe ser imposible de spoofear.
- **Decisión**: verificación HMAC + token compartido; rechazo 403 sin credencial; cookies `SameSite=Strict` + `HttpOnly` + `Secure`.
- **Alternativas descartadas**: solo token (insuficiente), IP allowlist (frágil).
- **Consecuencias**: superficie pública protegida; idempotencia de eventos queda como gap detectado en auditoría (ver §9).

## 3. Componentes del sistema

| Componente | Responsabilidad | Interactúa con |
|------------|-----------------|----------------|
| **WAHA** (Docker, Baileys) | Sesión WhatsApp por clínica; envía/recibe mensajes; emite webhook | Webhook (POST /webhooks/waha) |
| **WhatsAppModule** | Recibir eventos WAHA (HMAC+token); `WahaService.sendText`; detectar desconexión | Conversation, Bot |
| **ConversationModule** | Estado por chat: `flowStep`/`flowData` (FSM retomable), historial, modo HUMAN | Bot, Panel |
| **BotModule** | Detección de intención (LLM), FSM de agendamiento, confirmaciones deterministas, handoff | Conversation, Scheduling, Knowledge, LLM |
| **SchedulingModule** | Motor de disponibilidad; CRUD de citas; transiciones de estado; creación atómica | Bot, Public API, Reminders, DB |
| **RemindersModule** | Jobs BullMQ anti no-show (24h/3h); check-risk; EN_RIESGO; resultado no-show | Scheduling, Redis, WAHA |
| **KnowledgeModule** | RAG FAQ: chunks → embeddings → pgvector; query top-k | Bot, DB |
| **PublicModule** | Endpoint público `/public/clinics/:slug` + rate-limit anti-spam | Página pública, Scheduling |
| **Auth/Clinics** | JWT + RBAC (`SUPERADMIN`/`CLINIC_ADMIN`/`PROFESSIONAL`); estado de clínica; TZ | Panel, DB |
| **AdminModule** (`/admin/*`) | CRUD tenants, impersonation (JWT 30min), métricas cross-tenant, AdminAudit | Admin Panel, DB |
| **Panel Web** (Next.js) | Panel de recepción: agenda, bandeja, dashboard, FAQ, servicios | Auth, backend |
| **Página pública** (Next.js SSR) | `/agendar/[clinicSlug]`: form paciente + slot + crear cita | Public API |
| **Admin Panel** (Next.js) | `/admin/*`: tenants, impersonation, auditoría | Admin API |
| **PostgreSQL 15 + pgvector** | Datos multi-tenant + embeddings FAQ | Todos los módulos |
| **Redis 7 + BullMQ** | Cola de recordatorios/follow-ups | Reminders, Follow-ups |
| **LLM Router** | DeepSeek (primario) + Gemini (fallback), fetch nativo | Bot, Knowledge |
| **Observability** | Pino (logs) → Axiom; Sentry (errores); health checks | Todos |

## 4. Flujo de datos

### Happy path — agendar por WhatsApp
1. Paciente escribe al WhatsApp de la clínica → WAHA emite `POST /webhooks/waha` (HMAC).
2. Webhook resuelve la clínica por sesión → Conversation carga el estado del chat.
3. Bot detecta intención `agendar` (LLM barata) → FSM: `ASK_SERVICE → ASK_PROFESSIONAL → ASK_SLOT → CONFIRM`.
4. Bot pide slots a Scheduling (`AvailabilityService`, en TZ de la clínica).
5. Paciente confirma → Scheduling crea `Appointment` (validación atómica de slot) → programa recordatorios.
6. Reminders agenda jobs BullMQ con delay (24h/3h antes); al disparar, WAHA envía el mensaje pidiendo confirmación.
7. Paciente responde "SÍ" (determinista) → cita `CONFIRMADA`; "CANCELAR" → `CANCELADA` + slot liberado + jobs eliminados; sin respuesta → `EN_RIESGO` + alerta en panel.

### Flujo alternativo — página pública
`Paciente web → /agendar/[clinicSlug] (SSR) → Public API (rate-limit) → Scheduling → Reminders`. Reusa el mismo `SchedulingService` y dispara los mismos recordatorios; no duplica lógica de creación.

### Flujo SaaS — operación
`SUPERADMIN → /admin/* → Admin API → impersonation (JWT 30min) → opera como CLINIC_ADMIN → AdminAudit registra toda mutación`.

Ver diagrama interactivo: `arch/0001-showly.diagrams.html`

## 5. Contratos e interfaces

Rutas de negocio con JWT + `clinicId` + `role` (prefijo `/api`). Públicas sin auth marcadas.

### API: Login
- **Método**: `POST /api/auth/login` → `{ email, password }` → `{ accessToken }`
- **Errores**: 403 si `Clinic.status != ACTIVE` (excepto SUPERADMIN)

### API: Disponibilidad
- **Método**: `GET /api/availability?serviceId&professionalId&from&days` → `Slot[]`
- **Nota**: calculada en TZ de la clínica; excluye solapamientos, TimeOff y pasado.

### API: Crear cita
- **Método**: `POST /api/appointments` → valida slot libre → `Appointment` + programa recordatorios
- **Errores**: 409/422 si slot tomado (constraint único `(professionalId, startAt)`)

### API: Transición de estado
- **Método**: `PATCH /api/appointments/:id/status`
- **Regla**: FSM `PENDIENTE → CONFIRMADA|EN_RIESGO|CANCELADA`; `CONFIRMADA → ATENDIDA|CANCELADA|NO_SHOW`; `EN_RIESGO → CONFIRMADA|CANCELADA|NO_SHOW|ATENDIDA`. Otra transición → 422.

### API: Pública (sin auth)
- **Método**: `POST /api/public/appointments` (o `/public/clinics/:slug/...`) — con rate-limit anti-spam (Redis)
- **Errores**: 429 por rate-limit

### API: Webhook (público, HMAC)
- **Método**: `POST /webhooks/waha` — eventos WAHA; 403 sin HMAC/token

### API: Impersonation (SUPERADMIN)
- **Método**: `POST /api/admin/clinics/:id/impersonate` → JWT temporal 30min con `impersonatedBy`

### Evento: Recordatorio disparado
- **Publicado por**: Reminders (BullMQ job)
- **Consumido por**: WAHA (envío) → respuesta del paciente → transición de cita

## 6. Modelo de datos

Entidades principales (Prisma, todas con `clinicId` salvo entidades SaaS):

| Entidad | Campos clave | Constraint / nota |
|---------|-------------|-------------------|
| `Clinic` | `slug`, `name`, `timezone`, `autoConfirm`, `reminderOffsetsH`, `currency`, `status` | `status: ACTIVE\|SUSPENDED\|ARCHIVED`; bloquea login si no ACTIVE |
| `User` | `email`, `passwordHash`, `role`, `clinicId?` | `role: SUPERADMIN\|CLINIC_ADMIN\|PROFESSIONAL`; SUPERADMIN sin clínica |
| `Professional` | `name`, `clinicId`, `profileFields` | feed iCal (ADR 0011) |
| `Service` | `name`, `durationMin`, `bufferMin`, `price`, `clinicId` | paso de slot = `durationMin + bufferMin` |
| `BusinessHour` | `professionalId?`, `dayOfWeek`, `open/close`, `clinicId` | herencia: profesional define o usa el de la clínica |
| `TimeOff` | `professionalId`, `start/end`, `clinicId` | bloqueos/feriados |
| `Patient` | `name`, `phone`, `clinicId` | PII mínimo (ADR 0004) |
| `Appointment` | `patientId`, `professionalId`, `serviceId`, `startAt`, `status` | `@@unique([professionalId, startAt])`; FSM de estados |
| `Reminder` | `appointmentId`, `jobId`, `scheduledAt`, `status` | `jobId` determinista (`reminder:{id}`, `risk:{apptId}`) |
| `Conversation` | `clinicId`, `contactId`, `flowStep`, `flowData`, `state` | `state: BOT\|HUMAN\|NEEDS_HUMAN`; FSM retomable |
| `Message` | `conversationId`, `direction`, `body` | historial para contexto LLM + bandeja |
| `FaqChunk` | `clinicId`, `title?`, `content`, `embedding` | embedding en pgvector (ADR 0009) |
| `Feedback` | `appointmentId`, `rating`, `comment` | post-atención (ADR 0012) |
| `Lead` | `clinicId`, `phone`, `source`, `status` | marketing/reactivación |
| `AdminAudit` | `actorUserId`, `action`, `targetType`, `targetId`, `metadata`, `ip`, `userAgent` | trail de impersonation (ADR 0016) |
| `Invitation` | `email`, `role`, `token`, `expiresAt` | alta de admin de clínica |

## 7. Consideraciones no-funcionales

### 7.1 Performance
- P95 < 500ms en endpoints del panel (objetivo de canary, monitoreado en Axiom).
- Costo por conversación < $0.01 (LLM barata + determinismo + cache).

### 7.2 Seguridad
- AuthN: JWT; AuthZ: guards de roles + inyección de `clinicId` (zero-trust).
- PII: minimización (solo nombre+teléfono+motivo), redactor de PII en logs, TLS en tránsito.
- Webhook: HMAC + token (ADR 0017); cookies `Strict`+`HttpOnly`+`Secure`.
- Rate-limit: bot (presupuesto LLM, ADR 0007) + endpoint público (anti-spam, ADR 0003).
- Impersonation: JWT temporal 30 min + `AdminAudit` (ADR 0014/0016).

### 7.3 Observabilidad
- Logs: Pino estructurado → Axiom (dataset `showly-prod`); redactor de PII activo.
- Errores: Sentry (backend + web, release-tagged, sourcemaps).
- Health: `/api/health/live` (instantáneo) y `/api/health` (DB+Redis+WAHA) → BetterStack.

### 7.4 Confiabilidad
- Idempotencia: creación de cita (constraint único) y recordatorios (`jobId` determinista).
- Reintentos: envío WAHA con backoff; detección de desconexión de sesión.
- Deduplicación de eventos de webhook: **gap detectado en auditoría** (ver §9).
- Respaldo de jobs: cancelar/reprogramar cita elimina todos sus jobs.

## 8. Plan de rollout técnico

- **Migrations**: additive-only (`prisma migrate deploy`); enum values + columnas + índices; rollback no destructivo.
- **Build/deploy**: Docker Compose prod + Coolify (Hetzner); release tag de Sentry inyectado pre-build.
- **Canary**: 1–2 clínicas amigables 48h → go/no-go → onboarding en tandas de 10/día.
- **Verificación**: smoke tests post-deploy (health → auth → observabilidad → webhook auth) en orden.

## 9. Riesgos técnicos + mitigación

| Riesgo | Impacto | Mitigación |
|--------|---------|------------|
| Baneo de número por WAHA (no oficial) | Alto | Números dedicados, volumen moderado, plan de migración a API oficial |
| Fuga de PHI entre tenants | Crítico | `clinicId` en todo + guard + constraint DB; RLS como hardening futuro |
| LLM malinterpreta y agenda mal | Medio | Confirmación explícita antes de crear; handoff fácil |
| Cancelar/reprogramar por bot incompleto | Medio | **Gap P1**: `Intent.CANCELAR` sin case funcional; `REPROGRAMAR` no mueve la cita |
| Webhook sin idempotencia (eventos duplicados) | Medio | **Gap P1**: falta deduplicación de eventos WAHA |
| Disponibilidad no valida `clinicId` de servicio/profesional | Alto | **Gap P1**: el servicio acepta IDs sin verificar pertenencia al tenant |
| Alertas WAHA sin notificación al panel | Medio | **Gap P2**: health checks existen pero no emiten evento al panel |
| Cuenta ChatGPT no soporta `gpt-5.5-codex` | Bajo | Usar `gpt-5.6-luna` (route verificado) en el router de orch |

## 10. Cambios en el codebase

Estado actual implementado (estructura de módulos backend, `apps/backend/src`):

| Path | Tipo | Descripción |
|------|------|-------------|
| `scheduling/` | M | Motor de disponibilidad + `SchedulingService` (core) |
| `reminders/` | M | Processor + service BullMQ anti no-show |
| `bot/` | M | FSM + `intent.service` (LLM) |
| `conversations/` | M | Estado de chat + handoff |
| `whatsapp/` | M | Webhook HMAC + `WahaService` + health-monitor |
| `knowledge/` + `faq/` | M | RAG FAQ pgvector |
| `auth/` + `clinics/` | M | JWT, RBAC, TenantContext, estado de clínica |
| `admin/` | M | SUPERADMIN: CRUD tenants, impersonation, AdminAudit, métricas |
| `public/` | M | Endpoint público + rate-limit guard + slug pipe |
| `common/logger` + `common/sentry` | M | Pino + redactor PII + Sentry |
| `health/` | M | Health checks live/full |
| `follow-ups/`, `feedback/`, `leads/`, `invitations/`, `mail/`, `patients/`, `professionals/`, `services/`, `business-hours/`, `time-off/`, `dashboard/` | M | Módulos de dominio |
| `apps/web/src/app/[locale]/...` | M | Panel, pública, admin, invite |
| `apps/mobile/` | N | Flutter: **no construida** (solo README) — PRD Fase 4 |
| `prisma/schema.prisma` | M | 23 modelos + enums + migrations |

## 11. Fases sugeridas (input para orch-spec)

Fases de **finalización** (el core ya está implementado; esto cierra los gaps
de la auditoría de finalización, ver `specs/f1-auditoria-finalizacion.md`):

- **F1 — Seguridad y multi-tenant**: validar `clinicId` en disponibilidad, idempotencia de webhook, alertas WAHA al panel.
- **F2 — Cierre de flujo de bot**: cancelar/reprogramar por lenguaje natural, consentimiento/LID (`ASK_PHONE`).
- **F3 — Contratos y docs**: sincronizar `SPEC.md` con ADRs 0014–0017, rutas declaradas vs reales (`/api/clinics` vs `/api/admin/clinics`).
- **F4 — App Flutter + deuda post-piloto**: app móvil (PRD Fase 4), cookies HttpOnly, push.

## 12. Referencias

- PRD: `docs/PRD.md`
- SPEC: `docs/SPEC.md`
- Arquitectura (narrativa): `docs/ARCHITECTURE.md`
- ADRs: `docs/adr/0001`–`0017`
- Diagrama interactivo: `docs/arch/0001-showly.diagrams.html`
- Auditoría de finalización: `specs/f1-auditoria-finalizacion.md`
