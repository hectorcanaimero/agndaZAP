# Showly

> Agendamiento por WhatsApp con recordatorios anti no-show para clínicas y consultorios.

Sistema multi-tenant que combina:

- Un **bot de WhatsApp** que agenda, reagenda y cancela citas conversando
  con el paciente (via WAHA + LLM barata).
- Un **motor anti no-show** que envía recordatorios programados (24h y
  3h antes por default), pide confirmación explícita y marca las citas
  como EN_RIESGO cuando el paciente no responde.
- Un **panel web** para recepción (agenda visual, bandeja de
  conversaciones, dashboard de no-show rate, editor de FAQ).
- Una **página pública** `/agendar/[clinicSlug]` para que el paciente
  agende desde la web sin bajar app.
- (Roadmap) Una **app Flutter** para el profesional (agenda del día +
  push).

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

Bloques cerrados (208 tests verdes):

- [x] **Bloque 0** — Infra + esqueleto (Docker Compose, Prisma, WAHA).
- [x] **Bloque 1** — Wiring NestJS (main + app.module + BullMQ + prisma).
- [x] **Bloque 2** — FSM de agendamiento en el bot.
- [x] **Bloque 3** — Página pública `/agendar/[clinicSlug]` + rate-limit.
- [x] **Bloque 4** — Auth (JWT + guards multi-tenant + RBAC).
- [x] **Bloque 5** — Panel Next.js (agenda, bandeja, dashboard, FAQ, CRUDs).
- [x] **Bloque RAG** — FAQ vectorizada (pgvector + OpenAI embeddings).
- [x] **Bloque Piloto** — Seed histórico + docs de onboarding + smoke E2E + deploy.

Pendiente:

- [ ] App Flutter (agenda del profesional + push).
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
| App móvil (roadmap) | Flutter (fuera del workspace pnpm)                  |
| Infra               | Docker Compose (dev), Hetzner + Caddy (prod)        |

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
│   ├── deploy.md                    # deploy productivo (Hetzner + Caddy)
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
│   │       ├── public/              # endpoints públicos + rate-limit
│   │       ├── services/ · professionals/ · business-hours/ · time-off/
│   │       ├── appointments/ · conversations/ · dashboard/ · faq/
│   │       └── main.ts · app.module.ts
│   ├── web/                         # @showly/web — Next.js 15
│   │   └── src/app/[locale]/
│   │       ├── agendar/[clinicSlug]/  # página pública
│   │       ├── login/
│   │       └── panel/               # agenda, bandeja, dashboard, faq, cruds
│   └── mobile/                      # Flutter (fuera del workspace pnpm) — roadmap
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
| `WEBHOOK_TOKEN`     | Token custom del webhook WAHA (obligatorio en prod)    |
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
- [`docs/deploy.md`](./docs/deploy.md) — deploy productivo (Hetzner + Caddy).
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
- **Auth MVP** — sin refresh tokens, sin password reset, sin MFA. OK
  para piloto de 1 clínica; roadmap de cierre en
  [[docs/adr/0005-auth-mvp-y-deuda]].

---

## Licencia

TBD (private, © Condor-Martech).
