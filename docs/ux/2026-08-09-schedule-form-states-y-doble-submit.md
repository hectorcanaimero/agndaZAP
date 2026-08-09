---
title: Página pública `/agendar` — invisible states, prevención de doble submit y skeleton
slug: 2026-08-09-schedule-form-states-y-doble-submit
priority: P0
axis: States
subagent_type: general-purpose
skill: frontend-design
status: pending
created: 2026-08-09
tags:
  - ux
  - priority/p0
  - axis/states
  - subagent/general-purpose
aliases:
  - schedule-form-states
---

# Página pública `/agendar` — invisible states, prevención de doble submit y skeleton

> [!info] Contexto
> La página pública SSR `/agendar/[clinicSlug]` es la cadena PII crítica del paciente
> ([[ARCHITECTURE|Arquitectura §Canales de entrada]] + [[adr/0004-pii-y-compliance|
> ADR 0004]]) y uno de los 2 canales de agendamiento del MVP. Un fallo aquí = cero
> conversión. Hoy los estados invisibles son varios: loading = `…` (una elipsis literal),
> sin skeleton de slots, sin indicador de "estamos enviando", el botón Submit sólo se
> deshabilita mientras `isSubmitting` de rhf está true pero no hay protección contra el
> doble click en el ventana [click → click] antes de que arranque el submit, y el flujo
> post-409 (slot tomado) refetchea slots pero pierde contexto visual del "por qué te
> refresqué".

## Problema

**Evidencia** (obligatoria, con file:line):

- `apps/web/src/app/[locale]/agendar/[clinicSlug]/ScheduleForm.tsx:370-371` — loading state
  = `<p className="text-sm text-gray-500">…</p>`. Sin skeleton de slots, sin spinner. El
  paciente no sabe si el sistema está calculando o si algo se colgó. En redes lentas
  (mobile 3G, típico LATAM) esto es 2-4 segundos de "pantalla muerta".
- `ScheduleForm.tsx:374-375` — el `empty state` "No hay horarios disponibles esta semana"
  es una `<p>` gris pequeña. No sugiere qué hacer (¿elegir otro profesional? ¿otro
  servicio? ¿probar la próxima semana?). Un CTA "Ver próxima semana" o "Cambiar profesional"
  no existe.
- `ScheduleForm.tsx:230-284` — `onSubmit` no tiene guard contra doble click en el
  intervalo entre el primer click y el `isSubmitting=true` de rhf. En redes lentas hay
  ventana. Aunque el backend tiene rate-limit 5/min por slug+ip, el UX del paciente ve
  "Confirmando..." → "Confirmando..." → 429 "Demasiados intentos" — mensaje engañoso porque
  fue el mismo submit rebotando.
- `ScheduleForm.tsx:274-278` — el manejo del 409:
  ```
  if (result.status === 409) {
    setSubmitError(t('errors.slotTaken'));
    await refetchSlots();
    return;
  }
  ```
  Refetchea slots (bien), pero: (a) el `submitError` sigue arriba mientras el paciente
  elige otro slot, (b) no hay foco automático en la lista de slots reofrecida, (c) el
  paciente puede no darse cuenta que el flujo cambió y volver a hacer submit del mismo
  slot que ya no existe.
- `ScheduleForm.tsx:436-440` — el bloque de error es `<div role=` **implícito** — no
  tiene `role="alert"` explícito. Screen reader no lo anuncia como interrupción. WCAG
  4.1.3 (Status Messages).
- `ScheduleForm.tsx:442` — el botón Submit tiene `disabled={isSubmitting}` pero NO cambia
  el estilo visual más allá del `disabled:opacity-70` heredado de `Button` (línea 12 de
  `button.tsx`). Sin spinner ni cambio de icon. En redes lentas el paciente no ve claro
  que el submit está en curso.
- `ScheduleForm.tsx:388-401` — los slot buttons ya seleccionados tienen `border-brand-600
  bg-brand-500 text-white`. Contraste `text-white on bg-brand-500 (#22c55e)` = 2.83:1 →
  **FALLA WCAG AA** para texto pequeño (necesita 4.5:1). Contraste normal (`text-gray-700
  on bg-white`) sí pasa. El estado seleccionado, ironicamente el más importante, es el que
  falla contraste.
- `ScheduleForm.tsx:182,214` — `todayISO = new Date().toISOString()` — el `from` que se
  envía es la hora exacta del navegador. Si el paciente cambia de TZ (viajando, VPN), o
  el reloj está desincronizado, puede pedir slots desde una fecha "en el pasado" según
  la clínica → backend ignora esos slots. Debería anclar a "hoy 00:00 en la TZ de la
  clínica" (que se pasa como prop `timezone`).

**Impacto**:

- **Usuario afectado**: paciente (usuario final del [[PRD|PRD §2]]) — nunca vuelve si
  la primera experiencia falla.
- **Contexto de uso**: happy path (agendar); edge case (429 rebote por doble click); 409
  race con otro paciente en el mismo slot.
- **Magnitud**: cada friction ~5-10% de conversión perdida ([[PRD|PRD §8]] "onboarding
  <1h" implica UX suave). El contraste del slot seleccionado es un fail WCAG AA visible
  al 100% de los pacientes que llegan a elegir slot. El doble submit → 429 es una
  experiencia culpando al paciente por un bug del cliente.

> [!warning]+ Priority
> **P0** — Cadena crítica de PII paciente. Contraste WCAG AA fallando en la acción más
> importante (elegir slot). Sin fix, cualquier auditoría del cliente lo levanta.

## Propuesta

Siete cambios coordinados en `ScheduleForm.tsx`:

1. **Skeleton de slots** en vez de `…`:
   - Cuando `slotsLoading`, renderizar 3 filas × 4 buttons skeleton con
     `animate-pulse bg-gray-200 h-9 w-16 rounded-md`.
   - Mínimo 300ms de skeleton para evitar flash cuando la red es rápida.
2. **Empty state con CTAs**:
   - Cuando `slots.length === 0` y no hay error:
     - Mensaje: "No encontramos horarios en los próximos 7 días."
     - CTA 1: `<button>Probar la próxima semana</button>` → bump del `days` a 14.
     - CTA 2: si hay ≥2 profesionales para el servicio, "Cambiar profesional".
   - Copy nuevos: `form.emptyDescription`, `form.tryNextWeek`, `form.tryOtherProfessional`.
3. **Doble submit lock**:
   - Nuevo state `const [submitLock, setSubmitLock] = useState(false)`.
   - Al entrar en `onSubmit`, `if (submitLock) return; setSubmitLock(true);`. En finally
     reset (o mantener locked hasta redirect en caso de éxito).
   - Alternativa cleaner: aprovechar el mismo `isSubmitting` de rhf pero envolviendo en un
     `if (isSubmitting) return` al inicio del handler.
4. **Botón submit con spinner**:
   - Cuando `isSubmitting`, mostrar `<Spinner />` (SVG inline animado) + texto.
   - Todos los slot buttons deshabilitados durante el submit (`disabled={isSubmitting}`) —
     evita que el paciente cambie de slot mid-flight.
5. **Contraste del slot seleccionado**:
   - Reemplazar `bg-brand-500 text-white` por `bg-brand-600 text-white` (`#16a34a` on
     white → 4.83:1 con text-white → pasa AA). O agregar `outline outline-2 outline-offset-2
     outline-brand-700` para marcar visualmente sin depender sólo del fill.
   - Documentar el token en `tailwind.config.ts` como `brand.500=selected-bg, brand.600=
     selected-bg-accessible`. Ver [[ux/2026-08-09-design-system-tokens-y-dedup|
     spec design system]].
6. **`role="alert"` en submitError**:
   - `<div role="alert" aria-live="assertive" className="rounded-md bg-red-50 ...">`.
   - Cuando cambia el submitError, screen reader lo anuncia.
7. **Anchor de `from` en la TZ de la clínica**:
   - Reemplazar `const todayISO = new Date().toISOString();` por un helper que compute
     "hoy 00:00 en `props.timezone`" usando `Intl.DateTimeFormat` con la TZ (o pasar el
     `from` desde el server como prop pre-computada).
   - No agregar Luxon a `apps/web` ([[adr/0006-panel-mvp-y-deuda|ADR 0006 §Reglas]]).
   - Sugerencia: helper `todayStartInTZ(tz: string): string` que use
     `new Intl.DateTimeFormat('en-CA', {timeZone: tz}).format(new Date())` + reconstruir
     el ISO. Determinístico.
8. **409: foco automático + limpieza del submitError al elegir nuevo slot**:
   - Después de `await refetchSlots()`, `document.querySelector<HTMLButtonElement>('[data-slot]')?.focus()`.
   - Cuando cambia `selectedSlot` (ya reset por `refetchSlots`), limpiar `submitError`
     con un `useEffect` que observe `selectedSlot`.

> [!example]- Estados visuales del bloque "Horario"
>
> ```
> Empty (no combinación):
>   Elegí servicio y profesional para ver horarios.
>
> Loading:
>   ▓▓▓▓ ▓▓▓▓ ▓▓▓▓ ▓▓▓▓   (4 skeletons)
>   ▓▓▓▓ ▓▓▓▓ ▓▓▓▓
>
> Error:
>   No pudimos cargar los horarios. [Reintentar]
>
> Empty (no slots):
>   No hay horarios en los próximos 7 días.
>   [Probar próxima semana]  [Cambiar profesional]
>
> Loaded:
>   Lunes 12 ago
>   [09:00] [09:30] [10:00] [10:30]
>   Martes 13 ago
>   [09:00] [11:00] [11:30]
>
> Selected slot (WCAG AA):
>   ...
>   [10:00] ← bg-brand-600 text-white outline-brand-700 (4.83:1)
>   ...
> ```

### Componentes involucrados

- `apps/web/src/app/[locale]/agendar/[clinicSlug]/ScheduleForm.tsx` — 8 cambios arriba.
- `apps/web/messages/es.json` + `pt.json` — keys nuevas para empty CTAs.
- `apps/web/src/lib/utils.ts` (o helper nuevo) — `todayStartInTZ`, `isSlotButtonSelected`.
- Cero cambios en backend.

> [!success] Criterios de aceptación
> - [ ] Loading state: skeleton en vez de `…`.
> - [ ] Empty state (no slots): mensaje + 1-2 CTAs.
> - [ ] Doble click en Submit → 1 request, no 2 (verificar en DevTools Network).
> - [ ] Botón submit muestra spinner + texto durante `isSubmitting`.
> - [ ] Contraste del slot seleccionado ≥ 4.5:1 con axe-core.
> - [ ] `submitError` tiene `role="alert"` + `aria-live="assertive"`.
> - [ ] `from` de availability se computa con la TZ de la clínica, no del navegador.
> - [ ] Después de 409, el foco va al primer slot reofrecido.
> - [ ] `pnpm build` limpio.
> - [ ] Manual: probar en throttling 3G del DevTools que las transiciones se ven suaves.

> [!note]- Fuera de scope
> - NO se agrega captcha ni Turnstile ([[adr/0004-pii-y-compliance|ADR 0004]] lo deja
>   post-piloto).
> - NO se agrega analytics ni tracking de conversión.
> - NO se redisea el layout del form (2 columnas, sticky sidebar).
> - NO se implementa multi-step wizard (form actual es lineal, funciona para MVP).

## Referencias

- [[PRD|PRD §2 Paciente + §3.1 flujo público]]
- [[ARCHITECTURE|Arquitectura §Canales de entrada]]
- [[adr/0004-pii-y-compliance|ADR 0004 — PII/PHI compliance]]
- [[notas/2026-08-08-bloque-3-pagina-publica|nota Bloque 3 Página pública]]
- [WCAG 2.4.7 Focus Visible](https://www.w3.org/WAI/WCAG21/Understanding/focus-visible.html)
- [WCAG 4.1.3 Status Messages](https://www.w3.org/WAI/WCAG21/Understanding/status-messages.html)

## Ejecución sugerida

- **subagent_type**: `general-purpose`
- **skill**: `frontend-design`
- **prompt para el subagente**:

```
Implementá el spec docs/ux/2026-08-09-schedule-form-states-y-doble-submit.md.
Contexto: AgendaZap página pública, cadena PII del paciente. Usuario: paciente final.
Restricciones:
- No agregar Luxon en apps/web (regla ADR 0006).
- Cero cambios en backend.
- Skeleton usa animate-pulse de Tailwind.
- Contraste del slot seleccionado verificado con axe-core.
- Doble submit lock probado con throttling 3G en DevTools.
Al terminar: reporte con archivos + build + verificación axe + resultado DevTools Network
(1 sola request por submit).
```
