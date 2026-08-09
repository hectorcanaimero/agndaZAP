---
title: Agenda — barra de filtros con reflow mobile y touch targets ≥44px
slug: 2026-08-09-agenda-filter-bar-mobile-y-touch-targets
priority: P1
axis: Responsive
subagent_type: general-purpose
skill: mobile-app-ui-design
status: pending
created: 2026-08-09
tags:
  - ux
  - priority/p1
  - axis/responsive
  - subagent/general-purpose
aliases:
  - agenda-filter-bar-mobile
---

# Agenda — barra de filtros con reflow mobile y touch targets ≥44px

> [!info] Contexto
> La agenda es la pantalla más usada del panel según el [[docs/runbook-panel|
> runbook-panel]]. La barra de filtros arriba tiene 6 controles (‹, input date, ›, Día,
> Semana, Select profesional, Select estado) alineados en un `flex flex-wrap items-center
> gap-3` que en desktop está OK, pero en mobile <640px el flex-wrap acomoda de forma
> caótica: los botones ‹/› quedan chicos (`h-8 px-2` = ~32×32px, bajo WCAG 2.5.5), los
> selects se separan del input, y el toggle Día/Semana pierde relación visual con el
> rango. Además el input date `<input type="date">` no tiene label visible ni aria-label,
> asistivas tech no sabe qué está editando.

## Problema

**Evidencia** (obligatoria, con file:line):

- `apps/web/src/app/[locale]/panel/agenda/AgendaClient.tsx:117-197` — la barra de filtros:
  ```
  <div className="flex flex-wrap items-center gap-3 rounded-md border ... p-3">
    <div className="flex items-center gap-1">
      <Button variant="ghost" className="h-8 px-2" onClick={...}>‹</Button>
      <input type="date" className="h-8 rounded-md border ... px-2 text-sm" />
      <Button variant="ghost" className="h-8 px-2" onClick={...}>›</Button>
    </div>
    ...
  </div>
  ```
- `AgendaClient.tsx:120-128` — los botones ‹ y › tienen `h-8 px-2` (~32×24). WCAG 2.5.5
  recomienda ≥44×44px. En mobile es tap-hostile.
- `AgendaClient.tsx:127-132` — el `<input type="date">` no tiene `<label>` asociado ni
  `aria-label`. Screen reader dice "editable" sin contexto.
- `AgendaClient.tsx:142-157` — el toggle Día/Semana usa `variant={view === 'day' ? 'primary'
  : 'ghost'}`. En mobile con flex-wrap el toggle puede quedar en la siguiente línea,
  perdiendo el pattern "segmentado" visual.
- `AgendaClient.tsx:159-197` — los 2 Selects (profesional + estado) están en un `flex
  ml-auto` que en mobile quedan estirados a la izquierda (no hay `ml-auto` real cuando
  wraps) y adoptan `w-auto` — cada uno con el largo de su texto más largo. Se pisan
  visualmente con los controles de la izquierda.
- No hay filtro colapsible en mobile ("Filtros ▾" que despliega los selects) — todo
  se muestra siempre.
- Formato de fecha del `<input type="date">` sigue el locale del navegador
  (mm/dd/yyyy en un browser en-US, dd/mm/yyyy en es), no la TZ de la clínica. Aceptable
  como quirk del input HTML5, pero merece mención.

**Impacto**:

- **Usuario afectado**: recepcionista/profesional en mobile (uso frecuente durante el
  día para consultar próximas citas).
- **Contexto de uso**: consulta rápida ("¿qué tengo ahora?"), filtro por profesional
  cuando hay 3+ profesionales.
- **Magnitud**: pantalla más usada del panel + touch targets < WCAG + input sin label
  para SR. Es el ejemplo textbook de "densidad hostil sin contexto de dispositivo".

> [!warning]+ Priority
> **P1** — Importante para escalar. La agenda es LA pantalla del panel; mala UX mobile
> aquí impacta la percepción global del producto.

## Propuesta

Tres bloques reorganizados con breakpoint claro:

1. **Bloque de fecha (row 1)** — full width en mobile:
   ```
   <div className="flex items-center gap-2">
     <Button className="min-h-[44px] w-11" aria-label={t('prevPeriod')}>‹</Button>
     <label className="sr-only" htmlFor="date-input">{t('datePicker')}</label>
     <input id="date-input" type="date" className="min-h-[44px] flex-1 sm:flex-none" />
     <Button className="min-h-[44px] w-11" aria-label={t('nextPeriod')}>›</Button>
   </div>
   ```
2. **Toggle Día/Semana (row 2)** — segmentado:
   ```
   <div className="inline-flex rounded-md border border-gray-300" role="group" aria-label={t('viewMode')}>
     <button className={cn('min-h-[44px] px-4', view === 'day' && 'bg-brand-50 text-brand-700')}>{t('viewDay')}</button>
     <button className={cn('min-h-[44px] px-4', view === 'week' && 'bg-brand-50 text-brand-700')}>{t('viewWeek')}</button>
   </div>
   ```
3. **Filtros (row 3, mobile-collapsible)**:
   ```
   <details className="sm:open"> // en mobile es collapsible, en sm+ siempre visible
     <summary className="sm:hidden">Filtros ▾</summary>
     <div className="flex flex-wrap gap-2 pt-2 sm:pt-0">
       <Select className="min-h-[44px]" ... /> // profesional
       <Select className="min-h-[44px]" ... /> // estado
     </div>
   </details>
   ```
4. **Chips de filtros activos** (opcional pero valioso):
   - Si `professionalId` está seteado, chip removible "Dra. Ríos ×".
   - Si `status` está seteado, chip removible "Confirmadas ×".
   - Mobile-friendly + hace explícito el filtro cuando el select está colapsado.

Keys nuevas:

- `panel.agenda.prevPeriod` = "Período anterior"
- `panel.agenda.nextPeriod` = "Período siguiente"
- `panel.agenda.datePicker` = "Fecha"
- `panel.agenda.viewMode` = "Vista"
- `panel.agenda.filters.toggle` = "Filtros"
- `panel.agenda.filters.clearAll` = "Quitar filtros"

### Componentes involucrados

- `apps/web/src/app/[locale]/panel/agenda/AgendaClient.tsx` — refactor de la barra líneas
  117-197.
- `apps/web/messages/es.json` + `pt.json` — keys nuevas.
- Sin cambios en el backend, ni en DayView/WeekView.

> [!success] Criterios de aceptación
> - [ ] Todos los tap targets de la barra ≥44×44px verificados con inspector.
> - [ ] `<input type="date">` tiene label (visible en desktop o sr-only) o aria-label.
> - [ ] Botones ‹/› tienen aria-label descriptivo.
> - [ ] Toggle Día/Semana con `role="group"` + `aria-label`.
> - [ ] En mobile <640px los filtros están dentro de un `<details>` colapsible.
> - [ ] En desktop ≥640px los filtros están siempre visibles.
> - [ ] Sin scroll horizontal en 375px.
> - [ ] `pnpm build` limpio.
> - [ ] Keys en es.json + pt.json.

> [!note]- Fuera de scope
> - NO se agrega drag-drop de citas.
> - NO se agrega vista mensual (`view=month`).
> - NO se cambia el shape de `GET /appointments` ni sus filtros server-side.
> - NO se agrega búsqueda por paciente en la barra (nice-to-have futuro).

## Referencias

- [[docs/runbook-panel|runbook-panel]]
- [WCAG 2.5.5 Target Size](https://www.w3.org/WAI/WCAG21/Understanding/target-size.html)
- [WCAG 4.1.2 Name, Role, Value](https://www.w3.org/WAI/WCAG21/Understanding/name-role-value.html)
- [[ux/2026-08-09-panel-mobile-navigation-drawer|spec drawer mobile]]

## Ejecución sugerida

- **subagent_type**: `general-purpose`
- **skill**: `mobile-app-ui-design`
- **prompt para el subagente**:

```
Implementá el spec docs/ux/2026-08-09-agenda-filter-bar-mobile-y-touch-targets.md.
Contexto: AgendaZap agenda del panel. Usuario: recepcionista en mobile + desktop.
Restricciones:
- Cero cambios en backend.
- Cero libs.
- Todos los touch targets ≥44×44.
- Reglas Luxon-in-front OFF (no agregar Luxon), usar Intl.DateTimeFormat.
Al terminar: reporte con archivos + build + verificación 375px con axe.
```
