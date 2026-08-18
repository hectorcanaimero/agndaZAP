# Spec — HMAC webhook WAHA + hardening de cookies (Sprint día 5)

**Fecha:** 2026-08-21 (adelantado — ejecutado 2026-08-18)
**Sprint:** Pre-lanzamiento 40 clínicas
**Alcance:** Día 5 (Viernes) — ~6h efectivas
**Cierra:** Medios #2 (webhook fail-open + sin HMAC) y #3 (cookie no HttpOnly) del review de seguridad

## Contexto

Del review de seguridad:

**Medio #2 · Webhook WAHA:**
> El fail-open dev se activa cuando `NODE_ENV≠production`. En staging con `NODE_ENV=staging` un atacante que reache el endpoint puede inyectar mensajes fake al bot. Además NO hay HMAC — un leak de `WEBHOOK_TOKEN` (logs, env dump, CI artifact) permite forge indefinido hasta rotación manual.

**Medio #3 · Cookie no HttpOnly:**
> El JWT vive en cookie no-HttpOnly para que el SPA lo lea con `document.cookie`. Cualquier XSS futuro exfiltra `showly_token` + `showly_admin_token` (24h validez cross-tenant).

## Decisiones arquitectónicas

### 1. Webhook WAHA: HMAC-SHA256 sobre body raw

**Elegido:** verificación HMAC del body raw + `WEBHOOK_HMAC_SECRET`. WAHA firma con `WHATSAPP_HOOK_HMAC` env, backend verifica con `crypto.timingSafeEqual`.

Trade-off: WAHA community NO soporta HMAC (feature de Plus). El endpoint acepta AMBOS mecanismos:
- Si `WEBHOOK_HMAC_SECRET` está seteado y llega header `x-webhook-hmac` → verificar HMAC
- Si no hay HMAC pero llega `x-webhook-token` correcto → aceptar (fallback WAHA community)
- En prod uno de los dos DEBE aparecer (fail-closed absoluto)

### 2. Fail-open dev via flag explícito

En vez de `!isProd` implícito, requerir `ALLOW_WEBHOOK_WITHOUT_TOKEN=true` opt-in. Elimina el riesgo de staging con `NODE_ENV=staging` sin auth.

### 3. Cookie hardening conservador (NO migrar a HttpOnly ahora)

**Motivo:** con 40 clínicas piloto en <2 semanas, migrar `showly_token` a HttpOnly implica refactor grande del `apps/web/src/lib/auth.ts` y `fetcher()`. Riesgo de romper el login > beneficio marginal contra XSS que hoy no tenemos.

**Cambios pragmáticos:**
- Sumar `SameSite=Strict` (reduce CSRF; hoy es `Lax`)
- Sumar `Secure` en prod (ya está pero verificar)
- Crear route handler `/api/auth/token` en Next.js — adición no-ruptura, listo para cuando quieras migrar el frontend
- HttpOnly real queda documentado en `docs/notas/2026-08-19-observabilidad-implementada.md` como deuda POST-piloto (2-3 días de trabajo dedicado)

## Task breakdown

| # | Task | Est |
|---|---|---|
| T-7.1 | Configurar raw body en main.ts para preservar bytes originales del webhook | 0.5h |
| T-7.2 | HMAC-SHA256 verify en webhook.controller.ts con crypto.timingSafeEqual | 1.5h |
| T-7.3 | Fail-open dev via ALLOW_WEBHOOK_WITHOUT_TOKEN explícito (no !isProd implícito) | 0.5h |
| T-7.4 | Cookies con SameSite=Strict + verificar Secure en prod | 1h |
| T-7.5 | Route handler `/api/auth/token` en Next (server-side, adición no-ruptura) | 1h |
| T-7.6 | Tests: HMAC válido/inválido, fail-open kill switch, verify TRUST_PROXY con XFF | 1h |
| T-7.7 | Env vars + docker-compose.prod.yml + docs | 0.5h |

**Total:** 6h efectivas.

## Acceptance criteria

### AC-1 · HMAC verificado en prod
```
Given prod con WEBHOOK_HMAC_SECRET seteado
When POST /webhooks/waha llega SIN header x-webhook-hmac
Then 401 rechazo
```
```
Given prod con WEBHOOK_HMAC_SECRET seteado
When POST /webhooks/waha llega con x-webhook-hmac firmado con SECRET distinto
Then 401 rechazo (timing-safe)
```
```
Given prod con WEBHOOK_HMAC_SECRET seteado
When POST /webhooks/waha llega con firma HMAC correcta
Then 200, evento procesado
```

### AC-2 · Fallback WEBHOOK_TOKEN funciona
```
Given WEBHOOK_HMAC_SECRET NO seteado y WEBHOOK_TOKEN='xxx'
When POST /webhooks/waha con x-webhook-token='xxx'
Then 200
```

### AC-3 · Fail-open solo con opt-in explícito
```
Given ALLOW_WEBHOOK_WITHOUT_TOKEN='true'
When POST /webhooks/waha SIN token ni HMAC
Then 200 con warning en log
```
```
Given ALLOW_WEBHOOK_WITHOUT_TOKEN NO seteada (o 'false')
When POST /webhooks/waha SIN token ni HMAC
Then 401 rechazo (aunque NODE_ENV≠production)
```

### AC-4 · Cookies hardening
```
En prod, cada Set-Cookie de showly_token/showly_admin_token incluye:
- SameSite=Strict
- Secure
- Max-Age respetado
- (NO HttpOnly todavía — deuda documentada)
```

### AC-5 · Route handler /api/auth/token existe
```
GET /api/auth/token (Next.js)
- Lee el cookie showly_token del request server-side
- Devuelve {token: string} si existe, 401 sino
- Runtime nodejs, dynamic force-dynamic (no cache)
```
No cambia el flujo actual del SPA — es endpoint aditivo, listo para cuando se migre.

## Env vars nuevas

```bash
# Webhook
WEBHOOK_HMAC_SECRET=""                        # secret compartido con WAHA (WHATSAPP_HOOK_HMAC)
ALLOW_WEBHOOK_WITHOUT_TOKEN="false"           # opt-in explícito para skip auth en dev
```

En docker-compose.prod.yml:
- Sumar `WEBHOOK_HMAC_SECRET` al backend env
- Sumar `WHATSAPP_HOOK_HMAC: ${WEBHOOK_HMAC_SECRET}` al service `waha`

## Definition of Done

- [ ] Tests verdes en backend (nuevos + regresión)
- [ ] Webhook rechaza request sin auth en prod (aunque no haya `NODE_ENV=production` explícito, si no hay `ALLOW_WEBHOOK_WITHOUT_TOKEN=true`)
- [ ] HMAC verify con `crypto.timingSafeEqual` (no comparación string plana)
- [ ] Cookies con `SameSite=Strict` visibles en `Set-Cookie`
- [ ] Route handler `/api/auth/token` responde 200/401 según cookie
- [ ] Env vars agregadas al `.env.example` y `docker-compose.prod.yml`
- [ ] Update de la nota de sprint con el cierre completo
