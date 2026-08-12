---
titulo: Arquitetura Runtime
idioma: pt-BR
gerado_por: archify
fecha: 2026-08-09
tags: [arquitetura, runtime, diagrama, multi-tenant]
---

# Arquitetura Runtime — Showly

Mapa vivo dos processos, serviços e integrações em execução. Do paciente ao
agendamento, passando pelo bot WhatsApp, painel web e lembretes anti no-show.

> [!info] Diagrama interativo
> O diagrama abaixo é um HTML autocontido gerado com [archify](https://github.com/anthropics/skills).
> Suporta tema claro/escuro, foco por nó, atalhos `?`, `/`, `M`, `L`, `R`, `F` e exportação
> para PNG/SVG. Abra `diagramas/showly-arquitetura.html` no navegador para a versão
> completa.

<iframe src="diagramas/showly-arquitetura.html" width="100%" height="720" style="border: 1px solid #333; border-radius: 8px;"></iframe>

## Componentes

### Atores externos
- **Paciente (WhatsApp)** — escreve para o número da clínica; o WAHA captura.
- **Paciente (Navegador)** — usa a página pública `/agendar/[slug]` para marcar.
- **Recepção / Admin** — usa o painel `/panel/*` (autenticado com JWT).
- **Profissional** — usa o app Flutter (autenticado com JWT).

### Aplicação Showly (dentro do boundary multi-tenant)
- **Next.js Público** (`apps/web`) — SSR da página pública de agendamento.
- **Next.js Painel** (`apps/web`) — mesmo Next, rota `/panel/*` autenticada.
- **NestJS API** (`apps/backend`, `:4000`) — API REST em `/api/*` + webhook
  `/webhooks/waha` fora do prefixo.
- **Reminders Worker** — BullMQ rodando no mesmo processo Nest (ver
  `main.ts` → `createRemindersWorker`).
- **PostgreSQL + pgvector** — persistência de tenants, agendamentos, FAQ e
  embeddings.
- **Redis** — fila BullMQ dos lembretes.

### Serviços externos
- **WAHA** (`:3000`) — WhatsApp HTTP API não oficial. Uma sessão por clínica.
  Fora do boundary da aplicação.
- **LLM Router** — DeepSeek (primário) → Gemini (fallback), com `fetch` nativo
  sem SDK. OpenAI só para embeddings do RAG de FAQ.

## Fluxos principais

### Bot WhatsApp (entrada)
1. Paciente manda mensagem para o número da clínica.
2. WAHA recebe e faz `POST /webhooks/waha` no backend (webhook fora de `/api`).
3. `BotService` classifica intent (DeepSeek/Gemini) e opera a FSM de agendamento.
4. Ao confirmar cita, cria registro no Postgres e enfileira lembretes no Redis.

### Página pública (entrada)
1. Paciente entra em `/agendar/[clinicSlug]` — SSR do Next lê dados públicos da
   clínica.
2. Form envia para `/api/public/*` (rate-limit por IP).
3. Backend valida disponibilidade, cria cita e agenda lembretes.

### Painel admin (entrada)
1. Recepção loga em `/panel` (JWT com `clinicId`).
2. Todas as requisições vão para `/api/*` com header `Authorization`.
3. Guarda + interceptor cortam qualquer vazamento entre clínicas.

### Lembretes anti no-show (saída assíncrona)
1. Ao criar/mover cita, backend enfileira job no Redis (BullMQ).
2. Worker no mesmo processo Nest consome quando chega a hora (na TZ da clínica).
3. Worker envia mensagem via WAHA para o paciente.

## Decisões relacionadas

- [[adr/0001-monorepo|ADR 0001 — Monorepo pnpm + Flutter]]
- [[adr/0002-waha-no-oficial|ADR 0002 — WAHA (não oficial) para o MVP]]
- [[adr/0003-rate-limit-casero-vs-throttler|ADR 0003 — Rate-limit caseiro com Redis]]
- [[adr/0004-pii-y-compliance|ADR 0004 — PII, PHI e compliance]]
- [[adr/0005-auth-mvp-y-deuda|ADR 0005 — Auth MVP: JWT + guards multi-tenant]]
- [[adr/0007-rate-limit-bot|ADR 0007 — Rate-limit do bot (proteção do budget LLM)]]

## Deploy

Ver [[deploy|Deploy productivo]] para o mapeamento de portas, Caddy reverso,
volumes Docker e checklist Hetzner.

## Regeneração do diagrama

```bash
# do repositório (com Node ≥18)
node ~/.claude/skills/archify/bin/archify.mjs render architecture \
  /tmp/showly-arquitetura.architecture.json \
  docs/diagramas/showly-arquitetura.html
```

Fonte JSON: `/tmp/showly-arquitetura.architecture.json` (mover para
`docs/diagramas/showly-arquitetura.architecture.json` se quiser versionar).
