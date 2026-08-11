# 2026-08-10 — Nombre `gochat` para la marca pública + logo

Durante la creación de la landing page se decidió que el nombre público del producto
sería **`gochat`** (en minúsculas, un solo token).

## Contexto

Hasta ahora el nombre de trabajo en `PRD.md`, `CLAUDE.md`, panel y app era **AgendaZap**.
Al construir la landing, el usuario definió que la marca de cara al mercado es `gochat`
(más corta, más memorable, sugiere velocidad + chat + WhatsApp).

## Estado actual (parcial)

- **Landing pública** (`/[locale]/page.tsx`): usa **gochat** en copy, logo, metadata.
- **Panel admin** (`/[locale]/panel/*`): sigue mostrando **AgendaZap** en title/nav/emails.
- **Página pública de agendamiento** (`/[locale]/agendar/[clinicSlug]`): sigue neutra
  (usa "Clínica X" del tenant, no menciona la marca de la plataforma).
- **PRD.md, ARCHITECTURE.md, CLAUDE.md, README**: siguen diciendo AgendaZap.

## Consecuencias

Hay **inconsistencia de marca** entre landing (gochat) y el resto del producto (AgendaZap).
Se difiere la unificación completa a un incremento posterior donde:
1. Se decida si `gochat` es el nombre final o un nombre de trabajo temporal.
2. Se actualicen: metadata del panel, emails transaccionales, título de la app Flutter,
   `docs/PRD.md`, `docs/ARCHITECTURE.md`, `docs/CLAUDE.md`, `docs/README.md`.
3. Se registre eventualmente un ADR (`adr/0013-nombre-marca-gochat.md`) con el racional.

## Logo

- **Símbolo:** píldora verde brand (`hsl(142 76% 36%)`) con un checkmark blanco inscrito.
  Evoca la marca-check azul de WhatsApp — apropiado para un producto sobre confirmaciones
  por chat — pero en el verde brand para diferenciación y para reforzar la identidad de
  agendamiento/confirmado.
- **Wordmark:** `gochat` en Inter black, minúsculas, tracking cerrado.
- **Composición:** símbolo + wordmark en horizontal para header/footer; solo símbolo
  para favicon/app-icon.
- **Formato:** SVG inline (hand-built, sin librería externa). Vive en
  `apps/web/src/components/landing/Logo.tsx` para poder reusarlo desde varios lugares.
- **Escalabilidad:** funciona a 16px (favicon) y a 200px+ (hero footer) sin pixelado.
  El checkmark tiene grosor constante gracias a `stroke-linecap: round`.

## Pendientes

- [ ] Decisión final del nombre de marca (`gochat` vs `AgendaZap`).
- [ ] Si se elige `gochat`, unificar toda la superficie (panel, mobile, docs, dominio).
- [ ] Registrar en un ADR.
- [ ] Generar favicon.ico + apple-touch-icon.png a partir del SVG.

## Enlaces

- [[../PRD|PRD]] (nombre trabajo: AgendaZap)
- [[../INDEX|Índice del vault]]
