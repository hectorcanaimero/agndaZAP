---
title: Login — autoFocus, contexto de la clínica, hint de recovery no-existente
slug: 2026-08-09-login-polish-autofocus-y-context
priority: P2
axis: Density
subagent_type: general-purpose
skill: frontend-design
status: pending
created: 2026-08-09
tags:
  - ux
  - priority/p2
  - axis/density
  - subagent/general-purpose
aliases:
  - login-polish
---

# Login — autoFocus, contexto de la clínica, hint de recovery no-existente

> [!info] Contexto
> El login es la primera pantalla que ve el operador cada día. Hoy es funcional pero
> mínimo: título "Iniciá sesión", campos email + password, botón Entrar. No hay:
> autoFocus en email (el operador tiene que clickear), sin hint sobre "no tenés cuenta
> — hablá con super-admin" (recovery no existe, [[adr/0005-auth-mvp-y-deuda|ADR 0005 §8]]
> lo lista como deuda), sin ícono/logo, contraste del footer/subtitle en el límite.
> Los mensajes de error de 429 ("Demasiados intentos") son user-friendly, pero no dicen
> "esperá 15 minutos" (que es el `EXPIRE 900s` del backend).

## Problema

**Evidencia** (obligatoria, con file:line):

- `apps/web/src/app/[locale]/login/LoginForm.tsx:81-89` — el input `email` no tiene
  `autoFocus`. Al cargar la página el foco está en `<body>`, el operador debe clickear.
- `apps/web/src/app/[locale]/login/LoginForm.tsx:71-119` — el card del login mide
  `max-w-sm` (~384px). El subtitle "Ingresá con tu email y contraseña" es informativo
  pero no dice de qué producto. En un tab abierto en background, no se identifica
  visualmente que es AgendaZap.
- `apps/web/src/app/[locale]/login/LoginForm.tsx:60-68` — mensajes de error:
  - `errors.invalidCredentials` = "Credenciales inválidas." — ok.
  - `errors.tooManyAttempts` = "Demasiados intentos. Probá en un rato." — vago. El
    backend expira el counter a 900s (15 min). Mejor: "Demasiados intentos. Probá en
    15 minutos." (con {minutes} si se puede leer del header, o valor fijo si es
    consistente).
- **No hay hint** de "olvidé mi contraseña" ni de "no tenés cuenta". El primer usuario
  que olvide su contraseña queda bloqueado sin flujo — [[adr/0005-auth-mvp-y-deuda|
  ADR 0005 §8 deuda 2]] confirma "password reset" como deuda post-piloto. Mientras
  tanto, un link/texto informativo "¿Olvidaste tu contraseña? Contactá al admin de
  tu clínica" reduce el ticket de soporte.
- Contraste `text-gray-500 on bg-white` (subtitle línea 75) = ~4.6:1 → OK AA en text
  normal, pero al filo. En dark mode del sistema puede degradarse.
- El `<form noValidate>` está bien (usamos rhf/zod, no validación HTML5 nativa), pero
  el input email tiene `type="email"` — algunos browsers muestran icono nativo o
  validación adicional. OK.
- Placeholder `vos@clinica.com` con voseo. Para pt-BR debería ser `voce@clinica.com`
  o simplemente `email@clinica.com`. Ya cubierto en [[ux/2026-08-09-pt-json-panel-en-espanol|
  spec pt.json]] pero mencionar.
- Sin logo de AgendaZap. Como es MVP, un texto grande "AgendaZap" arriba del card
  alcanza.

**Impacto**:

- **Usuario afectado**: recepcionista/CLINIC_ADMIN/SUPERADMIN — todos los usuarios
  del panel.
- **Contexto de uso**: cada login. Frecuencia depende del expiresIn del JWT (24h).
- **Magnitud**: 5 clínicas × 2 usuarios × 1 login/día = 10 logins/día. Fricción baja
  por sesión pero constante. El hint de "olvidé password" reduce N tickets de soporte
  al mes.

> [!warning]+ Priority
> **P2** — Calidad/polish. Ningún bug bloqueante. Fix es contenido y valioso.

## Propuesta

Cinco cambios pequeños en `LoginForm.tsx`:

1. **autoFocus en email**: agregar `autoFocus` al `<Input id="email" ...>`.
   Cuidado: `autoFocus` en Next.js con SSR puede disparar warnings — envolver en un
   `useEffect(() => emailRef.current?.focus(), [])` si el warning aparece.
2. **Título con contexto AgendaZap**:
   - Sobre el card, un `<h1>AgendaZap</h1>` grande con brand-700.
   - El `<h1>` interno del card baja a `<h2>` — "Entrar" (o "Bienvenida" según copy).
3. **Hint de recovery no-existente**:
   - Debajo del botón Entrar, texto pequeño:
     `<p className="mt-4 text-center text-xs text-gray-500">
        {t('recovery.hint')}
      </p>`
   - Copy: `login.recovery.hint` = "¿Olvidaste tu contraseña? Contactá al admin de tu clínica."
4. **Error 429 más específico**:
   - Copy: `login.errors.tooManyAttempts` = "Demasiados intentos. Probá en 15 minutos."
   - (El backend expira a 900s = 15 min según [[docs/notas/2026-08-08-bloque-auth|nota
     Auth]]. Si en el futuro cambia, se sincroniza.)
5. **Contraste del subtitle**:
   - Cambiar `text-gray-500` por `text-gray-600` para asegurar 4.5:1+ en todos los
     entornos.

Cambios opcionales (nice-to-have si el subagente tiene tiempo):

- Botón "Recordar sesión 7 días" (checkbox) — pero requiere backend support y ADR;
  fuera de scope MVP.
- Logo SVG. Sin branding definido, texto alcanza.

### Componentes involucrados

- `apps/web/src/app/[locale]/login/LoginForm.tsx` — 5 cambios arriba.
- `apps/web/src/app/[locale]/login/page.tsx` — sin cambios (el shell del Suspense y layout).
- `apps/web/messages/es.json` + `pt.json` — nueva key `login.recovery.hint`; actualizar
  `login.errors.tooManyAttempts` con "15 minutos". Ver [[ux/2026-08-09-pt-json-panel-en-espanol|
  spec pt.json]] para versión pt.

> [!success] Criterios de aceptación
> - [ ] Al cargar `/login`, el foco está en el input email.
> - [ ] Título "AgendaZap" visible sobre el card.
> - [ ] Hint "¿Olvidaste tu contraseña?" visible debajo del botón.
> - [ ] Error 429 dice "Probá en 15 minutos".
> - [ ] Contraste `text-gray-600` verificado ≥ 4.5:1 con axe.
> - [ ] `pnpm build` limpio, sin warnings de React (`autoFocus`).
> - [ ] Keys sincronizadas en pt.json (o esperar a que se corra el spec pt.json).

> [!note]- Fuera de scope
> - NO se implementa password reset (deuda [[adr/0005-auth-mvp-y-deuda|ADR 0005 §8]]).
> - NO se agrega remember-me / refresh tokens.
> - NO se implementa social login / SSO.
> - NO se agrega captcha ([[adr/0004-pii-y-compliance|ADR 0004]]).
> - NO se implementa MFA.
> - NO se cambia el flujo del middleware (`/login → /panel/dashboard`).

## Referencias

- [[adr/0005-auth-mvp-y-deuda|ADR 0005 §8 — password reset, MFA como deuda]]
- [[docs/notas/2026-08-08-bloque-auth|nota Auth — rate-limit 900s]]
- [[ux/2026-08-09-pt-json-panel-en-espanol|spec pt.json — sincronizar copy]]

## Ejecución sugerida

- **subagent_type**: `general-purpose`
- **skill**: `frontend-design`
- **prompt para el subagente**:

```
Implementá el spec docs/ux/2026-08-09-login-polish-autofocus-y-context.md.
Contexto: AgendaZap login. Usuario: recepcionista.
Restricciones:
- No agregar libs.
- Cero backend changes.
- Sincronizar keys en pt.json (si el spec pt.json ya se ejecutó, respetar la traducción).
Al terminar: reporte con archivos + build + verificación contraste axe.
```
