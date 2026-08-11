# 🗂️ Índice del vault — AgendaZap

Mapa de la base de conocimiento. Mantener actualizado al crear notas nuevas.

## Documentos raíz
- [[PRD|PRD]] — producto (qué y por qué)
- [[SPEC|SPEC]] — contratos, reglas y escenarios Gherkin
- [[ARCHITECTURE|Arquitectura]] — componentes, flujos, estados
- [[arquitetura-runtime|Arquitetura Runtime (PT-BR)]] — diagrama interactivo archify + explicación en portugués
- [[../README|README]] — cómo correrlo y estado

## Piloto (operación y deploy)
- [[onboarding-clinica|Onboarding de una clínica nueva]] — playbook alta.
- [[runbook-panel|Runbook del panel]] — día a día de recepción.
- [[smoke-e2e|Smoke E2E]] — checklist pre-demo.
- [[deploy|Deploy productivo]] — Hetzner + Docker + Caddy.

## Decisiones de arquitectura (ADR)
- [[adr/0001-monorepo|0001 — Monorepo pnpm + Flutter]]
- [[adr/0002-waha-no-oficial|0002 — WAHA (no oficial) para el MVP]]
- [[adr/0003-rate-limit-casero-vs-throttler|0003 — Rate-limit casero con Redis vs `@nestjs/throttler`]]
- [[adr/0004-pii-y-compliance|0004 — PII, PHI y compliance para MVP/piloto]]
- [[adr/0005-auth-mvp-y-deuda|0005 — Auth MVP: alcance, decisiones y deuda para post-piloto]]
- [[adr/0006-panel-mvp-y-deuda|0006 — Panel MVP: fixes post-audit y deuda documentada]]
- [[adr/0007-rate-limit-bot|0007 — Rate-limit del bot de WhatsApp (protección LLM budget)]]
- [[adr/0008-panel-conexion-waha-y-observabilidad|0008 — Panel de conexión WAHA + observabilidad]]
- [[adr/0009-faq-title-y-markdown-strip|0009 — FAQ: `title` opcional y strip de markdown antes del embedding]]
- [[adr/0010-lid-y-contacto-whatsapp|0010 — WhatsApp LID, identidad del contacto y perfil visible]]
- [[adr/0011-perfil-profesional-e-ical-feed|0011 — Perfil de Profesional e iCal feed para sincronización con calendar]]
- [[adr/0012-feedback-post-atencion|0012 — Feedback post-atención (satisfacción) por WhatsApp]]

## Notas y descubrimientos
- [[notas/2026-08-08-prisma-pgvector-y-env|2026-08-08 — Prisma + pgvector y carga de `.env` en el monorepo]]
- [[notas/2026-08-08-nextjs-vs-astro|2026-08-08 — Next.js vs Astro para apps/web]]
- [[notas/2026-08-08-bootstrap-nestjs-wiring|2026-08-08 — Bootstrap NestJS wiring (Bloque 1)]]
- [[notas/2026-08-08-bloque-2-fsm-scheduling|2026-08-08 — Bloque 2: FSM + `SchedulingService`]]
- [[notas/2026-08-08-bloque-3-pagina-publica|2026-08-08 — Bloque 3: Página pública + endpoint público]]
- [[notas/2026-08-08-bloque-2y3-cierre-e2e|2026-08-08 — Cierre Bloques 2/3: fixes + seed + smoke E2E]]
- [[notas/2026-08-08-bloque-auth|2026-08-08 — Bloque 5: Auth (JWT + guards multi-tenant + RBAC)]]
- [[notas/2026-08-09-panel-backend-cruds|2026-08-09 — Panel Backend: TenantContext + CRUDs (Etapa 1)]]
- [[notas/2026-08-09-rag-faq|2026-08-09 — Bloque RAG FAQ (KnowledgeModule)]]
- [[notas/2026-08-09-f5-rediseno-shadcn-recharts|2026-08-09 — F5 rediseño shadcn + Recharts (4 pantallas grandes)]]
- [[notas/2026-08-10-nombre-gochat-y-logo|2026-08-10 — Nombre `gochat` para la marca pública + logo]]

## Flujo de trabajo
- [[skills-y-flujo|Skills, agentes y flujo de trabajo]]

## Plan de trabajo
- [[proximo-incremento|Próximo incremento — wiring + FSM + página pública]]

## Bitácora
- [[bitacora|Bitácora de sesiones]]

## UX specs (audit 2026-08-09)

### P0 — Bloqueadores piloto / WCAG crítico
- [[ux/2026-08-09-pt-json-panel-en-espanol|2026-08-09 — pt.json panel + login en español]] · P0 · i18n
- [[ux/2026-08-09-conversations-staleness-y-reply-lock|2026-08-09 — Conversations: staleness invisible + reply-lock]] · P0 · states
- [[ux/2026-08-09-faq-embedding-banner|2026-08-09 — FAQ: banner "N FAQs sin embedding"]] · P0 · states
- [[ux/2026-08-09-modal-focus-trap|2026-08-09 — Modal: focus trap del Tab]] · P0 · a11y
- [[ux/2026-08-09-panel-mobile-navigation-drawer|2026-08-09 — Panel mobile: drawer + hamburger]] · P0 · responsive
- [[ux/2026-08-09-schedule-form-states-y-doble-submit|2026-08-09 — ScheduleForm: invisible states + doble submit]] · P0 · states

### P1 — Importantes para escalar
- [[ux/2026-08-09-design-system-tokens-y-dedup|2026-08-09 — Design system: tokens semánticos + dedup]] · P1 · consistency
- [[ux/2026-08-09-dashboard-chart-accesible-e-i18n|2026-08-09 — Dashboard chart: accesible + i18n]] · P1 · a11y
- [[ux/2026-08-09-panel-tables-a-cards-en-mobile|2026-08-09 — Panel tables → cards en mobile]] · P1 · responsive
- [[ux/2026-08-09-agenda-filter-bar-mobile-y-touch-targets|2026-08-09 — Agenda filter bar mobile + touch targets]] · P1 · responsive
- [[ux/2026-08-09-confirm-dialog-en-vez-de-confirm-nativo|2026-08-09 — Reemplazar `confirm()` por ConfirmDialog]] · P1 · a11y

### P2 — Polish
- [[ux/2026-08-09-login-polish-autofocus-y-context|2026-08-09 — Login: autoFocus + hint recovery + contraste]] · P2 · density
