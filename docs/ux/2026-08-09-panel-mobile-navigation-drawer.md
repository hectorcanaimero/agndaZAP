---
title: Panel — navegación mobile con drawer + hamburger (sidebar oculto <md)
slug: 2026-08-09-panel-mobile-navigation-drawer
priority: P0
axis: Responsive
subagent_type: general-purpose
skill: mobile-app-ui-design
status: pending
created: 2026-08-09
tags:
  - ux
  - priority/p0
  - axis/responsive
  - subagent/general-purpose
aliases:
  - panel-mobile-nav
---

# Panel — navegación mobile con drawer + hamburger (sidebar oculto <md)

> [!info] Contexto
> El [[PRD|PRD §2]] describe a la recepcionista como usuario primario del panel y al
> profesional/dueño como usuario "app móvil". PERO en la práctica de las clínicas
> pequeñas de LATAM, el mismo dueño que atiende usa el panel desde el celular en el
> intervalo entre pacientes (mismo device). El
> [[docs/onboarding-clinica|onboarding-clinica.md]] no restringe el panel a desktop.
> Hoy en mobile (<768px) el sidebar se oculta y se reemplaza por una barra horizontal
> con 8 links en `overflow-x-auto` — el 5º link ("Profesionales") ya queda cortado en
> iPhone SE. El operador tiene que scrollear horizontalmente cada vez que cambia de
> sección. No hay drawer, no hay hamburger, no hay jerarquía visual.

## Problema

**Evidencia** (obligatoria, con file:line):

- `apps/web/src/app/[locale]/panel/PanelShell.tsx:47-89` — el `<aside>` sidebar tiene
  `className="hidden ... md:flex"` → oculto <768px.
- `apps/web/src/app/[locale]/panel/PanelShell.tsx:104-125` — nav mobile:
  ```
  <nav className="border-b ... md:hidden">
    <ul className="flex gap-2 overflow-x-auto">
      {items.map(...)} // 8 items
  ```
  8 links (Dashboard/Agenda/Conversaciones/Servicios/Profesionales/Horarios/Bloqueos/FAQ)
  en horizontal → el 4º-5º ya queda cortado en 375px.
- `PanelShell.tsx:91-101` — header mobile: sólo muestra `clinic.name` + botón "Cerrar
  sesión" a la derecha. **No hay hamburger**. Sin toggle, la nav horizontal es la única
  vía para navegar entre secciones.
- Cada link es `<Link className="rounded-md px-3 py-1 text-sm">` (`~28px` de alto con
  padding). WCAG 2.5.5 (Target Size) recomienda ≥44×44px para touch targets. El actual
  es ~64×28 → falla la altura mínima.
- El "active state" (`bg-brand-50 font-medium text-brand-700`) sólo se ve si el link
  está en el viewport. Si estás en "FAQ" (última posición), no ves que "FAQ" está activa
  hasta que scrolleás horizontalmente.
- Efecto colateral: el `overflow-x-auto` del nav genera scroll horizontal SÓLO en el
  nav — la página SÍ tiene `overflow-x-hidden` (`main` línea 127). El operador nota una
  inconsistencia: puede scrollear la nav horizontal pero no la página.
- Cero indicación de "en qué sección estoy" con jerarquía visual global. Un breadcrumb
  o title-based nav sería complementario, pero mínimo se necesita el drawer.

**Impacto**:

- **Usuario afectado**: recepcionista + profesional/dueño con celular. Ambos usan mobile
  en algún punto del día operativo (durante viajes, entre consultas, fuera del consultorio).
- **Contexto de uso**: navegación entre secciones (patrón más usado del panel; TODAS
  las tareas empiezan navegando).
- **Magnitud**: 5 clínicas × 3-5 sesiones mobile/día × 10 navegaciones/sesión = ~200
  navegaciones/día que sufren la fricción. Riesgo peor: mistap sobre un link vecino en
  el scroll → carga página distinta → pérdida de contexto. Con touch targets <44px
  y density hostil, la probabilidad es alta.

> [!warning]+ Priority
> **P0** — El [[docs/runbook-panel|runbook-panel]] no restringe el panel a desktop.
> Con touch targets bajo WCAG, es un fail funcional + a11y en simultáneo. Además el
> ADR 0006 no lista mobile como diferido — es una omisión que corregimos ahora antes
> del piloto.

## Propuesta

Reemplazar la nav horizontal mobile por un **drawer + hamburger** con touch targets
adecuados. Sin agregar libs.

Estructura propuesta:

1. **Header mobile** (`md:hidden`):
   - Botón hamburger `<button aria-label="Abrir menú" aria-expanded={open} aria-controls="mobile-drawer">`
     a la izquierda, con icono SVG inline (3 líneas), tamaño 44×44 con padding.
   - `clinic.name` centrado (o alineado a la izquierda del hamburger).
   - Botón "Cerrar sesión" a la derecha o dentro del drawer (más limpio dentro).
2. **Drawer overlay**:
   - Div fijo con `role="dialog" aria-modal="true" aria-labelledby="drawer-title"`.
   - Se abre desde la izquierda con `translate-x-0`, cerrado con `-translate-x-full`.
   - Backdrop `bg-black/40` con click para cerrar.
   - Foca el primer link al abrir; restaura el foco al hamburger al cerrar.
   - Escape cierra.
   - Reusar el patrón de focus trap del [[ux/2026-08-09-modal-focus-trap|spec modal]].
   - Ancho `w-72` (~288px), max `85vw` para dejar contexto del canvas.
3. **Contenido del drawer**:
   - Header con `AgendaZap` + `clinic.name` (mismo que sidebar desktop).
   - Nav vertical con los mismos 8 items, cada link `min-h-[44px] w-full text-left px-4 py-3`.
   - Estado activo con `bg-brand-50 text-brand-700 font-medium`.
   - Footer con nombre + email + botón "Cerrar sesión".
4. **Al hacer click en un link del drawer**: cerrar automáticamente el drawer.
5. **Eliminar** el `<nav>` horizontal actual (líneas 104-125) — reemplazado 100% por el
   drawer.
6. **Copy** nuevos:
   - `panel.nav.openMenu` = "Abrir menú" (aria-label del hamburger).
   - `panel.nav.closeMenu` = "Cerrar menú".

> [!example]- Layout ASCII
>
> ```
> Cerrado:                     Abierto:
> ┌────────────────────────┐   ┌───────────────┬────────┐
> │ ☰  Clínica Demo    ⋮   │   │ AgendaZap  ×  │backdrp │
> ├────────────────────────┤   │ Clínica Demo  │        │
> │                        │   ├───────────────┤        │
> │  (contenido de la      │   │ • Dashboard   │        │
> │   sección actual)      │   │   Agenda      │        │
> │                        │   │   Conversac.. │        │
> │                        │   │   Servicios   │        │
> │                        │   │   Profesion.. │        │
> │                        │   │   Horarios    │        │
> │                        │   │   Bloqueos    │        │
> │                        │   │   FAQ         │        │
> │                        │   ├───────────────┤        │
> │                        │   │ Alex          │        │
> │                        │   │ alex@…        │        │
> │                        │   │ Cerrar sesión │        │
> └────────────────────────┘   └───────────────┴────────┘
> ```

### Componentes involucrados

- `apps/web/src/app/[locale]/panel/PanelShell.tsx` — reescribir el bloque mobile:
  header con hamburger + drawer overlay + eliminación de la nav horizontal actual.
- Nuevo componente `apps/web/src/app/[locale]/panel/MobileDrawer.tsx` (client) — para
  aislar la lógica del drawer (state open/close, focus management, escape handler).
- `apps/web/messages/es.json` + `pt.json` — keys `openMenu`, `closeMenu`.
- Reusar el trap de foco del [[ux/2026-08-09-modal-focus-trap|spec modal]] (si el modal
  se refactoriza a un `<FocusTrapContainer>`, el drawer lo consume; si se mantiene inline,
  copiar la utilidad).

> [!success] Criterios de aceptación
> - [ ] En viewport <768px: el sidebar `<aside>` sigue oculto, y aparece un hamburger en el header.
> - [ ] Click en hamburger abre el drawer con transición.
> - [ ] Todos los touch targets del drawer son ≥44×44px verificados con inspector.
> - [ ] Click en un link del drawer navega y cierra el drawer.
> - [ ] Backdrop, Escape y botón "×" del drawer cierran.
> - [ ] Focus trap dentro del drawer funciona (Tab loop).
> - [ ] Al cerrar el drawer, el foco vuelve al hamburger.
> - [ ] `aria-expanded` del hamburger refleja open/close.
> - [ ] En viewport ≥768px: comportamiento del sidebar sin cambios (test de regresión).
> - [ ] `pnpm build` limpio; performance del bundle sin bump significativo (drawer client-only).
> - [ ] Verificar en iPhone SE (375px) que ningún link queda cortado.
> - [ ] Contraste del hamburger y del active state pasa AA.

> [!note]- Fuera de scope
> - NO se cambia la navegación desktop.
> - NO se implementa un breadcrumb (nice-to-have futuro).
> - NO se agrega swipe-to-open (nice-to-have, requiere touch handlers).
> - NO se persiste el "estado del drawer" — cada navegación empieza cerrado.

## Referencias

- [[PRD|PRD §2 — usuarios y dispositivos]]
- [[docs/runbook-panel|runbook-panel — panel día a día]]
- [WCAG 2.5.5 Target Size](https://www.w3.org/WAI/WCAG21/Understanding/target-size.html)
- [[ux/2026-08-09-modal-focus-trap|spec Modal focus trap]] (patrón reutilizable)

## Ejecución sugerida

- **subagent_type**: `general-purpose`
- **skill**: `mobile-app-ui-design`
- **prompt para el subagente**:

```
Implementá el spec docs/ux/2026-08-09-panel-mobile-navigation-drawer.md.
Contexto: AgendaZap panel, PanelShell.tsx. Usuario mobile: recepcionista + profesional.
Restricciones:
- No agregar libs (nada de headlessui, radix).
- Reusar el patrón de focus trap del spec de Modal (si el modal se refactoriza primero,
  consumir esa utilidad; si no, copiar inline).
- Verificar visualmente en iPhone SE (375px) y iPhone 15 (393px).
- Cero cambios en el layout desktop (>=768px).
Al terminar: reporte con archivos modificados + build + screenshots (o descripción) de
mobile abierto/cerrado + verificación de touch targets con axe-core o inspector.
```
