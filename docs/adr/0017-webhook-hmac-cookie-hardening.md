# ADR 0017 — HMAC del webhook WAHA + hardening de cookies

## Estado

Aceptada — 2026-08-18

## Contexto

Del review de seguridad pre-lanzamiento:

**Medio #2 · Webhook WAHA fail-open:** en staging con `NODE_ENV=staging` (no `production`), el webhook aceptaba requests sin auth por `!isProd` implícito. Un atacante que reache el endpoint podía inyectar mensajes fake al bot. Adicionalmente, la única verificación era shared token (WEBHOOK_TOKEN) — un leak (logs, env dump, CI artifact) permite forge indefinido hasta rotación manual.

**Medio #3 · Cookies no HttpOnly:** el JWT vive en cookie readable por `document.cookie` para que el SPA lo inyecte via `Authorization: Bearer`. Cualquier XSS futuro exfiltra `showly_token` + `showly_admin_token` (24h de validez cross-tenant en el segundo).

## Decisión

### 1. Webhook: HMAC-SHA256 + fail-open explícito

**Mecanismo:** función pura `verifyWebhookAuth` en `apps/backend/src/whatsapp/webhook-auth.util.ts`. Preferencia en orden:

1. **HMAC:** si `WEBHOOK_HMAC_SECRET` seteado, requiere header `x-webhook-hmac` con SHA-256 sobre el body raw. Verificación con `crypto.timingSafeEqual` (evita timing attacks). Soporta prefijo `sha256=` (GitHub convention) y sin prefijo.
2. **Shared token (fallback WAHA community):** si `WEBHOOK_TOKEN` seteado, verifica match de header `x-webhook-token`.
3. **Skip explícito (solo dev):** si `ALLOW_WEBHOOK_WITHOUT_TOKEN=true` **AND** `NODE_ENV!==production`, acepta sin auth con warning en log.

**Anti-downgrade:** si `WEBHOOK_HMAC_SECRET` está seteado, se **ignora** el shared token — evita downgrade attack donde un atacante manda un token válido esperando que el backend acepte cualquier mecanismo disponible.

**Fail-closed default absoluto:** cualquier caso no cubierto arriba → `ForbiddenException`. En prod específicamente, sin HMAC ni TOKEN el mensaje de error deja explícito qué falta.

**Body raw preservation:** `main.ts` configura `express.json({ verify })` que guarda `req.rawBody = buf` solo para paths `/webhooks/*` (no gasta memoria en todos los requests). El HMAC firma bytes originales — no `JSON.stringify(body)` (el parseo no es determinístico: whitespace, orden de keys, encoding).

### 2. Cookies: hardening conservador (NO migrar a HttpOnly ahora)

**Elegido:** aplicar SameSite=Strict + Secure sobre el cookie actual (readable por JS). Diferir HttpOnly real al post-piloto.

**Motivo del diferimiento:** migrar a HttpOnly implica refactor grande de `apps/web/src/lib/auth.ts` + `fetcher()` + estrategia de refresh token. Con 40 clínicas piloto arrancando en <2 semanas, riesgo de romper el login > beneficio marginal contra XSS que hoy no tenemos identificado.

**Cambios aplicados:**

1. `SameSite=Lax` → `SameSite=Strict` en todas las escrituras de cookie (`showly_token`, `showly_admin_token`). Reduce CSRF significativamente aunque no mitiga XSS.
2. Verificado `Secure` flag en prod (ya estaba, solo confirmar).
3. **Nuevo route handler `/api/auth/token`** en Next.js que expone el JWT server-side leyendo el cookie via `next/headers`. Adición no-ruptura — no cambia el flow actual del SPA, pero está listo para cuando se haga la migración.

### 3. Fail-open dev via opt-in explícito

El check anterior `!isProd && !token` se cambió por `ALLOW_WEBHOOK_WITHOUT_TOKEN === 'true' && !isProd`. Sin el opt-in explícito, staging con `NODE_ENV=staging` (variante frecuente) ya no queda fail-open silente — rechaza 403. Cierra el gap del review.

## Alternativas descartadas

| Alternativa | Razón del rechazo |
|---|---|
| HttpOnly real con refresh flow HOY | 2-3 días de trabajo dedicado + alto riesgo de romper login pre-piloto. Postpuesto a fase 2. |
| Sacar WEBHOOK_TOKEN (solo HMAC) | WAHA community no soporta HMAC. Necesitamos fallback hasta migrar a WAHA Plus o self-hosted. |
| IP allowlist en Caddy en vez de HMAC | Cloudflare CDN cambia IPs de origen. Frágil de mantener. HMAC es determinístico. |
| Rotar `WEBHOOK_TOKEN` cada 24h con cron | Complicado operativamente. HMAC ya es fuerte por diseño. |
| Delegar la auth del webhook a Caddy (mTLS) | Requiere gestión de certs para WAHA (proyecto separado). HMAC es más simple. |
| Migrar a AsyncLocalStorage el body raw | Overkill. `req.rawBody` en el path `/webhooks/*` es cero-overhead. |

## Deuda documentada (post-piloto)

**Migración a HttpOnly (2-3 días):**

1. Backend expone `POST /api/auth/login` que setea cookie HttpOnly via `res.cookie(name, jwt, { httpOnly: true, secure: true, sameSite: 'strict' })` en vez de devolver el JWT en body.
2. Backend expone `GET /api/auth/me/token` que devuelve el JWT en body (solo server-side, no accesible al browser via JS).
3. Frontend: `apps/web/src/lib/auth.ts` deja de escribir `document.cookie`. El bootstrap del `PanelShell` hace `fetch('/api/auth/token')` para obtener el JWT en memoria (Zustand/context).
4. `fetcher()` sigue enviando `Authorization: Bearer <token>` — el token en memoria persiste durante la sesión SPA.
5. Refresh: cada N minutos, el layout re-fetchea `/api/auth/token`. Si 401 → redirect a login.
6. Impersonation flow: el `showly_admin_token` también HttpOnly, backup en cookie separado.

**Ventaja:** XSS ya no puede exfiltrar el JWT. **Trade-off:** un flush de memoria (F5) requiere re-fetch — imperceptible pero medible.

## Consecuencias

### Positivas

- **Cierre gaps del review:** Medios #2 y #3 quedan cerrados o formalmente documentados como deuda con plan.
- **Fail-closed absoluto en prod:** el webhook NUNCA queda abierto sin auth. Cambio de `NODE_ENV` no impacta.
- **Anti-downgrade:** operador que configura HMAC no puede quedar vulnerable por dejar el TOKEN viejo activo.
- **HMAC prep para escala:** el mecanismo está listo cuando migren a WAHA Plus (feature payment).
- **Route handler /api/auth/token listo:** migración a HttpOnly es cambio de flow del SPA, no de backend — reduce el scope.

### Negativas / Deuda técnica

- **HttpOnly real queda pendiente:** documentado arriba. Sin XSS identificado hoy, riesgo aceptado.
- **HMAC requiere WAHA Plus o self-hosted con secret:** WAHA community sigue usando token. En el peor caso (WAHA community sin plan de upgrade), el trail queda en el shared token — aceptable para MVP.
- **`req.rawBody` es Express-specific:** si migramos a Fastify, hay que reescribir. Documentado en el helper.

## Verificación

- 15 tests unitarios en `webhook-auth.util.spec.ts` cubren: HMAC válido (con y sin prefijo), HMAC inválido, HMAC ausente, raw body ausente, anti-downgrade, token válido/inválido/ausente, skip explícito en dev, skip ignorado en prod, fail-closed en staging sin opt-in.
- 497 tests totales verdes (baseline 482 + 15 nuevos).

## Relacionado

- [[0005-auth-mvp-y-deuda]] §7 — cookie flow original (cerrado en parte por este ADR)
- [[0015-pino-axiom-sentry]] — errores del webhook capturados por Sentry
- [[0016-admin-audit-impersonation-trail]] — audit trail complementario
- Review de seguridad pre-lanzamiento (Medios #2 y #3)
- Spec: [[../specs/2026-08-21-hmac-webhook-cookies]]
