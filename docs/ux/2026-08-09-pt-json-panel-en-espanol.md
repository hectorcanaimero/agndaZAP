---
title: Traducir a portugués el bloque `panel.*` y `login.*` de `pt.json`
slug: 2026-08-09-pt-json-panel-en-espanol
priority: P0
axis: i18n
subagent_type: general-purpose
skill: copywriting
status: pending
created: 2026-08-09
tags:
  - ux
  - priority/p0
  - axis/i18n
  - subagent/general-purpose
aliases:
  - pt-json-panel-espanol
---

# Traducir a portugués el bloque `panel.*` y `login.*` de `pt.json`

> [!warning] BLOCKER piloto pt-BR
> Hoy `apps/web/messages/pt.json` tiene el bloque `login.*` **y todo el `panel.*`** copiados
> en español desde `es.json` — nunca fueron traducidos. Cualquier clínica brasileña que
> loguee ve "Iniciá sesión / Cerrar sesión / Agenda / Conversaciones / Bandeja" en Rioplatense.
> [[adr/0006-panel-mvp-y-deuda|ADR 0006 §Deuda 6]] ya lo lista como blocker para go-live pt.
> Este spec lo cierra.

## Problema

**Evidencia** (obligatoria, con file:line):

- `apps/web/messages/pt.json:50-68` — todo el bloque `login.*` en español ("Iniciá sesión",
  "Ingresá con tu email y contraseña", "Contraseña", "Ingresando...", "Credenciales inválidas",
  "Demasiados intentos. Probá en un rato").
- `apps/web/messages/pt.json:70-338` — todo el bloque `panel.*` en español. Incluye:
  - `panel.nav.*` (Dashboard/Agenda/Conversaciones/Servicios/Profesionales/Horarios/Bloqueos/FAQ/Cerrar sesión).
  - `panel.dashboard.*` (No-show rate, Tasa de confirmación, Recordatorios enviados, Citas confirmadas, Tendencia 14 días).
  - `panel.agenda.*` incluida la clave crítica `panel.agenda.statusRaceRefresh` — el
    toast de race condition que el operador va a ver seguido cuando hay dos personas en el panel.
  - `panel.conversations.*` (Bandeja, Requiere humano, Tomá la conversación para poder responder).
  - `panel.services.*`, `panel.professionals.*`, `panel.businessHours.*`, `panel.timeOff.*`,
    `panel.faq.*` (labels de campos, weekdays "Lunes...Sábado", placeholders con voseo
    "Ej: consulta general", errores "Requerido").
- Comparar: el bloque `page.*` (líneas 1-7) SÍ está en portugués correcto ("Agende sua consulta").
  El bloque `form.*` (líneas 8-42) SÍ está traducido ("Nome completo", "Serviço"). O sea:
  el flujo público está en pt, pero apenas el operador loguea, salta a es. Ruptura total de
  experiencia en el mismo tenant.

**Impacto**:

- **Usuario afectado**: recepcionista de clínica brasileña (`CLINIC_ADMIN` con `clinic.locale='pt'`).
- **Contexto de uso**: uso diario, panel operativo. Impacta CADA vista.
- **Magnitud**: bloquea onboarding pt. La clínica pt siente que el producto no está terminado
  el primer minuto de uso. Copywriting del bot es en pt (RAG con `locale=pt`), la landing
  pública es en pt, pero el operador ve un pastiche Rioplatense-portunhol. Además rompe la
  premisa de compliance LGPD "toda comunicación en el idioma local" en la parte más
  administrativa del sistema.

> [!warning]+ Priority
> **P0** — Blocker piloto pt. Sin esto, la promesa "es/pt desde día uno" del PRD §6
> es falsa apenas se abre el panel.

## Propuesta

Traducir a **português do Brasil** (no português europeu) las 3 áreas identificadas.
No inventar keys nuevas ni modificar la estructura JSON — sólo reemplazar valores.

Convenciones de tono para el pt-BR:

- Voseo Rioplatense (`Iniciá sesión`, `Escribí`, `Elegí`) → **você** con verbos en 3ra persona
  (`Iniciar sessão`, `Escreva`, `Selecione`).
- Frases cortas, operativas. No traducir literalmente diccionario — adaptar giros
  (ej. "Tomá la conversación para poder responder" → "Assuma a conversa para poder responder").
- Mantener "No-show" como término técnico (usado en salud pt-BR como anglicismo).
- "Cita" → **consulta** (contexto médico ya cubierto por el `form.*` traducido).
- "Cerrar sesión" → **Sair** (idiomático más común que "Encerrar sessão").
- "Buffer" → mantener **Buffer** (jerga operativa entendida por recepción de clínica).
- Weekday keys 0-6 → **Domingo, Segunda, Terça, Quarta, Quinta, Sexta, Sábado**.

Estados de cita (`panel.dashboard.status.*` y usados en Agenda + Conversations):

- `PENDIENTE` → **Pendente**
- `CONFIRMADA` → **Confirmada**
- `EN_RIESGO` → **Em risco**
- `ATENDIDA` → **Atendida**
- `CANCELADA` → **Cancelada**
- `NO_SHOW` → **No-show** (mantener)

Conversation states (`panel.conversations.state.*`):

- `BOT` → **Bot**
- `NEEDS_HUMAN` → **Requer humano**
- `HUMAN` → **Humano**

> [!example]- Snippets clave que deben quedar naturales
>
> ```json
> "login": {
>   "title": "Entrar",
>   "subtitle": "Acesse com seu e-mail e senha.",
>   "labels": { "email": "E-mail", "password": "Senha" },
>   "placeholders": { "email": "voce@clinica.com" },
>   "submit": "Entrar",
>   "submitting": "Entrando...",
>   "errors": {
>     "email": "E-mail inválido.",
>     "password": "Digite sua senha (mínimo 8 caracteres).",
>     "invalidCredentials": "Credenciais inválidas.",
>     "tooManyAttempts": "Muitas tentativas. Tente novamente em alguns minutos.",
>     "generic": "Não foi possível entrar. Tente novamente."
>   }
> },
> "panel": {
>   "nav": { "dashboard": "Dashboard", "agenda": "Agenda",
>            "conversations": "Conversas", ..., "logout": "Sair" },
>   "agenda": {
>     "detail": { "patient": "Paciente", "phone": "Telefone",
>                 "service": "Serviço", "professional": "Profissional",
>                 "time": "Horário", "status": "Status",
>                 "transitions": "Alterar status",
>                 "noTransitions": "Esta consulta já está em um status final." },
>     "statusRaceRefresh": "Esse status já foi alterado — atualizando."
>   }
> }
> ```

### Componentes involucrados

- `apps/web/messages/pt.json` — reemplazar valores dentro de `login.*` (líneas 50-68) y
  `panel.*` completo (líneas 70-338). No tocar `page.*`, `form.*`, `thanks.*` (ya en pt-OK).
- **Cero cambios en TSX/TS** — todas las keys ya existen y son consumidas por
  `useTranslations('login')`, `useTranslations('panel.nav')`, etc.

> [!success] Criterios de aceptación
> - [ ] Ningún string dentro de `pt.json` bajo `login.*` o `panel.*` está en español
>   Rioplatense (grep `pt.json` no matchea "Iniciá", "Ingresá", "Elegí", "Cerrá", "Probá",
>   "vos", "Lunes", "Miércoles", "vacío", "guardado").
> - [ ] `pnpm --filter @agendazap/web build` sigue limpio (no rompimos JSON).
> - [ ] Comparativo de keys: `jq 'paths(scalars) | join(".")' es.json` y `... pt.json` devuelven
>   exactamente las mismas rutas — cero keys agregadas ni faltantes.
> - [ ] Weekdays 0-6 en portugués: Domingo/Segunda/Terça/Quarta/Quinta/Sexta/Sábado.
> - [ ] `panel.agenda.statusRaceRefresh` traducido (aparece en el flujo de race del panel,
>   crítico para el operador entender qué pasa).
> - [ ] `panel.faq.hints.content` traducido (la clave habla de markdown — mantener término).
> - [ ] Placeholders con nombres brasileños (María González → Maria Silva, aunque ya está OK
>   en el bloque `form`).
> - [ ] Un hablante nativo de pt-BR (o el traductor) firma el diff — no autotranslate literal.

> [!note]- Fuera de scope
> - NO se agrega tercer locale (en/etc.). El PRD §6 habla de es/pt exclusivamente.
> - NO se cambia la estructura del JSON (mismo shape).
> - NO se traduce el `README.md` ni los `docs/*.md` — sólo strings del panel visibles al operador.
> - NO se traducen strings del bot de WhatsApp (viven en el backend, `KnowledgeService` ya
>   maneja `locale` por clínica — ver [[notas/2026-08-09-rag-faq|nota RAG]]).

## Referencias

- [[PRD|PRD §6 — es/pt desde día uno]]
- [[adr/0006-panel-mvp-y-deuda|ADR 0006 §Deuda 6 — pt.json panel strings]]
- [[adr/0004-pii-y-compliance|ADR 0004 — LGPD y datos de salud]]
- [[notas/2026-08-09-panel-backend-cruds|nota Panel CRUDs]] (contexto operativo)

## Ejecución sugerida

- **subagent_type**: `general-purpose`
- **skill**: `copywriting`
- **prompt para el subagente**:

```
Traducí el spec docs/ux/2026-08-09-pt-json-panel-en-espanol.md.
Contexto: AgendaZap, panel operativo de una clínica pt-BR. Usuario primario: recepcionista.
Tono: português do Brasil, formal-operativo (você), frases cortas, jerga de recepción de clínica.
Restricciones:
- Sólo tocar apps/web/messages/pt.json — cero cambios en TSX/TS.
- Mantener EXACTAMENTE las mismas keys que es.json (verificar con `jq paths`).
- No traducir literal; adaptar giros idiomáticos (voseo → você imperativo).
- "No-show" se mantiene como anglicismo (uso corriente en clínicas pt-BR).
- Weekdays 0-6: Domingo/Segunda/Terça/Quarta/Quinta/Sexta/Sábado.
Al terminar: reporte con `jq -r 'paths(scalars) | join(".")' es.json pt.json | diff` limpio +
build de web verde.
```
