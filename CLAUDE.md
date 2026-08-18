# CLAUDE.md — Showly

Contexto para Claude Code al trabajar en este repo.

## Qué es
Sistema de agendamiento por WhatsApp + **página pública de agendamiento** + recordatorios
anti no-show para clínicas y consultorios. Multi-tenant. Vertical inicial: clínicas.

Lee primero: `docs/PRD.md` (producto), `docs/SPEC.md` (contratos + escenarios), `docs/ARCHITECTURE.md` (técnico).

## Base de conocimiento en Obsidian (IMPORTANTE)
Este repo ES un vault de Obsidian. Las notas de conocimiento viven en `docs/` (ver `docs/INDEX.md`).

Reglas:
- **Busca siempre primero en `docs/`** antes de responder o decidir. Si la respuesta a una duda de
  producto, arquitectura o decisión ya está en una nota, úsala en vez de asumir.
- **Auto-alimenta el vault** cuando lo veas necesario: al tomar una decisión de diseño, resolver un
  problema no obvio, descubrir un gotcha, o cerrar un incremento, crea/actualiza la nota
  correspondiente:
  - Decisiones de arquitectura → `docs/adr/NNNN-titulo.md` (formato ADR: contexto, decisión, consecuencias).
  - Descubrimientos/gotchas técnicos → `docs/notas/` (nota corta con fecha).
  - Cambios de alcance o producto → actualizar `PRD.md` / `SPEC.md` y anotar en `docs/bitacora.md`.
- Mantén `docs/INDEX.md` actualizado como mapa del vault (enlaza notas nuevas con `[[wikilinks]]`).
- Usa enlaces `[[nota]]` entre notas para aprovechar el grafo de Obsidian.
- No dupliques: si una nota ya cubre el tema, edítala en vez de crear otra.

## Monorepo (pnpm workspace)
```
showly/
├── apps/
│   ├── backend/   NestJS 10 + Prisma + BullMQ  (@showly/backend)
│   ├── web/       Next.js 15: panel admin + página pública /agendar/[clinicSlug]  (@showly/web)
│   └── mobile/    Flutter (app del profesional)
├── packages/
│   └── shared/    tipos TS compartidos backend↔web  (@showly/shared)
├── docs/          vault Obsidian: PRD, SPEC, ARCHITECTURE, INDEX, adr/, notas/, bitacora
├── docker-compose.yml   db(pgvector)+redis+waha+backend
├── pnpm-workspace.yaml · package.json
└── CLAUDE.md
```
Comandos: `pnpm infra:up` (db+redis+waha) · `pnpm dev:backend` · `pnpm dev:web`.
La app Flutter (`apps/mobile`) vive en el monorepo pero fuera del workspace pnpm (toolchain Dart aparte).

## Stack
- Backend: NestJS 10 + Prisma 5 + PostgreSQL (pgvector) + Redis/BullMQ. TypeScript strict.
- WhatsApp: WAHA (no oficial). Una sesión por clínica.
- LLM: DeepSeek (primario) + Gemini (fallback), fetch nativo sin SDK.
- Web: Next.js 15 + Tailwind + shadcn/ui + next-intl (es/pt). Panel + página pública SSR.
- Fechas/horas: SIEMPRE Luxon con la TZ de la clínica. Nunca `Date` naive.

## Flujo de trabajo (usar los agent-skills instalados)
Antes de codear una feature: `/spec` → `/plan` → `/build` → `/test` → `/review` → `/ship`.
Commits atómicos (~100 líneas), trunk-based, tests de la lógica de negocio, cero fuga entre tenants.

## Agentes del proyecto (`.claude/agents/`)
- `code-reviewer` — revisión de 5 ejes antes de merge.
- `test-engineer` — estrategia y cobertura de tests.
- `security-auditor` — OWASP + datos de salud (PII de pacientes). Invocar SIEMPRE en cambios que
  toquen datos de pacientes, auth o multi-tenant.

## Estado y roadmap
Hecho: modelo de datos, motor de disponibilidad, motor de recordatorios, WAHA + webhook, bot base.
Siguiente:
1. Wiring NestJS ejecutable (`main.ts`, `app.module.ts`, `prisma.service.ts`, BullMQ + worker).
2. FSM de agendamiento en el bot.
3. Página pública `/agendar/[clinicSlug]` (form paciente + slot + crear cita; rate-limit anti-spam).
4. RAG FAQ (pgvector).
5. Auth + guards multi-tenant (RBAC).
6. Panel Next.js (agenda, bandeja, dashboard no-show, FAQ).
7. App Flutter.
8. Piloto con 1 clínica real + build in public.

## Convenciones
- `clinicId` en toda entidad y en el JWT; validar tenant en cada query.
- Secretos solo por env (`.env`, nunca commiteado). Ver README para las claves.
- Documentar decisiones no obvias como ADR en `docs/adr/` (y enlazarlas en `docs/INDEX.md`).
