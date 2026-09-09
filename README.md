# Showly

> Agendamiento por WhatsApp con recordatorios anti no-show para clínicas y consultorios.

Sistema multi-tenant que combina:

- Un **bot de WhatsApp** que agenda, reagenda y cancela citas conversando
  con el paciente (via WAHA + LLM barata).
- Un **motor anti no-show** que envía recordatorios programados (24h y
  3h antes por default), pide confirmación explícita y marca las citas
  como EN_RIESGO cuando el paciente no responde.
- Un **panel web** para recepción (agenda visual, bandeja de
  conversaciones, pacientes, dashboard de no-show rate, editor de FAQ,
  feedback post-atención, conexión WAHA por QR).
- Una **página pública** `/agendar/[clinicSlug]` para que el paciente
  agende desde la web sin bajar app (y un link con token que el bot manda
  cuando no puede cerrar la cita por chat, ver [[docs/adr/0018-scheduling-link-wa]]).
- Un **panel de operador SaaS** (`/admin/*`, rol SUPERADMIN) para dar de
  alta clínicas, invitar a su admin, suspender/reactivar, impersonar con
  auditoría y ver leads del landing.
- (Fase 4, post-piloto) Una **app Flutter** para el profesional (agenda
  del día + push). Hoy `apps/mobile` es un stub; el panel responsive cubre
  al profesional en el piloto.

---

## Problema y objetivo

Las clínicas y consultorios pequeños/medianos en LATAM pierden entre
**20% y 30% de sus ingresos** por inasistencias (no-shows) y por gestionar
las citas manualmente a través de WhatsApp. La recepcionista responde
mensajes, anota en agenda de papel o Excel, y nadie confirma
sistemáticamente las citas.

**Objetivo del MVP**: que una clínica pueda ofrecer agendamiento
automático por WhatsApp, con confirmaciones y recordatorios que reduzcan
las inasistencias, gestionado desde un panel web propio y una app móvil
para el profesional.

**Métrica norte (North Star)**: reducción del % de no-shows en las
clínicas activas. Objetivo interno: bajar no-shows al menos **30%
relativo** en los primeros 60 días de uso.

---

## Estado del proyecto

Estado al **2026-09-09**. Backend con **49 suites / 721 tests** verdes
(`find apps/backend/src -name '*.spec.ts' | wc -l` → 49; ver
[`docs/bitacora.md`](./docs/bitacora.md), entrada "Sprint 2 · tests de
reminders y follow-ups"). CI en GitHub Actions (`tsc` + jest backend,
`tsc` + `next build` + chequeo i18n web).

Funcionalidad entregada:

- [x] **Infra + wiring** — Docker Compose, Prisma + pgvector, BullMQ, WAHA,
      health checks (`/api/health`, `/api/health/live`).
- [x] **Bot de WhatsApp** — FSM de agendamiento (servicio → profesional →
      slot → confirmación), preclasificador determinista antes del LLM
      (SÍ / CANCELAR / REAGENDAR / "hablar con alguien"), handoff a humano,
      link de agendamiento con token cuando llega por `@lid` sin número.
- [x] **RAG FAQ** — base de conocimiento por clínica vectorizada
      (pgvector + OpenAI embeddings) con síntesis DeepSeek → Gemini.
- [x] **Recordatorios anti no-show** — offsets configurables por clínica,
      confirmación explícita, `EN_RIESGO` + alerta a recepción, dedup por
      `jobId`.
- [x] **Feedback post-atención** — score 1-5 por WhatsApp después de
      `ATENDIDA`, configurable por profesional, resumen en el panel
      ([[docs/adr/0012-feedback-post-atencion]]).
- [x] **Página pública** `/agendar/[clinicSlug]` — catálogo, slots, alta de
      cita con consent, rate-limit y anti-spam Redis.
- [x] **Auth multi-tenant** — JWT HS256 (24h), RBAC (`SUPERADMIN`,
      `CLINIC_ADMIN`, `PROFESSIONAL`), `tenantWhere` en toda query, login
      bloqueado si la clínica no está `ACTIVE`.
- [x] **Panel completo** — agenda, conversaciones, pacientes, dashboard,
      FAQ, feedback, servicios, profesionales (perfil + feed iCal),
      horarios, bloqueos, ajustes, conexión WhatsApp por QR, leads.
- [x] **SUPERADMIN + impersonation** — `/admin/*`: alta/suspensión/
      reactivación de clínicas, impersonation con JWT de 30 min sólo sobre
      clínicas `ACTIVE`, trail de auditoría
      ([[docs/adr/0014-superadmin-como-operador-saas]],
      [[docs/adr/0016-admin-audit-impersonation-trail]]).
- [x] **Invitaciones** — alta de clínica → email (Resend) con token →
      `/invite/[token]` fija la contraseña del admin.
- [x] **Leads** — formulario del landing → `POST /api/public/leads` → funnel
      en `/admin/leads`.
- [x] **Observabilidad** — Pino → Axiom (JSON estructurado, `requestId`
      correlacionado HTTP → BullMQ → WhatsApp, PII redactada) + Sentry en
      backend y web ([[docs/adr/0015-pino-axiom-sentry]]).
- [x] **Analytics de producto** — Plausible (sin cookies, sin PII) en
      landing y página pública
      ([[docs/notas/2026-09-09-analytics-plausible]]).
- [x] **Webhook WAHA endurecido** — HMAC-first sobre el body raw, fail-closed,
      dedup de eventos por `payload.id` en Redis
      ([[docs/adr/0017-webhook-hmac-cookie-hardening]]).
- [x] **Deploy** — Coolify (docker compose) con dominios sslip.io temporales
      hasta mover el DNS de `showly.us` ([`docs/deploy-coolify.md`](./docs/deploy-coolify.md)).

Sprints (plan de 4, ver bitácora):

- [x] **Sprint 0** — CI verde + primer deploy en Coolify (PR #24).
- [x] **Sprint 1** — P1 de seguridad de la auditoría
      ([`docs/auditoria/RESUMEN-finalizacion.md`](./docs/auditoria/RESUMEN-finalizacion.md)):
      clínica no `ACTIVE` → 404 en rutas públicas, secretos del webhook en el
      fail-fast de prod, `normalizeE164` único, `bufferMin` simétrico en
      disponibilidad, dedup del webhook, analytics.
- [ ] **Sprint 2** — en PRs: tests de reminders/follow-ups (PR #28,
      mergeado), resto en revisión.
- [ ] **Sprint 3** — en curso: docs al día (este README, SPEC, PRD),
      bootstrap con contraseñas por entorno, cierre de deuda documental.

Pendiente después del piloto:

- [ ] App Flutter (Fase 4; ver [`apps/mobile/README.md`](./apps/mobile/README.md)).
- [ ] Piloto real con 1 clínica + build in public.
- [ ] Deuda documentada en [[docs/adr/0004-pii-y-compliance]],
      [[docs/adr/0005-auth-mvp-y-deuda]], [[docs/adr/0006-panel-mvp-y-deuda]].

<!-- Screenshots del panel — descomentar cuando existan
![Panel Dashboard](docs/img/panel-dashboard.png)
![Agenda visual](docs/img/panel-agenda.png)
![Bandeja de conversaciones](docs/img/panel-bandeja.png)
![Página pública](docs/img/publica-agendar.png)
-->

---

## Stack

| Capa                | Tecnología                                          |
|---------------------|-----------------------------------------------------|
| Backend             | NestJS 10 + Prisma 5 + TypeScript strict            |
| Base de datos       | PostgreSQL 15 + pgvector 0.8                        |
| Cola de jobs        | Redis 7 + BullMQ 5                                  |
| WhatsApp gateway    | WAHA (no oficial, Docker)                           |
| LLM router          | DeepSeek (primario) → Gemini (fallback), fetch nativo|
| Embeddings          | OpenAI `text-embedding-3-small` (1536 dims)         |
| Web (panel + público)| Next.js 15 + Tailwind + shadcn-style + next-intl (es/pt) |
| Auth                | JWT HS256 (24h) + bcrypt(10) + guards multi-tenant  |
| Fechas / TZ         | Luxon (siempre en TZ de la clínica)                 |
| Observabilidad      | Pino → Axiom (logs) + Sentry (errores, backend y web) |
| Analytics           | Plausible (sin cookies), activado por `NEXT_PUBLIC_PLAUSIBLE_DOMAIN` |
| Email transaccional | Resend (invitaciones)                               |
| App móvil (Fase 4)  | Flutter (fuera del workspace pnpm) — no implementada |
| Infra               | Docker Compose (dev), Coolify + Traefik (prod); Hetzner + Caddy documentado como alternativa |

---

## Quickstart

Requisitos: **Node 20+**, **pnpm 9+**, **Docker Compose**.

```bash
# 1. Clonar
git clone <repo-url> showly
cd showly

# 2. Copiar la env
cp .env.example .env
# Editar .env con tus keys reales (o dejar los defaults dev para local).

# 3. Levantar infra (postgres + redis + waha)
docker compose up -d db redis waha

# 4. Instalar dependencias
pnpm install

# 5. Aplicar migraciones + seed con data de ejemplo
pnpm --filter @showly/backend prisma migrate deploy
pnpm --filter @showly/backend prisma db seed

# 6. Levantar backend + web en dos terminales
pnpm dev:backend         # NestJS en :4000
pnpm dev:web             # Next.js en :3002

# 7. Escanear el QR de WhatsApp (dev only)
open http://localhost:3000/dashboard
# usuario/password según WAHA_DASHBOARD_USERNAME/PASSWORD del .env
```

**Verificación**:

- Login del panel: `http://localhost:3002/es/login` con
  `admin@demo.dev` / `demo1234`.
- Página pública: `http://localhost:3002/es/agendar/demo`.
- Backend health: `curl -s http://localhost:4000/api/dashboard/metrics -o /dev/null -w "%{http_code}"` → 401 (sin auth).

Para el walkthrough completo del smoke E2E: ver [`docs/smoke-e2e.md`](./docs/smoke-e2e.md).

---

## Estructura del monorepo

```
showly/
├── README.md · CLAUDE.md · docker-compose.yml
├── docs/                            # vault Obsidian: PRD, SPEC, ARCHITECTURE, ADRs, notas
│   ├── PRD.md · SPEC.md · ARCHITECTURE.md · INDEX.md · bitacora.md
│   ├── onboarding-clinica.md        # playbook alta de clínica nueva
│   ├── runbook-panel.md             # día a día de recepción
│   ├── smoke-e2e.md                 # checklist pre-demo
│   ├── deploy-coolify.md            # deploy actual (Coolify)
│   ├── deploy.md                    # alternativa documentada (Hetzner + Caddy)
│   ├── runbook-lanzamiento.md       # checklist de lanzamiento
│   ├── auditoria/                   # auditoría F1 (RESUMEN-finalizacion + reportes)
│   ├── adr/                         # decisiones de arquitectura
│   └── notas/                       # descubrimientos y gotchas
├── packages/
│   └── shared/                      # @showly/shared — tipos TS backend↔web
├── apps/
│   ├── backend/                     # @showly/backend — NestJS
│   │   ├── prisma/                  # schema, migrations, seed, reindex-faq
│   │   └── src/
│   │       ├── auth/                # JWT + guards multi-tenant + RBAC
│   │       ├── scheduling/          # motor de disponibilidad (núcleo)
│   │       ├── reminders/           # motor anti no-show (BullMQ)
│   │       ├── whatsapp/            # WAHA client + webhook
│   │       ├── bot/                 # FSM + intención LLM
│   │       ├── knowledge/           # RAG FAQ (pgvector)
│   │       ├── public/              # endpoints públicos + rate-limit + scheduling-session
│   │       ├── admin/               # SUPERADMIN: clínicas, impersonation, audit, métricas
│   │       ├── invitations/ · leads/ · feedback/ · follow-ups/ · mail/
│   │       ├── health/ · common/    # health checks, logger Pino, redactor PII, env
│   │       ├── services/ · professionals/ · business-hours/ · time-off/
│   │       ├── appointments/ · patients/ · conversations/ · dashboard/ · faq/ · clinics/
│   │       └── main.ts · app.module.ts
│   ├── web/                         # @showly/web — Next.js 15
│   │   └── src/app/[locale]/
│   │       ├── page.tsx · seguridad/  # landing + página de seguridad
│   │       ├── agendar/[clinicSlug]/  # página pública (+ /gracias)
│   │       ├── invite/[token]/        # aceptación de invitación
│   │       ├── login/
│   │       ├── panel/               # agenda, conversaciones, pacientes, dashboard, faq, feedback, cruds
│   │       └── admin/               # SUPERADMIN: clinics, dashboard, audit, leads
│   └── mobile/                      # Flutter (fuera del workspace pnpm) — Fase 4, stub
├── package.json · pnpm-workspace.yaml
└── .env.example                     # todas las env vars, sin valores reales
```

Ver [`docs/INDEX.md`](./docs/INDEX.md) para el mapa completo del vault.

---

## Variables de entorno

Ver [`.env.example`](./.env.example) para la lista completa. Las críticas:

| Variable            | Uso                                                    |
|---------------------|--------------------------------------------------------|
| `DATABASE_URL`      | Postgres con pgvector. En dev: `postgresql://showly:showly@localhost:5432/showly` |
| `REDIS_URL`         | Redis para BullMQ + rate-limit                         |
| `JWT_SECRET`        | Mínimo 32 chars, `openssl rand -base64 48`. Fail-fast en prod si es dev-* |
| `WEBHOOK_HMAC_SECRET` | Firma HMAC-SHA256 del webhook WAHA sobre el body raw. Si está seteado, el token se ignora (anti-downgrade) |
| `WEBHOOK_TOKEN`     | Token compartido del webhook WAHA (fallback si no hay HMAC; uno de los dos es obligatorio en prod) |
| `ICAL_SECRET`       | Firma de los feeds iCal `/ical/professionals/:id` (sin Bearer) |
| `WEB_BASE_URL`      | URL pública del web; el bot la usa para armar `…/agendar/slug?t=<token>` |
| `NEXT_PUBLIC_PLAUSIBLE_DOMAIN` | Dominio en Plausible (build-time). Vacío → analytics apagado |
| `SENTRY_DSN` + `AXIOM_*` | Observabilidad. `SENTRY_DSN` es fail-fast en prod aunque `SENTRY_ENABLED=false` |
| `RESEND_API_KEY`    | Envío de invitaciones por email                        |
| `WAHA_BASE_URL` + `WAHA_API_KEY` | Cliente WAHA para enviar mensajes         |
| `DEEPSEEK_API_KEY` + `GEMINI_API_KEY` | LLM router (primario + fallback) |
| `OPENAI_API_KEY`    | Embeddings de FAQ (opcional; si no está, FAQ funciona sin RAG) |
| `TRUST_PROXY`       | `true` si hay proxy delante (Caddy/nginx/CF)           |
| `CORS_ORIGINS`      | CSV de orígenes permitidos (obligatorio en prod)       |

---

## Comandos comunes

```bash
# Dev
pnpm dev:backend                # NestJS con watch
pnpm dev:web                    # Next.js con HMR
pnpm infra:up                   # db + redis + waha
pnpm infra:down                 # bajar la infra

# Build
pnpm build                      # backend + web

# Test
pnpm test                       # todos los tests unitarios
pnpm --filter @showly/backend test    # solo backend

# Prisma
pnpm --filter @showly/backend prisma migrate dev --name <descripcion>
pnpm --filter @showly/backend prisma migrate deploy
pnpm --filter @showly/backend prisma db seed
pnpm --filter @showly/backend prisma studio
pnpm --filter @showly/backend prisma:reindex-faq
```

---

## Documentación

- [`docs/PRD.md`](./docs/PRD.md) — producto (qué y por qué).
- [`docs/SPEC.md`](./docs/SPEC.md) — contratos + reglas + escenarios Gherkin.
- [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) — componentes, flujos, FSM.
- [`docs/onboarding-clinica.md`](./docs/onboarding-clinica.md) — alta de clínica nueva.
- [`docs/runbook-panel.md`](./docs/runbook-panel.md) — día a día de recepción.
- [`docs/smoke-e2e.md`](./docs/smoke-e2e.md) — checklist E2E pre-demo.
- [`docs/deploy-coolify.md`](./docs/deploy-coolify.md) — deploy actual (Coolify).
- [`docs/deploy.md`](./docs/deploy.md) — alternativa documentada (Hetzner + Caddy).
- [`docs/runbook-lanzamiento.md`](./docs/runbook-lanzamiento.md) — checklist de lanzamiento.
- [`docs/auditoria/RESUMEN-finalizacion.md`](./docs/auditoria/RESUMEN-finalizacion.md) — auditoría F1 y estado de cierre.
- [`docs/INDEX.md`](./docs/INDEX.md) — índice del vault Obsidian.
- [`docs/adr/`](./docs/adr/) — decisiones de arquitectura.

---

## Contribuir

- **Commits**: [Conventional Commits](https://www.conventionalcommits.org/)
  (`feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`). Sin
  co-author attribution. Atómicos (~100 líneas).
- **Trunk-based**: mainline siempre deployable. Feature branches cortos.
- **TypeScript strict** en todo el backend. Sin `any` innecesarios.
- **Tests obligatorios** para la lógica de negocio (`SchedulingService`,
  `RemindersService`, `BotModule`, FSM, tenant isolation).
- **Cero fuga entre tenants**: todo query pasa por `tenantWhere` (ver
  [[docs/adr/0006-panel-mvp-y-deuda]]).
- **Cero PII en logs**: verificar en cada PR.
- **Luxon con TZ de la clínica**: nunca `new Date()` naive.
- **ADR obligatorio** para decisiones no obvias. Formato:
  `docs/adr/NNNN-titulo.md`. Enlazar en `docs/INDEX.md`.

Correr tests:

```bash
pnpm test                       # todos
pnpm --filter @showly/backend test -- --watch    # watch mode
```

Antes de un PR:

```bash
pnpm build && pnpm test         # ambos verdes
```

---

## Riesgos y consideraciones

- **WAHA es no oficial** — riesgo de baneo del número. Mitigación:
  números dedicados, volumen moderado, plan de migración a API oficial
  si un cliente escala. Ver [[docs/adr/0002-waha-no-oficial]].
- **Datos de salud (PHI)** — cifrado en tránsito (TLS), aislamiento por
  tenant, cero PII en logs. Deuda parcial documentada en
  [[docs/adr/0004-pii-y-compliance]].
- **Auth MVP** — JWT de 24h sin refresh ni revocación, sin password reset,
  sin MFA. La impersonation del SUPERADMIN valida al emitir que la clínica
  esté `ACTIVE` y deja trail en `AdminAudit`. OK para piloto de 1 clínica;
  roadmap de cierre en [[docs/adr/0005-auth-mvp-y-deuda]].

---

## Licencia

TBD (private, © Condor-Martech).
