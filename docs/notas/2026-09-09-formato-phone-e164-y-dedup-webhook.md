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

**Migración de datos**: `prisma/migrations/20260909120000_normalize_phone_e164_plus`
antepone `+` a `Patient.phone`, `Conversation.phone` y `Lead.phone` cuando no lo
tienen (idempotente, sólo filas con 8–15 dígitos). En `Patient` respeta
`@@unique([clinicId, phone])`: si ya existe la fila con `+` en la misma clínica, la
fila sin `+` **queda como está**. Verificado en un Postgres descartable:
`migrate deploy` aplica limpio, `migrate diff` contra el schema → "No difference",
y el caso con duplicado no toca la fila. La DB de producción hoy está vacía.

**Deuda**: los pares duplicados (con y sin `+`) que la migración deja requieren un
merge manual: reasignar `Appointment.patientId` al paciente con `+`, fusionar
`consent`/`name`, borrar el otro. Detectarlos con:
```sql
SELECT p."clinicId", p.phone FROM "Patient" p
JOIN "Patient" q ON q."clinicId" = p."clinicId" AND q.phone = '+' || p.phone
WHERE p.phone !~ '^\+';
```

## Dedup del webhook
WAHA reintenta el webhook si no recibe 200 a tiempo. `webhook.controller` hace
`SET waha:evt:<session>:<sha256hex(from + '|' + payload.id)> 1 EX 86400 NX`; si ya
existía, `{ ok: true }` sin llamar al bot. La clave va **hasheada** porque los ids de
WAHA tienen forma `false_<phone>@c.us_<hex>` (contienen el teléfono) y los genera el
cliente; el log `debug` sólo muestra 12 chars del hash. Si `bot.handleIncoming` lanza,
se hace `DEL` best-effort de la clave y se relanza para que el reintento de WAHA sí se
procese. Sin `payload.id` procesa normal; si Redis falla, fail-open.

Además, un `message` de una clínica con `status !== 'ACTIVE'` se descarta con
`{ ok: true }` (los `session.status` se siguen procesando).

## Otros fixes del mismo sprint (P1 de la auditoría)
- Endpoints públicos por slug filtran `status: 'ACTIVE'` (clínica suspendida → 404).
- `validateProdEnv()` (`common/env.util.ts`) exige `WEBHOOK_HMAC_SECRET` o
  `WEBHOOK_TOKEN` en prod; `ALLOW_WEBHOOK_WITHOUT_TOKEN=true` en prod es error.
- `WahaService` ya no loguea el body de error de WAHA (ecoa chatId + texto → PHI).
- `AvailabilityService`: `bufferMin` es tiempo ocupado a ambos lados (cita existente y slot nuevo). Ver `SPEC.md`.
- `validateProdEnv` también exige ≥32 chars y sin prefijo `dev-`/`cambiar-` en los secretos del webhook.
