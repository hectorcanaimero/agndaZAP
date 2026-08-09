---
title: Panel — tablas de CRUDs colapsan a cards en mobile <640px
slug: 2026-08-09-panel-tables-a-cards-en-mobile
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
  - panel-tables-mobile
---

# Panel — tablas de CRUDs colapsan a cards en mobile <640px

> [!info] Contexto
> Los CRUDs del panel (Servicios, Profesionales, Horarios, Bloqueos) renderizan tablas
> HTML `<table>` con 3-5 columnas. En mobile (<640px) las tablas quedan más anchas que
> el viewport y disparan scroll horizontal EN EL BODY (no en el contenedor de la tabla) —
> el operador con celular pierde la columna "Acciones" y no puede editar/eliminar sin
> scrollear a la derecha. Combinado con el problema de navegación mobile
> ([[ux/2026-08-09-panel-mobile-navigation-drawer|drawer]]), es un compound de fricción.

## Problema

**Evidencia** (obligatoria, con file:line):

- `apps/web/src/app/[locale]/panel/servicios/ServicesClient.tsx:69-127` — `<table>` con
  5 columnas: Nombre, Duración, Precio, Profesionales, Acciones. En 375px la última
  columna Acciones queda cortada. El wrapper `<div class="overflow-hidden rounded-md
  border">` NO tiene `overflow-x-auto` → el scroll cae al body y el header mobile
  desaparece cuando el paciente scrollea horizontalmente.
- `apps/web/src/app/[locale]/panel/profesionales/ProfessionalsClient.tsx:64-112` — mismo
  pattern con 3 columnas (Nombre, Servicios, Acciones). Menos denso pero el "Servicios"
  puede tener texto largo (`p.services.map((s) => s.name).join(', ')`).
- `apps/web/src/app/[locale]/panel/horarios/BusinessHoursClient.tsx:105-155` — 4 columnas
  (Día, Rango, Profesional, Acciones). En mobile queda apretado.
- `apps/web/src/app/[locale]/panel/bloqueos/TimeOffClient.tsx:112-160` — 4 columnas
  (Rango, Profesional, Motivo, Acciones). La cell de Rango contiene 2 fechas + hora →
  puede tener 40+ chars, empuja las otras columnas.
- `apps/web/src/app/[locale]/panel/faq/FaqClient.tsx:69-105` — usa cards `<div>` (no
  table). BIEN — patrón a replicar en los otros 4 archivos.
- Botones de acción (Editar/Eliminar) son `<button className="text-xs">`. Alto real
  ~16-20px. Failing WCAG 2.5.5 (Target Size ≥44×44 recomendado, ≥24×24 mínimo).

**Impacto**:

- **Usuario afectado**: recepcionista/CLINIC_ADMIN con mobile durante viajes o setup
  inicial (onboarding de clínica desde celular).
- **Contexto de uso**: CRUD de catálogo (servicios, profesionales, horarios, bloqueos) —
  usado al setup + puntual cuando hay cambios. Mobile es viable especialmente para
  bloqueos ad-hoc ("me enfermé, bloqueá hoy" desde el celular).
- **Magnitud**: 4 pantallas × N filas × mobile use → 100% de los CRUDs sufren.
  Combinado con la nav mobile actual, la experiencia mobile es funcionalmente rota para
  operaciones frecuentes.

> [!warning]+ Priority
> **P1** — Importante para escalar. Tablas horizontales scroll son un anti-pattern
> documentado (Bootstrap y Material lo saben desde 2015). Ya tenemos el patrón cards
> aplicado en `FaqClient` — sólo hay que replicarlo.

## Propuesta

Aplicar el patrón `hidden md:block` sobre la `<table>` + `<div class="md:hidden space-y-3">`
con cards en los 4 archivos:

1. **Servicios (`ServicesClient.tsx`)**:
   ```
   <div className="hidden md:block"> // tabla actual </div>
   <div className="md:hidden space-y-3">
     {services.map((s) => (
       <div className="rounded-md border border-gray-200 bg-white p-4">
         <div className="flex items-start justify-between">
           <div className="min-w-0 flex-1">
             <p className="font-medium text-gray-900">{s.name}</p>
             <p className="mt-1 text-xs text-gray-500 tabular-nums">
               {s.durationMin} min {s.bufferMin > 0 && `+${s.bufferMin}`} · ${...}
             </p>
             <p className="mt-1 text-xs text-gray-600 truncate">
               {s.professionals.map(...).join(', ')}
             </p>
           </div>
           <div className="flex flex-col gap-1 shrink-0">
             <button className="min-h-[44px] px-3 text-sm text-brand-700">Editar</button>
             <button className="min-h-[44px] px-3 text-sm text-red-600">Eliminar</button>
           </div>
         </div>
       </div>
     ))}
   </div>
   ```
2. **Profesionales** (`ProfessionalsClient.tsx`): idem, 2 columnas conceptuales
   (Nombre + Servicios) + acciones.
3. **Horarios** (`BusinessHoursClient.tsx`): card con weekday grande, rango tabular
   abajo, profesional como badge.
4. **Bloqueos** (`TimeOffClient.tsx`): card con rango prominente, profesional + motivo
   secundarios.

Botones de acción con `min-h-[44px]` cumpliendo WCAG 2.5.5. Padding horizontal generoso
para tap comfort. Alternativa: usar un menú contextual `<button>Menú</button>` que
despliegue Editar/Eliminar en un dropdown — más limpio pero requiere componente nuevo.

Empty state en cards también — actualmente el `<tr colSpan={N}>` no se traslada al bloque
cards. Nuevo empty card `<div className="rounded-md border border-gray-200 bg-white p-6
text-center text-sm text-gray-500">{t('empty')}</div>` en la vista mobile.

### Componentes involucrados

- `apps/web/src/app/[locale]/panel/servicios/ServicesClient.tsx`
- `apps/web/src/app/[locale]/panel/profesionales/ProfessionalsClient.tsx`
- `apps/web/src/app/[locale]/panel/horarios/BusinessHoursClient.tsx`
- `apps/web/src/app/[locale]/panel/bloqueos/TimeOffClient.tsx`
- Sin cambios en modales (los form modales ya son fullscreen-friendly).
- Sin cambios en `FaqClient.tsx` (ya usa cards, referencia).
- Sin nuevas keys de i18n (los mismos strings ya usados).

> [!success] Criterios de aceptación
> - [ ] En viewport <768px cada CRUD renderiza cards, no `<table>`.
> - [ ] En viewport ≥768px cada CRUD renderiza la `<table>` actual (regresión test).
> - [ ] Botones de acción con `min-h-[44px]` (verificar con inspector).
> - [ ] Empty state visible en ambas vistas (table + cards).
> - [ ] Cero overflow horizontal en el body para 375px.
> - [ ] `pnpm build` limpio.
> - [ ] Manual: navegar cada CRUD en 375px, editar y eliminar sin scroll horizontal.

> [!note]- Fuera de scope
> - NO se implementa un menú contextual dropdown (nice-to-have futuro).
> - NO se rediseña el modal de edición.
> - NO se cambia la lógica del CRUD (soft delete de Servicios/Profesionales, hard
>   delete de Horarios/Bloqueos permanece).
> - NO se aplica a `AgendaClient` (ya tiene DayView/WeekView responsivo dedicado).
> - NO se aplica a `ConversationsClient` (ya tiene grid mobile-friendly).

## Referencias

- [[docs/runbook-panel|runbook-panel — panel día a día]]
- [[ux/2026-08-09-panel-mobile-navigation-drawer|spec Panel mobile nav]]
- [WCAG 2.5.5 Target Size](https://www.w3.org/WAI/WCAG21/Understanding/target-size.html)
- `apps/web/src/app/[locale]/panel/faq/FaqClient.tsx` — referencia de patrón cards existente.

## Ejecución sugerida

- **subagent_type**: `general-purpose`
- **skill**: `mobile-app-ui-design`
- **prompt para el subagente**:

```
Implementá el spec docs/ux/2026-08-09-panel-tables-a-cards-en-mobile.md.
Contexto: AgendaZap panel, 4 CRUDs con tablas rotas en mobile.
Restricciones:
- Cero cambio funcional (sólo layout responsive).
- Reusar el patrón de cards de FaqClient como referencia.
- Cero libs.
- Cero cambio en el modal de edición.
Al terminar: reporte con archivos + build + verificación manual en 375px de al menos
2 CRUDs (Services + BusinessHours).
```
