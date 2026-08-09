# Bloque 3 — Página pública `/agendar/[clinicSlug]`

- Fecha: 2026-08-08
- Relacionados: [[0003-rate-limit-casero-vs-throttler]], [[0004-pii-y-compliance]]

## Qué

Segundo canal de entrada al motor de agendamiento (además del bot de WhatsApp).
Un paciente sin cuenta puede agendar desde el navegador. Comparte
`SchedulingService.createAppointment` con el bot (source `PUBLIC` vs `BOT`).

## Backend — `apps/backend/src/public/`

- `dto/create-public-appointment.dto.ts` — DTO con validaciones + honeypot.
- `rate-limit.guard.ts` — factory `RateLimit(N)` con estrategia fixed window por
  `slug+ip` en Redis. Devuelve 429 + `Retry-After: 60`.
- `public.controller.ts` — 3 endpoints públicos:
  - `GET /api/public/clinics/:slug` (30/min)
  - `GET /api/public/clinics/:slug/availability` (30/min)
  - `POST /api/public/clinics/:slug/appointments` (5/min)
- `public.module.ts` — wiring del `Redis` singleton + import de `SchedulingModule`.
- Tests: 20 nuevos (DTO + controller + guard). Total suite: 39 pasando.

## Frontend — `apps/web/`

- Next.js 15 App Router + React 19 + TypeScript strict.
- next-intl v3 con locale prefix `always` (`/es/...`, `/pt/...`).
- Tailwind 3 + componentes UI hand-rolled en `components/ui/` (estética shadcn).
- `[locale]/agendar/[clinicSlug]/`:
  - `page.tsx` (SSR): fetchClinic + `<ScheduleForm />`.
  - `ScheduleForm.tsx` (client): rhf + zod + honeypot invisible + refetch de
    slots al cambiar service/professional + manejo de 409/429.
  - `not-found.tsx`: 404 con mensajería localizada.
  - `gracias/page.tsx`: confirmación con `name/date/time` en query params.
- Fechas: siempre `Intl.DateTimeFormat` con la TZ de la clínica (nunca la del navegador).
- Env: `NEXT_PUBLIC_API_URL` (default `http://localhost:4000`).

## Decisiones no obvias

- **Rate-limit casero** en vez de `@nestjs/throttler`: ver [[0003-rate-limit-casero-vs-throttler]].
- **Cero PII en logs** en el controller público. El guard sólo loguea IP + slug + count.
- **Root layout ausente**: en Next 15 + next-intl v3 la convención con `[locale]`
  como único segmento hijo del root funciona sin `app/layout.tsx`; `[locale]/layout.tsx`
  emite el `<html lang>` correcto.
- **Honeypot** en el frontend está en un `<div class="sr-only" aria-hidden="true">`
  con `tabIndex={-1}` y `autoComplete="off"` — humanos no lo ven ni con lectores
  de pantalla; bots suelen llenarlo. Si viene con valor, el backend responde
  `200 { ok: true }` sin crear nada (no señalizamos la trampa).

## Preguntas abiertas / TODO futuro

- Cuando la Turnstile de Cloudflare vaya a producción, sumarla como segunda capa
  encima del honeypot (opt-in por clínica).
- Ranurar seedear una clínica demo en dev (`prisma/seed.ts`) para poder correr
  el smoke E2E completo. Hoy: los curls confirman guard + 404 + validación DTO,
  pero no la creación real de la cita (sin clínica seed).
- Panel admin (Bloque 6): la app `apps/web` está lista para sumarle rutas
  autenticadas en paralelo a `[locale]/agendar/`.

## Smokes

- `GET /api/public/clinics/no-existe` → 404 ✓
- `POST` con DTO inválido → 400 con lista de errores ✓
- 6ta request → 429 con `Retry-After: 60` ✓
- `GET /api/public/clinics/CON!MAYUS` → 400 (`slug inválido` por el nuevo pipe) ✓
- Response del POST feliz NO incluye `patient.{name,phone}` — sólo `{ id, startAt, endAt, status }` ✓

## Nuevas env vars (post-review security)

- `TRUST_PROXY` — `"true"` cuando el backend está detrás de un proxy confiable
  (Cloudflare / nginx / ALB). Sólo entonces `extractIp()` consulta
  `X-Forwarded-For`. Sin setear (o `"false"`) → usa `req.ip`. Nunca confiar
  ciegamente en XFF: los headers los controla el cliente si no hay un proxy
  que los reescriba.
- `CORS_ORIGINS` — CSV con los orígenes permitidos, ej.
  `https://agendazap.com,https://panel.agendazap.com`. Obligatoria en prod
  (fail-fast en `main.ts`). En dev sin setear → CORS abierto (comodidad).

## Cambios de seguridad aplicados (post-review)

- `SlugValidationPipe` (`^[a-z0-9-]{1,50}$`) en los 3 endpoints.
- `extractIp()` extraído a función pura + gate por `TRUST_PROXY`.
- Helmet activo antes de CORS.
- CORS con whitelist explícita (default block en prod).
- Response del POST sin PII (removido `patient.{name,phone}`).
- Frontend: nombre viaja por `sessionStorage`, no query string, y sólo el
  primer nombre para reducir superficie.
- `encodeURIComponent(slug)` en `apps/web/src/lib/api.ts`.
- Next.js bumped a `^15.4.0` (instalado 15.5.23).
- Ver [[0004-pii-y-compliance]] para las brechas conocidas que quedan como
  deuda post-piloto.
