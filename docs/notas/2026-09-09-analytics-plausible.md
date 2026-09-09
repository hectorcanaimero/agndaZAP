# 2026-09-09 — Analytics de producto con Plausible (sprint 1)

**Por qué**: hasta hoy no había ningún evento en la landing ni en la página pública.
No se podía saber cuántos visitantes llegaban al formulario ni dónde abandonaba el
paciente. Sin embudo medido, toda optimización de conversión es a ciegas.

**Proveedor**: Plausible. Sin cookies, sin PII, sin banner de consentimiento, coherente
con lo que promete `/seguridad`. Soporta instancia self-hosted vía
`NEXT_PUBLIC_PLAUSIBLE_HOST`.

**Activación**: `NEXT_PUBLIC_PLAUSIBLE_DOMAIN` en build del web (Coolify lo pasa como
build arg; ver `apps/web/Dockerfile` y `docker-compose.coolify.yml`). Vacía → no se carga
script y `track()` es no-op. Hay que dar de alta el dominio en Plausible y, si se usa
el proxy propio, añadir el host al `PLAUSIBLE_HOST`.

**Implementación** (`apps/web/src/lib/analytics.ts` + `components/analytics/Analytics.tsx`):

- `track(event, props)` tipado con seis eventos estables.
- Clicks por delegación: cualquier `data-analytics="cta_click"` con
  `data-analytics-location`. Permite instrumentar server components sin volverlos client.
- Vistas por `IntersectionObserver` (50% visible, una sola vez): `data-analytics-view`.
- Eventos con lógica se disparan en el componente: `lead_submitted` (LeadForm),
  `slot_selected` y `appointment_created` (ScheduleForm, con `source: web|whatsapp`).

| Evento | Dónde | Props |
|---|---|---|
| `hero_view` | Hero del landing | — |
| `cta_click` | Nav, nav móvil, hero, pricing | `location` |
| `lead_form_view` | Formulario de leads visible | — |
| `lead_submitted` | Lead creado | `locale`, `clinicType` (enum) |
| `slot_selected` | Paciente elige horario | `clinic` (slug) |
| `appointment_created` | Cita creada (201) | `clinic`, `source` |

**Regla**: nunca props con nombre, teléfono ni notas. Sólo enums, slugs y locale.

**Pendiente**: en Plausible crear los goals con esos nombres y un funnel
hero_view → cta_click → lead_form_view → lead_submitted. Ver [[bitacora]] (2026-09-09).
