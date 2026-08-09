---
title: Dashboard — chart accesible con leyenda visible, keyboard focus e i18n del aria-label
slug: 2026-08-09-dashboard-chart-accesible-e-i18n
priority: P1
axis: A11y
subagent_type: general-purpose
skill: frontend-design
status: pending
created: 2026-08-09
tags:
  - ux
  - priority/p1
  - axis/a11y
  - subagent/general-purpose
aliases:
  - dashboard-chart-a11y
---

# Dashboard — chart accesible con leyenda visible, keyboard focus e i18n del aria-label

> [!info] Contexto
> El dashboard tiene un mini bar chart SVG hand-rolled ([[docs/notas/2026-08-09-panel-backend-cruds|
> nota Panel Backend §Dashboard]]) para la tendencia de 14 días. Es lo primero que ve
> el operador cada mañana y la métrica principal del "diferenciador" del [[PRD|PRD §3]].
> Hoy el chart tiene 4 problemas de a11y + i18n compuestos: leyenda como texto abajo sin
> asociación semántica al chart, tooltips SVG `<title>` que sólo se disparan por hover
> (no keyboard), aria-label hardcoded en español "Tendencia 14 días", y colores hex
> hardcoded que fallan si un usuario tiene tritanopia (verde/rojo son los peores para
> daltonismo).

## Problema

**Evidencia** (obligatoria, con file:line):

- `apps/web/src/app/[locale]/panel/dashboard/page.tsx:181` — el `<svg role="img" aria-label="Tendencia 14 días">`
  tiene el aria-label EN ESPAÑOL HARDCODED. Un CLINIC_ADMIN de clínica pt-BR con lector
  de pantalla escucha "Tendencia catorce días" mezclado con el resto de la UI en pt.
  Regresión de i18n silenciosa.
- `apps/web/src/app/[locale]/panel/dashboard/page.tsx:196-208` — cada `<rect>` tiene un
  `<title>` con contenido informativo (`${day.date}: ${day.created} creadas`). Los
  `<title>` en SVG SÓLO son accesibles por hover — el usuario keyboard-only NO puede
  verlos porque el `<rect>` no es focusable (`tabindex` no seteado en SVG por default).
  WCAG 2.1.1 — Keyboard.
- `apps/web/src/app/[locale]/panel/dashboard/page.tsx:139` — el hint textual "Verde:
  creadas · Rojo: no-show" (`panel.dashboard.trend.hint`) es la única leyenda. Está en
  un `<p>` DESPUÉS del SVG, sin `aria-describedby` conectándolos.
- `apps/web/src/app/[locale]/panel/dashboard/page.tsx:186-208` — no hay ejes ni escala.
  El paciente ve barras verdes/rojas de "algún tamaño" sin poder saber si son 5 o 50
  citas. Al hovear se ve, pero es información ausente en el chart en sí. Es un
  bar chart sin y-axis label ni tick marks.
- Fill colores: verde `#16a34a` + rojo `#ef4444`. Verde + rojo son los peores 2 colores
  para daltonismo (protanopia/deuteranopia — ~8% de los hombres). Sin diferencias de
  patrón/textura, un usuario con daltonismo ve 2 barras del mismo tono con contornos
  similares. WCAG 1.4.1 (Use of Color) — no depender sólo del color.
- `apps/web/src/app/[locale]/panel/dashboard/page.tsx:71` — el `noShowRate` se muestra
  como "%" sin contexto de N. Un 100% no-show rate con 1 cita cerrada es distinto que
  con 100 citas. Sin sample size, el operador puede pánico por 1 no-show.
- `apps/web/src/app/[locale]/panel/dashboard/page.tsx:113-131` — la tarjeta de confirmations
  también sin sample size. Debería explicitar "21 de 55 recordatorios respondidos".
- Cards responsive: `grid-cols-1 md:grid-cols-2 xl:grid-cols-4`. En mobile 375px cada
  card ocupa 100% width y las 4 en columna → mucho scroll. La tarjeta "byStatus" tiene
  6 rows internas que estiran verticalmente. OK-ish pero podría colapsar más.

**Impacto**:

- **Usuario afectado**: recepcionista + super-admin (mira dashboard cada mañana según
  [[docs/runbook-panel|runbook-panel]]). Usuarios con lector de pantalla (baja visión) y
  con daltonismo (~8% de la población).
- **Contexto de uso**: primera pantalla del día, decisión de "cómo está la clínica esta
  semana".
- **Magnitud**: la métrica del "diferenciador" del producto (no-show anti-shift) se muestra
  en un chart INACCESIBLE. Es la peor combinación posible: la métrica que más importa,
  presentada con la peor accesibilidad.

> [!warning]+ Priority
> **P1** — Importante para escalar y para vender el producto a clínicas con
> requerimientos de a11y (públicas, red hospitalaria, etc.). Bajable a P0 si se prioriza
> pt piloto por LGPD (contexto i18n).

## Propuesta

Cuatro cambios coordinados:

1. **i18n del aria-label**:
   - Pasar `t('trend.title')` como aria-label del SVG (o generar dinamicamente
     "Tendencia últimos 14 días de citas creadas y no-show" con `t('trend.ariaLabel')`).
   - Copy nuevo: `panel.dashboard.trend.ariaLabel` = "Tendencia de citas de los últimos
     14 días — barras verdes: citas creadas, barras rojas: no-show".
2. **Leyenda visible con dots + patrón**:
   - Bloque `<div>` sobre el SVG con dos `<span>` (uno para "creadas", otro para "no-show").
     Cada uno: `<span className="inline-block h-3 w-3 bg-brand-600" aria-hidden="true"></span>
     Creadas` y análog rojo.
   - Alternativa: pattern SVG interno (dots vs líneas) para superar el problema de
     daltonismo. Verde con dots, rojo sin dots. Requiere `<pattern>` def en el SVG.
3. **Keyboard-accessible data table alternativa**:
   - Debajo del SVG, `<details>` con `<summary>Ver datos detallados</summary>` +
     `<table>` con las 14 filas × 3 columnas (fecha, creadas, no-show).
   - Copy nuevos: `panel.dashboard.trend.detailToggle`, `panel.dashboard.trend.tableHeaders.*`.
   - Alternativa alta: cada `<rect>` con `tabIndex={0}` y `aria-label={t('trend.dataPoint', {date, created, noShow})}`
     — más código pero mejor UX teclado.
4. **Sample size en cards**:
   - No-show card: `"14.3% (3 de 21 cerradas)"`.
   - Confirmations card: `"38% (21 de 55)"` (ya lo hace en cierta forma pero no visualmente
     conectado como fracción).
   - Copy nuevos: `panel.dashboard.noShow.sample`, `panel.dashboard.confirmations.sample`.
5. **Ejes mínimos en el SVG** (opcional, si el subagente lo puede hacer en <30 min):
   - Y-axis: un tick en `maxV` con texto pequeño a la izquierda del chart.
   - X-axis: primer y último día visibles arriba del chart como "05 → 19 ago".
   - Opcional: si va contra tiempo, saltar y priorizar puntos 1-4.

> [!example]- Layout con leyenda + tabla accesible
>
> ```
> ┌──────────────────────────────────────────────┐
> │ Tendencia 14 días                            │
> ├──────────────────────────────────────────────┤
> │ ● Creadas  ● No-show                          │  ← leyenda visible
> │                                              │
> │ ▓▓ ▓▓  ▓                                     │  ← chart SVG
> │ ▓▓ ▓▓ ▓▓ ▓▓ ▓▓                                │
> │ ▓▓ ▓▓ ▓▓ ▓▓ ▓▓ ▓▓ ▓▓ ▓▓                       │
> │                                              │
> │ ▶ Ver datos detallados                        │  ← <details>
> │                                              │
> │ Verde: creadas · Rojo: no-show               │  ← hint texto
> └──────────────────────────────────────────────┘
> ```

### Componentes involucrados

- `apps/web/src/app/[locale]/panel/dashboard/page.tsx` — 5 cambios arriba.
- `apps/web/messages/es.json` + `pt.json` — keys nuevas `ariaLabel`, `detailToggle`,
  `tableHeaders.*`, `noShow.sample`, `confirmations.sample`.
- Cero cambios en el backend (el shape de `GET /api/dashboard/metrics` ya trae todo lo
  que necesitamos — verificado en la [[docs/notas/2026-08-09-panel-backend-cruds|nota Panel]]).

> [!success] Criterios de aceptación
> - [ ] `aria-label` del SVG traducido dinámicamente (verificar en pt: "Tendência…").
> - [ ] Leyenda visible con dots antes del chart.
> - [ ] `<details>` con tabla accesible por teclado (Tab llega al summary + Enter abre).
> - [ ] No-show y confirmations cards muestran fracción (N de M) sin depender del hover.
> - [ ] Verificar con axe-core que el chart pasa auditoría (o al menos que el
>   `<img>` está etiquetado).
> - [ ] Tabla tiene `<caption>` traducido con `panel.dashboard.trend.tableCaption`.
> - [ ] Keys nuevas en es.json y pt.json.
> - [ ] `pnpm build` limpio.

> [!note]- Fuera de scope
> - NO se reemplaza el chart por Chart.js/Recharts (deuda documentada; MVP acepta el
>   hand-rolled).
> - NO se agrega drill-down por día.
> - NO se agrega comparativa "vs semana anterior" (feature futura del PRD post-piloto).
> - NO se implementa dark mode.

## Referencias

- [[PRD|PRD §3 — Dashboard como diferenciador]]
- [[docs/notas/2026-08-09-panel-backend-cruds|nota Panel Backend §Dashboard]]
- [WCAG 1.4.1 Use of Color](https://www.w3.org/WAI/WCAG21/Understanding/use-of-color.html)
- [WCAG 2.1.1 Keyboard](https://www.w3.org/WAI/WCAG21/Understanding/keyboard.html)

## Ejecución sugerida

- **subagent_type**: `general-purpose`
- **skill**: `frontend-design`
- **prompt para el subagente**:

```
Implementá el spec docs/ux/2026-08-09-dashboard-chart-accesible-e-i18n.md.
Contexto: AgendaZap dashboard. Usuario primario: recepcionista.
Restricciones:
- No agregar libs de charting (Chart.js/Recharts).
- Traducir el aria-label del SVG dinámicamente.
- Cero cambios en el backend.
- Keys sincronizadas en es + pt.
Al terminar: reporte con archivos + build + resultado axe del dashboard.
```
