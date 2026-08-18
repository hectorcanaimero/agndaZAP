# Arquitectura — Showly

## Visión de alto nivel

```
┌─────────────┐     mensajes      ┌──────────────┐
│  WhatsApp   │◄─────────────────►│     WAHA     │  (Docker, no oficial)
│  (paciente) │                   │  webhook out │
└─────────────┘                   └──────┬───────┘
                                         │ POST /webhooks/waha
                                         ▼
                    ┌────────────────────────────────────────┐
                    │            Backend NestJS               │
                    │                                         │
                    │  WhatsAppModule  ← webhook + envío      │
                    │  ConversationModule ← estado por chat   │
                    │  BotModule ← intención (LLM) + flujos    │
                    │  SchedulingModule ← disponibilidad/citas │
                    │  RemindersModule ← jobs anti no-show     │
                    │  KnowledgeModule ← RAG FAQ (pgvector)    │
                    │  Clinics/Auth ← multi-tenant + RBAC      │
                    └───────┬─────────────────┬───────────────┘
                            │                 │
                    ┌───────▼──────┐   ┌──────▼───────┐
                    │  PostgreSQL  │   │  Redis +     │
                    │  + pgvector  │   │  BullMQ      │
                    └──────────────┘   └──────────────┘
                            ▲                 ▲
        ┌───────────────────┘                 │ push/notif
        │                                      │
┌───────┴────────┐                    ┌────────┴────────┐
│ Panel Next.js  │                    │  App Flutter    │
│ (recepción)    │                    │  (profesional)  │
└────────────────┘                    └─────────────────┘
```

## Organización del código (monorepo pnpm)

- `apps/backend` (NestJS), `apps/web` (Next.js: panel + página pública), `apps/mobile` (Flutter).
- `packages/shared`: tipos TS compartidos backend↔web (contratos de API).
- La app Flutter vive en el monorepo pero fuera del workspace pnpm. Ver [ADR 0001](./adr/0001-monorepo.md).

## Canales de entrada (dos formas de agendar)

1. **WhatsApp** (bot vía WAHA) — el flujo conversacional.
2. **Página pública `/agendar/[clinicSlug]`** (Next.js SSR) — el paciente registra sus datos
   (nombre, teléfono, motivo), elige servicio/profesional/slot y crea la cita. Consume el mismo
   `SchedulingService` y dispara los mismos recordatorios. Debe tener rate-limit y validación
   anti-spam (es público, sin auth).

## Stack (reutiliza ~70% de Blog Condor)

| Capa | Tecnología | Reuso |
|------|-----------|-------|
| Backend | NestJS 10 + Prisma | Base, auth, patrón Redis, LLM router |
| DB | PostgreSQL 15 + pgvector | Nuevo schema, mismo motor |
| Cola/Jobs | Redis 7 + BullMQ | Patrón ya usado (workers) |
| WhatsApp | WAHA (Docker) | Nuevo |
| LLM | Router multi-provider (DeepSeek primario, Gemini fallback) | Reuso directo del router |
| RAG FAQ | Embeddings + pgvector | Patrón nuevo, motor conocido |
| Panel | Next.js 15 + Tailwind + shadcn/ui + next-intl | Reuso del admin shell |
| App | Flutter (Dart) | Tu stack móvil |
| Infra | Docker Compose (dev), Hetzner (prod) | Reuso |

## Componentes del backend

### WhatsAppModule
- `POST /webhooks/waha`: recibe eventos de WAHA (mensaje entrante, ack, estado de sesión).
- `WahaService.sendText(session, chatId, text)`: envía mensajes.
- Detecta desconexión de sesión → evento interno → alerta en panel.
- Firma/valida el webhook (token compartido) para que nadie externo inyecte mensajes.

### ConversationModule
- Estado por chat: a qué clínica pertenece, en qué paso del flujo va (FSM), si está en modo humano.
- Guarda historial de mensajes (para contexto del LLM y para la bandeja del panel).

### BotModule
- **Detección de intención** con LLM barata: {agendar, reprogramar, cancelar, confirmar, pregunta_faq, hablar_humano, otro}.
- **Máquina de estados** del flujo de agendamiento (elegir servicio → profesional → slot → confirmar).
- Siempre pide **confirmación explícita** antes de crear/cancelar.
- Si intención = pregunta_faq → KnowledgeModule (RAG). Si no encuentra → handoff.

### SchedulingModule (núcleo)
- **Motor de disponibilidad:** dado servicio + profesional + rango, calcula slots libres respetando: horario de atención, duración del servicio, buffers, feriados/bloqueos, TZ de la clínica, y citas ya tomadas.
- CRUD de citas con estados y transiciones controladas.
- Idempotencia: no crear dos citas para el mismo slot (constraint + verificación).

### RemindersModule (el diferenciador anti no-show)
- Al crear/confirmar una cita, programa jobs BullMQ con `delay` calculado (24h y 3h antes).
- Cada job envía el recordatorio pidiendo confirmación.
- Job de "umbral sin confirmar": si no hay respuesta, marca EN_RIESGO + alerta.
- Cancelar/reprogramar una cita cancela/reprograma sus jobs.
- Registra el resultado final (asistió/no-show) para métricas.

### KnowledgeModule
- FAQ por clínica → chunks → embeddings → pgvector.
- Query: embedding de la pregunta → top-k → LLM responde citando la FAQ. Sin invención: si no hay match, handoff.

### Clinics / Auth
- Multi-tenant: `tenantId` (clinicId) en todas las tablas y en el JWT.
- RBAC: SUPERADMIN, CLINIC_ADMIN (recepción), PROFESSIONAL.
- Cada clínica tiene su sesión WAHA (nombre de instancia) + su TZ + su config de recordatorios.
- `Clinic.status` (`ACTIVE | SUSPENDED | ARCHIVED`) controla el acceso: `AuthService.login()` rechaza con 403 si la clínica no está `ACTIVE` (excepto SUPERADMIN, que no tiene clínica propia).

### Área SaaS Admin (módulo `admin/`)

Panel de operación de la plataforma para el rol SUPERADMIN. Ruta base de API: `/api/admin/*`. Path frontend: `/[locale]/admin/*`.

#### Estructura del módulo backend

```
apps/backend/src/admin/
├── admin.module.ts
├── admin-audit.interceptor.ts   # intercepta toda acción no-read; persiste en AdminAudit
├── admin-audit.service.ts       # logAction() — helper reusable internamente
├── admin-clinics.controller.ts  # CRUD de tenants + suspend/reactivate
├── admin-clinics.service.ts
├── admin-metrics.controller.ts  # GET /admin/metrics/overview — cross-tenant
├── admin-metrics.service.ts
├── admin-audit.controller.ts    # GET /admin/audit — log paginado con filtros
└── impersonation.controller.ts  # POST /admin/clinics/:id/impersonate
    impersonation.service.ts
```

Todos los controllers llevan `@Roles('SUPERADMIN')` a nivel de clase. El `AdminAuditInterceptor` registra IP + User-Agent + payload contextual en `AdminAudit` para toda acción de escritura.

#### Flujo de impersonation

Ver diagrama detallado en [[notas/2026-08-14-impersonation-flow]].

1. `POST /api/admin/clinics/:id/impersonate` valida que la clínica esté `ACTIVE`.
2. Genera JWT temporal (30 min) con payload `{ sub, role: 'CLINIC_ADMIN', clinicId: X, impersonatedBy: sub }`.
3. El frontend guarda el JWT original en la cookie `showly_admin_token` y sobrescribe `showly_token` con el temporal.
4. Redirect a `/panel/dashboard`. `PanelShell` detecta `jwt.impersonatedBy` y renderiza `ImpersonationBanner`.
5. Al hacer click en "Volver al Admin": restaurar `showly_token` desde `showly_admin_token`, redirect a `/admin/dashboard`.

#### Tabla AdminAudit

Toda acción de escritura del SUPERADMIN queda en `AdminAudit`: `actorUserId`, `action` (enum `AdminAction`), `targetType`, `targetId`, `metadata` (JSON), `ip`, `userAgent`, `createdAt`. Índices sobre `(actorUserId, createdAt)` y `(targetType, targetId, createdAt)`.

#### Frontend (`apps/web/src/app/[locale]/admin/*`)

| Página | Ruta |
|---|---|
| Dashboard cross-tenant | `/admin/dashboard` |
| Lista de clínicas + acciones | `/admin/clinics` |
| Detalle de clínica + impersonar | `/admin/clinics/[id]` |
| Log de auditoría | `/admin/audit` |

`AdminShell.tsx` es el nav lateral equivalente a `PanelShell.tsx` del panel de clínica. `ImpersonationBanner` se renderiza dentro de `PanelShell` cuando el JWT activo tiene el claim `impersonatedBy`.

#### Deprecation del override `?clinicId=xxx`

El patrón `SUPERADMIN + ?clinicId=xxx` en `tenant-context.util.ts` está **eliminado**. `assertClinicScope` ahora tira 400 con "SUPERADMIN debe impersonar una clínica primero" si no hay `clinicId` en el JWT. Los controllers de panel (`services`, `appointments`, `business-hours`, `clinics`, `conversations`, `faq`, `dashboard`, `feedback`, `time-off`, `whatsapp-panel`) no aceptan ni leen el parámetro. Ver [[adr/0014-superadmin-como-operador-saas]].

## Estados de la cita (máquina de estados)

```
PENDIENTE ──confirma──► CONFIRMADA ──día de la cita──► ATENDIDA
    │                        │
    │                        ├──no confirma a tiempo──► EN_RIESGO ──► (recepción actúa)
    │                        │
    └──cancela──► CANCELADA  └──cancela/no asiste──► CANCELADA / NO_SHOW
```

## Modelo multi-tenant y aislamiento
- Toda query pasa por un guard/middleware que inyecta `clinicId` del token.
- Constraint a nivel DB donde aplique (ej. slot único por clínica+profesional+hora).
- WAHA: una sesión por clínica; el webhook resuelve la clínica por el nombre de sesión.

## Seguridad y privacidad (datos de salud)
- Cifrado en tránsito (TLS) en todos los endpoints.
- Minimizar PII: guardar solo nombre + teléfono + motivo breve; no historia clínica.
- Logs sin PII sensible.
- Consentimiento básico: primer contacto informa que es un canal automatizado de la clínica.
- Secretos (WAHA token, API keys LLM) en variables de entorno, nunca en el repo.

## Decisiones abiertas (para ADR posterior)
- ¿Confirmación de cita crea PENDIENTE o CONFIRMADA por defecto? (config por clínica).
- ¿Seña/pago para reforzar anti no-show? (fase 2).
- ¿Un número WAHA por clínica o compartido con enrutamiento? (MVP: uno por clínica).
