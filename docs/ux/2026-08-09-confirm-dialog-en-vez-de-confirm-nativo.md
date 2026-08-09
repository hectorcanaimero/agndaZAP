---
title: Reemplazar `window.confirm()` nativo por Modal ConfirmDialog con i18n y contexto
slug: 2026-08-09-confirm-dialog-en-vez-de-confirm-nativo
priority: P1
axis: A11y
subagent_type: general-purpose
skill: frontend-design
status: done
created: 2026-08-09
tags:
  - ux
  - priority/p1
  - axis/a11y
  - subagent/general-purpose
aliases:
  - confirm-dialog-panel
---

# Reemplazar `window.confirm()` nativo por Modal ConfirmDialog con i18n y contexto

> [!info] Contexto
> Los 5 CRUDs del panel (Servicios, Profesionales, Horarios, Bloqueos, FAQ) usan
> `window.confirm()` nativo del browser para confirmar Delete. UX inconsistente con el
> resto del panel (que usa el `Modal` propio), imposible de traducir con next-intl si
> el navegador está en un idioma distinto, sin contexto de qué se está eliminando (sólo
> "¿Desactivar este servicio?" — cuál servicio?), y con contrastes/tipografía impuestos
> por el sistema operativo. Además el `confirm()` bloquea el thread principal — mal
> UX en mobile.

## Problema

**Evidencia** (obligatoria, con file:line):

- `apps/web/src/app/[locale]/panel/servicios/ServicesClient.tsx:53` — `if (!confirm(t('confirmDelete'))) return;`.
- `apps/web/src/app/[locale]/panel/profesionales/ProfessionalsClient.tsx:48` — idem.
- `apps/web/src/app/[locale]/panel/horarios/BusinessHoursClient.tsx:89` — idem.
- `apps/web/src/app/[locale]/panel/bloqueos/TimeOffClient.tsx:97` — idem.
- `apps/web/src/app/[locale]/panel/faq/FaqClient.tsx:42` — idem.
- Ninguno menciona qué se elimina. Ej: "¿Desactivar este servicio? Podés reactivarlo
  después." — bien, pero si tenés 20 servicios y borrás el equivocado, no hay recovery.
- El `confirm()` nativo NO cumple el estándar de accesibilidad del panel (no puede
  focus-trapear, no puede llevar título propio, no puede tener botones traducidos si el
  browser está en otro idioma).
- [[adr/0004-pii-y-compliance|ADR 0004]] menciona "consentimiento explícito" — mismo
  principio aplica a acciones destructivas: el operador tiene que ver claramente qué
  destruye antes.
- El "Eliminar" de Servicios/Profesionales es en realidad SOFT DELETE (`active=false`),
  como aclara el copy. El de Horarios/Bloqueos/FAQ es HARD DELETE. La confirmación
  actual NO diferencia. Un operador confía en el copy y termina borrando FAQs de las
  que no puede recuperar.

**Impacto**:

- **Usuario afectado**: recepcionista (todos los CRUDs), profesional (FAQ).
- **Contexto de uso**: cada acción destructiva. Un mistap = pérdida de config.
- **Magnitud**: 5 CRUDs × N deletes/mes. Ratio bajo pero severidad alta cuando ocurre
  (recuperación desde DB backup, ADR 0006 no cubre este flujo).

> [!warning]+ Priority
> **P1** — Consistencia + a11y compound. Reduce riesgo operativo real.

## Propuesta

Nuevo componente compartido `apps/web/src/components/ui/confirm-dialog.tsx`:

```tsx
interface ConfirmDialogProps {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void | Promise<void>;
  title: string;
  description: React.ReactNode;
  confirmLabel: string;    // ej: "Eliminar", "Desactivar"
  cancelLabel?: string;    // default: t('common.cancel')
  variant?: 'default' | 'destructive';  // color del botón confirm
  itemName?: string;       // ej: nombre del servicio a eliminar
}
```

Comportamiento:

- Consume `Modal` (hereda focus trap del [[ux/2026-08-09-modal-focus-trap|spec Modal]]).
- Foco inicial en el botón "Cancelar" (default safe, no destructive) — WAI-ARIA best practice.
- Enter → confirma; Escape → cierra.
- Variant `destructive` usa `bg-red-600 text-white` (contraste 5.9:1 AA).
- Loading state cuando `onConfirm` es async — spinner en el botón.
- Aria: `role="alertdialog"` (más específico que `dialog` para confirmaciones destructivas)
  + `aria-describedby` apuntando al description.

Migración de los 5 callers:

```tsx
// Antes
async function deleteOne(id: string) {
  if (!confirm(t('confirmDelete'))) return;
  const res = await fetcher(`/api/services/${id}`, { method: 'DELETE' });
  ...
}

// Después
const [deleteTarget, setDeleteTarget] = useState<Service | null>(null);
async function performDelete() {
  if (!deleteTarget) return;
  const res = await fetcher(`/api/services/${deleteTarget.id}`, { method: 'DELETE' });
  setDeleteTarget(null);
  if (res.ok) { ... } else { ... }
}
...
<ConfirmDialog
  open={deleteTarget !== null}
  onClose={() => setDeleteTarget(null)}
  onConfirm={performDelete}
  title={t('confirmDelete.title')}
  description={
    <>
      Vas a desactivar <strong>{deleteTarget?.name}</strong>.
      {' '}Podés reactivarlo después.
    </>
  }
  confirmLabel={t('delete')}
  variant="destructive"
  itemName={deleteTarget?.name}
/>
```

Copy nuevos:

- `common.cancel`
- `panel.services.confirmDelete.title` = "¿Desactivar servicio?"
- `panel.services.confirmDelete.description` (con `{name}` interpolado)
- Análogos para professionals, businessHours, timeOff, faq.
- Diferenciar copy soft vs hard delete:
  - Servicios/Profesionales: "Podés reactivarlo después."
  - Horarios/Bloqueos/FAQ: "**Esta acción no se puede deshacer.**"

### Componentes involucrados

- `apps/web/src/components/ui/confirm-dialog.tsx` (nuevo).
- `apps/web/src/app/[locale]/panel/servicios/ServicesClient.tsx` — reemplazar `confirm()`.
- `apps/web/src/app/[locale]/panel/profesionales/ProfessionalsClient.tsx` — idem.
- `apps/web/src/app/[locale]/panel/horarios/BusinessHoursClient.tsx` — idem.
- `apps/web/src/app/[locale]/panel/bloqueos/TimeOffClient.tsx` — idem.
- `apps/web/src/app/[locale]/panel/faq/FaqClient.tsx` — idem.
- `apps/web/messages/es.json` + `pt.json` — nuevas keys de confirmación por CRUD.

> [!success] Criterios de aceptación
> - [ ] Ningún caller usa `window.confirm()` (grep `apps/web/src` limpio).
> - [ ] Cada delete muestra un `ConfirmDialog` con el nombre del ítem en la descripción.
> - [ ] Soft deletes tienen copy "podés reactivar"; hard deletes tienen "no se puede deshacer".
> - [ ] `role="alertdialog"` presente.
> - [ ] Foco inicial en Cancelar, no en Confirm.
> - [ ] Escape cierra sin confirmar.
> - [ ] Botón destructive con contraste ≥ 4.5:1.
> - [ ] Focus trap hereda del `Modal` (depende de [[ux/2026-08-09-modal-focus-trap|spec Modal]]).
> - [ ] `pnpm build` + tests verdes.

> [!note]- Fuera de scope
> - NO se agrega undo/redo (deuda futura si el operador pide).
> - NO se agrega captcha para deletes masivos.
> - NO se cambia la semántica del backend (soft vs hard delete).

## Referencias

- [[adr/0004-pii-y-compliance|ADR 0004 §consentimiento explícito]]
- [[ux/2026-08-09-modal-focus-trap|spec Modal focus trap]] (dependencia)
- [WAI-ARIA alertdialog pattern](https://www.w3.org/WAI/ARIA/apg/patterns/alertdialog/)

## Ejecución sugerida

- **subagent_type**: `general-purpose`
- **skill**: `frontend-design`
- **prompt para el subagente**:

```
Implementá el spec docs/ux/2026-08-09-confirm-dialog-en-vez-de-confirm-nativo.md.
Contexto: AgendaZap panel, 5 CRUDs con confirm() nativo.
Restricciones:
- Nuevo componente `ConfirmDialog` consume el `Modal` existente (herencia de focus trap).
- Cero libs nuevas.
- Migración de los 5 callers.
- Copy diferenciado soft vs hard delete.
Al terminar: reporte con archivos + build + confirmación de grep `window.confirm` limpio +
verificación manual de un delete en Services (soft) y uno en Bloqueos (hard).
```
