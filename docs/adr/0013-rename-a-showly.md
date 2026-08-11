# ADR 0013 — Rebrand de "gochat" / "AgendaZap" a "Showly"

- Fecha: 2026-08-11
- Estado: aceptado
- Relacionados: [[../notas/2026-08-10-nombre-gochat-y-logo]]

## Contexto

Hasta ahora el producto convivía con dos nombres en el repo:

- `gochat` — marca pública para la landing y el WhatsApp bot (elegida en
  la nota `docs/notas/2026-08-10-nombre-gochat-y-logo.md`, ver el
  razonamiento de por qué "gochat" ganó sobre otras opciones).
- `AgendaZap` — nombre técnico / codename usado en:
  - Título del layout web (`apps/web/src/app/[locale]/layout.tsx`)
  - Brand mark del login (`apps/web/src/app/[locale]/login/page.tsx`)
  - Log de arranque del backend (`apps/backend/src/main.ts`)
  - PRODID del feed iCal que exportan los profesionales
    (`apps/backend/src/professionals/ical.service.ts`)
  - Nombre de la carpeta del monorepo (`~/project/agendazap/`)
  - Comentarios JSDoc en varios archivos

Esta convivencia era deuda desde el spike inicial (el proyecto arrancó
como `AgendaZap` y el naming público se cerró después como `gochat`).

## Decisión

**El producto se llama `Showly`** (proper case, S mayúscula) —
público y técnico. Un solo nombre para toda la superficie.

### Alcance del rebrand

**Landing pública** (visible al prospect):
- `apps/web/messages/{es,pt}.json` — 20 keys en total (title, description,
  brand, subheadline, HowItWorks, testimonial, ForWhom headline, Nav brand,
  Footer copyright)
- `apps/web/src/components/landing/Logo.tsx` — aria-label + texto visible
- `apps/web/src/components/landing/Nav.tsx` — aria-label
- `apps/web/src/components/landing/Footer.tsx` — email de contacto
- `apps/web/src/components/landing/icons.tsx` — comentario JSDoc

**Panel / product** (visible en demo):
- `apps/web/src/app/[locale]/layout.tsx` — metadata title
- `apps/web/src/app/[locale]/login/page.tsx` — brand mark del login
- `apps/web/src/lib/query-client.ts`, `apps/web/src/lib/auth.ts`,
  `apps/web/src/app/globals.css` — comentarios

**Backend** (visible en logs y en el iCal exportado):
- `apps/backend/src/main.ts` — log de arranque
- `apps/backend/src/professionals/ical.service.ts` — `PRODID:-//Showly//iCal Feed//ES`
- `apps/backend/src/{auth,professionals}/*.spec.ts` — comentarios de tests

**Docs**:
- Este ADR (nuevo)
- `docs/INDEX.md` — sumar link al ADR nuevo
- `docs/notas/2026-08-10-nombre-gochat-y-logo.md` — **NO se toca**. Queda
  como registro histórico de la decisión anterior.

### Email de contacto

`hola@gochat.app` → `hola@showly.tech`. El dominio final elegido para el
producto es `showly.tech` (documentado en `docs/notas/2026-08-11-brand-kit-showly.md`).
Actualización sobre el borrador inicial de este ADR (que anticipaba
`showly.app` como default).

### Lo que NO se cambia (fuera de scope)

- **Nombre de la carpeta del monorepo** (`~/project/agendazap/`). Renombrarlo
  rompe working directories de terminales activas, historial del shell,
  paths en scripts de CI si existen, y el nombre en el remote GitHub. Es
  cleanup independiente que puede hacerse después junto con `git mv` /
  rename del repositorio en GitHub.
- **Nombre del paquete pnpm** (`@agendazap/*`). Renombrarlo obliga a
  regenerar `pnpm-lock.yaml` y a actualizar todos los imports internos.
  Deuda menor — se puede hacer en un commit separado sin urgencia.

## Consecuencias

**Positivas**:
- Un solo nombre para toda la superficie: menos confusión al onboardear
  nuevo talento, más consistencia en analytics, más simple para el
  material de marketing.
- Corta la deuda de tener dos nombres compitiendo.

**Negativas / a monitorear**:
- **Colisión de nombre con app existente**: "Showly" también es una app
  conocida de tracking de series y películas (verticales completamente
  distintos: healthcare/agendamiento vs entretenimiento personal). Riesgo
  de trademark bajo por segmentación, pero es un dato a tener en cuenta
  para SEO y para eventual búsqueda de dominios / handles en redes.
- Los commits históricos del branch `feature/landing-page` referencian
  "gochat" en sus messages. NO se reescribe la historia por ahora —
  documenta el proceso real de la decisión.
- Si algún cliente piloto tiene el iCal feed suscrito, el PRODID cambia.
  Los clientes de calendario (Google, Apple) tratan el cambio de PRODID
  como "un feed nuevo" — puede generar duplicados o reimport. Riesgo bajo
  en piloto (pocos suscritos) pero conviene avisar.

## Alternativas consideradas

1. **Mantener `gochat` público + `AgendaZap` interno**: era el status quo.
   Rechazado por la deuda de mantener dos naming en paralelo.
2. **Solo cambiar la marca pública y dejar `AgendaZap` técnico**: mismo
   problema que arriba, no cierra la deuda.
3. **Otros nombres considerados** para el rebrand (no formalmente
   evaluados en este ADR): historial completo en el brainstorming del
   founder — no se documenta acá porque no aporta.
