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

## Flujo de trabajo
- [[skills-y-flujo|Skills, agentes y flujo de trabajo]]

## Plan de trabajo
- [[proximo-incremento|Próximo incremento — wiring + FSM + página pública]]

## Bitácora
- [[bitacora|Bitácora de sesiones]]
