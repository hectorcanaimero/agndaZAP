---
title: Modal — focus trap del Tab y elemento inicial correcto
slug: 2026-08-09-modal-focus-trap
priority: P0
axis: A11y
subagent_type: general-purpose
skill: frontend-design
status: pending
created: 2026-08-09
tags:
  - ux
  - priority/p0
  - axis/a11y
  - subagent/general-purpose
aliases:
  - modal-focus-trap
---

# Modal — focus trap del Tab y elemento inicial correcto

> [!info] Contexto
> El `Modal` hand-rolled ([[adr/0006-panel-mvp-y-deuda|ADR 0006 §8 — B.6]]) cubre focus
> management al abrir/cerrar (guarda el previo, foca el primer interactivo, restaura
> al cerrar) — un fix documentado del audit de Panel. **Pero no implementa focus trap**:
> el Tab desde el último elemento del modal se va al background, y Shift+Tab desde el
> primero también. Combinado con el `<button aria-label="Cerrar">` en el header, el
> operador con teclado puede perder el foco fuera del modal, seguir tabulando en el DOM
> subyacente (que quedó con `body { overflow: hidden }` pero SÍ es tabulable), y hacer
> acciones destructivas por accidente. Es una falla WCAG 2.4.3 (Focus Order) y 2.1.2
> (No Keyboard Trap — el opuesto: acá falta el trap POSITIVO del modal).

## Problema

**Evidencia** (obligatoria, con file:line):

- `apps/web/src/components/ui/modal.tsx:33-64` — el `useEffect` maneja Escape, block scroll,
  y focus del primer interactivo. **No hay handler para Tab/Shift+Tab que cicle dentro
  del modal**.
- `apps/web/src/components/ui/modal.tsx:69-75` — el overlay `<div role="dialog" aria-modal="true"
  onClick={onClose}>` cierra al click, pero el elemento no tiene `inert` ni `aria-hidden`
  aplicado al resto del DOM. Herramientas asistivas modernas sí respetan `aria-modal="true"`
  pero el Tab nativo del browser NO.
- `apps/web/src/components/ui/modal.tsx:88-108` — el botón "Cerrar" (X) es tabulable. El
  `containerRef` foca el primer elemento — que es este botón. Para modales de formulario
  (Servicios/Profesionales/Horarios/Bloqueos/FAQ), el foco inicial DEBERÍA ser el primer
  input del form, no el botón cerrar. Hoy el operador que abre "Nuevo servicio" con teclado
  tiene que hacer Tab una vez para llegar al input "Nombre".
- `apps/web/src/app/[locale]/panel/servicios/ServicesClient.tsx:283-296` — el modal
  contiene checkboxes M-N de profesionales. Si el operador tabula desde el último checkbox,
  se va al DOM background — probablemente al botón "Editar" o "Eliminar" de la row que
  abrió el modal. Un Enter/Space accidental dispara `deleteOne`.
- Impacto especial en `AgendaClient.tsx:216-277` — el modal de detalle de cita muestra
  los botones de transición de estado (Cancelar/Confirmar/etc.). Tab fuera del modal puede
  caer sobre el input de filtro por profesional o sobre "‹/›" del navegador — el operador
  cambia el rango de fechas sin querer.

**Impacto**:

- **Usuario afectado**: cualquier usuario con teclado (baja visión, motor accessibility,
  power users que evitan el mouse — comunes en recepción).
- **Contexto de uso**: cada abrir/cerrar de modal en Servicios, Profesionales, Horarios,
  Bloqueos, FAQ, Agenda (detalle de cita). Es el patrón más usado del panel.
- **Magnitud**: 6 secciones × N modales/día. WCAG 2.4.3 y 2.4.7 (Focus Visible + Focus
  Order) marcan violación media. Riesgo concreto de acciones destructivas por Tab escape.

> [!warning]+ Priority
> **P0** — WCAG AA es baseline no lujo (regla del skill). El fix es contenido y
> beneficia TODOS los modales de una vez. Además reduce riesgo de acciones destructivas
> por escape del foco.

## Propuesta

Extender `Modal` en `apps/web/src/components/ui/modal.tsx`:

1. **Focus trap con Tab/Shift+Tab**:
   - En el `useEffect`, listener adicional para `keydown` con `key === 'Tab'`:
     - Consultar `containerRef.current!.querySelectorAll<HTMLElement>('button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')`.
     - Filtrar por `isVisible` (offsetParent !== null).
     - Si Tab desde el último → `preventDefault` + `first.focus()`.
     - Si Shift+Tab desde el primero → `preventDefault` + `last.focus()`.
   - Guardar la lista de focusables al abrir; recomputar si el DOM del modal cambia
     (opcional, usar `MutationObserver` sólo si es necesario — para MVP, recomputar en
     cada Tab es aceptable).
2. **Prop `initialFocus`** con default "primer interactivo excluyendo el botón cerrar":
   - Nueva prop opcional `initialFocusRef?: RefObject<HTMLElement>` — si viene, el modal
     foca ese ref al abrir.
   - Si no viene, el default cambia: el primer focusable EXCLUYENDO el botón "Cerrar" (X)
     que es cerrado en `<div class="border-b ...">` — se puede identificar por `data-close-button`.
3. **Marcado del botón cerrar**: agregarle `data-close-button="true"` para que el selector
   del punto 2 lo salte y para permitir tests que lo identifiquen sin depender del svg
   interno.
4. **Aria mejorado**: `aria-labelledby` en el `<div role="dialog">` que apunte al `id` del
   `<h2>` del header — hoy usa `aria-label={title}` (funciona pero `labelledby` es más
   robusto y permite escapar caracteres/formato).

> [!example]- Snippet propuesto (pseudocódigo)
>
> ```tsx
> // useEffect al abrir el modal
> const container = containerRef.current;
> if (!container) return;
>
> function getFocusables(): HTMLElement[] {
>   const nodes = container.querySelectorAll<HTMLElement>(
>     'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
>   );
>   return Array.from(nodes).filter(n => n.offsetParent !== null);
> }
>
> function trap(e: KeyboardEvent) {
>   if (e.key !== 'Tab') return;
>   const focusables = getFocusables();
>   if (focusables.length === 0) return;
>   const first = focusables[0]!;
>   const last = focusables[focusables.length - 1]!;
>   if (e.shiftKey && document.activeElement === first) {
>     e.preventDefault(); last.focus();
>   } else if (!e.shiftKey && document.activeElement === last) {
>     e.preventDefault(); first.focus();
>   }
> }
> document.addEventListener('keydown', trap);
> // ... cleanup ...
> ```

### Componentes involucrados

- `apps/web/src/components/ui/modal.tsx` — cambios arriba.
- Todos los callers heredarán el trap automáticamente. Sin cambios en:
  - `ServicesClient.tsx` (form modal + confirm delete)
  - `ProfessionalsClient.tsx` (form modal + confirm delete)
  - `BusinessHoursClient.tsx`, `TimeOffClient.tsx`, `FaqClient.tsx`, `AgendaClient.tsx`.
- Nueva prop opcional `initialFocusRef` — retrocompatible.

> [!success] Criterios de aceptación
> - [ ] Tab desde el último focusable dentro del modal → vuelve al primer focusable.
> - [ ] Shift+Tab desde el primer focusable → va al último.
> - [ ] Escape sigue cerrando (comportamiento actual preservado).
> - [ ] Click en overlay sigue cerrando (comportamiento actual preservado).
> - [ ] El foco inicial NO es el botón "Cerrar" — es el primer input/checkbox/button del body.
> - [ ] Screen reader anuncia el título correctamente (verificar con VoiceOver/NVDA una vuelta).
> - [ ] Contraste del botón "Cerrar" cumple AA (hoy `text-gray-400 hover:text-gray-700` —
>   revisar contra `bg-white`: gray-400 = 3.56:1 sobre white → FALLA AA para texto pequeño.
>   Cambiar a `text-gray-500` = 4.6:1). Icono cerrar es "text" en términos WCAG cuando
>   representa acción.
> - [ ] `pnpm test` y `pnpm build` verdes.
> - [ ] Manual: abrir cada modal (Services, Professionals, BH, TimeOff, FAQ, Agenda detail)
>   y verificar trap funciona.

> [!note]- Fuera de scope
> - NO se aplica `inert` al DOM subyacente (soporte pre-Safari 15.4 limitado; el trap
>   nativo alcanza para AA).
> - NO se implementa un `FocusTrap` de una lib externa (react-focus-lock, radix-ui) —
>   se mantiene la política del ADR 0006 de "cero libs nuevas".
> - NO se reemplaza el `alert-dialog` pattern (para "¿confirmás eliminar?" ver
>   [[ux/2026-08-09-confirm-dialog-en-vez-de-confirm-nativo|spec confirm dialog]]).

## Referencias

- [[adr/0006-panel-mvp-y-deuda|ADR 0006 §8 B.6 — Modal focus management (parcial)]]
- [WCAG 2.4.3 Focus Order](https://www.w3.org/WAI/WCAG21/Understanding/focus-order.html)
- [WCAG 2.1.2 No Keyboard Trap](https://www.w3.org/WAI/WCAG21/Understanding/no-keyboard-trap.html)
- [[SPEC|SPEC §5 — Estándares del proyecto]]

## Ejecución sugerida

- **subagent_type**: `general-purpose`
- **skill**: `frontend-design`
- **prompt para el subagente**:

```
Implementá el spec docs/ux/2026-08-09-modal-focus-trap.md.
Contexto: AgendaZap panel, componente Modal compartido por 6+ callers.
Restricciones:
- No agregar libs de a11y (react-focus-lock, radix). Trap manual.
- Retrocompatible: initialFocusRef es opcional.
- Testear manualmente los 6 modales del panel para verificar que ninguno se rompió.
- No cambiar el comportamiento de Escape ni de click en overlay.
Al terminar: reporte con archivos modificados + build + verificación keyboard-only de al menos
2 modales (Services form + Agenda detail).
```
