# 2026-09-09 — Formato canónico de `phone` (E.164 con `+`) y dedup del webhook

## Phone
**Regla**: `Patient.phone` y `Conversation.phone` se guardan SIEMPRE en E.164 con `+`
(`+584141234567`). Toda entrada pasa por `normalizeE164()` en
`apps/backend/src/common/phone.util.ts` (limpia separadores, exige 8–15 dígitos,
devuelve `+…` o `null`).

**Por qué**: el webhook de WAHA derivaba el phone de `<phone>@c.us` sin `+`, mientras
la página pública, el panel y leads guardaban con `+`. Un mismo paciente quedaba
duplicado según la vía de alta y el bot no encontraba citas creadas desde la web
(la key única es `(clinicId, phone)`).

**Dónde se aplica**: `webhook.controller` (WAHA), `public.controller` (POST
`/public/clinics/:slug/appointments`), `appointments.controller` (POST panel),
`leads.controller`, y el `upsert` de `Conversation` en `bot.service` (refresca
`phone` en update → conversaciones viejas sin `+` se corrigen al próximo mensaje).

**Deuda**: pacientes creados por el bot antes del fix pueden existir sin `+` y
convivir con un duplicado con `+`. No se migró. Pendiente: job de merge por
`(clinicId, '+' || phone)` que reasigne citas y borre el duplicado.

## Dedup del webhook
WAHA reintenta el webhook si no recibe 200 a tiempo. `webhook.controller` hace
`SET waha:evt:<session>:<payload.id> 1 EX 86400 NX`; si ya existía, `{ ok: true }`
sin llamar al bot. Sin `payload.id` procesa normal; si Redis falla, fail-open.

## Otros fixes del mismo sprint (P1 de la auditoría)
- Endpoints públicos por slug filtran `status: 'ACTIVE'` (clínica suspendida → 404).
- `validateProdEnv()` (`common/env.util.ts`) exige `WEBHOOK_HMAC_SECRET` o
  `WEBHOOK_TOKEN` en prod; `ALLOW_WEBHOOK_WITHOUT_TOKEN=true` en prod es error.
- `WahaService` ya no loguea el body de error de WAHA (ecoa chatId + texto → PHI).
- `AvailabilityService` suma `bufferMin` del servicio de cada cita ocupada.
