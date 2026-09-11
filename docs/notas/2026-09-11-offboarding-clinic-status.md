---
titulo: Offboarding — qué deja de funcionar cuando una clínica no está ACTIVE
fecha: 2026-09-11
tags: [seguridad, multi-tenant, offboarding, pii, auditoria]
---

# `Clinic.status` en la superficie sin auth

Barrido completo (S12) de todo lo que responde sin JWT, para que suspender una clínica por
impago o archivarla al terminar el contrato signifique lo mismo en todas partes.

El disparador: al construir los endpoints de [[adr/0020-gestion-cita-por-link|gestión de cita
por link]] se me olvidó el filtro que los otros endpoints públicos sí tenían. Lo cazó el
`security-auditor`, y la pregunta obvia fue *¿dónde más falta?*. Resultó que en tres sitios.

## El resultado

| Endpoint | Antes | Ahora |
|---|---|---|
| `GET /public/clinics/:slug` | ✅ filtraba | — |
| `GET /public/clinics/:slug/availability` | ✅ filtraba | — |
| `POST /public/clinics/:slug/appointments` | ✅ filtraba | — |
| `/public/clinics/:slug/appointments/manage/*` | ❌ | arreglado en el ADR 0020 |
| `GET /public/scheduling/session/:token` | ❌ | 404 |
| `GET /professionals/:id` (feed iCal) | ❌ | feed vacío |
| `GET /invitations/:token` y `POST accept` | ❌ | 404 |
| `POST /webhooks/waha` | ✅ para `message` | — |
| `POST /auth/login` | ✅ | — |
| `POST /public/leads` | n/a (no es de clínica) | — |
| `GET /api/health*` | n/a (sin datos) | — |

## Los tres agujeros, por gravedad

**El feed iCal era el peor.** Servía nombre y teléfono del paciente en cada evento, sin mirar
el estado de la clínica, y con el agravante de que la URL vive **indefinidamente** en la app de
calendario del profesional: seguiría sincronizando PII de salud meses después de cerrar la
cuenta, sin que nadie vuelva a visitar nada. Ahora devuelve un feed vacío válido — el
calendario deja de mostrar datos sin romperse ni revelar por qué.

**Las invitaciones dejaban entrar gente nueva** a una clínica ya suspendida. Se comprueba en
`getByToken` **y otra vez en `accept`**, porque entre ver la pantalla y pulsar el botón la
clínica puede suspenderse, y `accept` es el paso que de verdad da acceso.

**El token de agendamiento** hidrataba el formulario con nombre y teléfono del paciente. El
alcance era menor (TTL de 30 min y el POST posterior ya daba 404), pero es PII igual.

## Las reglas que salieron de esto

1. **Todo endpoint sin auth que lea algo de una clínica filtra por `status = ACTIVE`.** No es
   opcional ni depende de lo sensible que parezca el dato.
2. **Un token emitido cuando la clínica estaba activa no es un permiso permanente.** El estado
   se comprueba al usarlo, no al emitirlo. Vale para los tres tipos de token del sistema.
3. **Mismo error para todos los motivos.** Clínica inactiva, token inexistente y token expirado
   responden lo mismo: distinguirlos le confirma a quien prueba tokens que acertó.
4. **Donde haya que re-comprobar, `ClinicStatusCache.isActive()`** — cache de 60 s en Redis,
   fail-closed (si Redis cae va a DB; nunca asume ACTIVE). Si la query ya carga la clínica,
   basta con pedir `status` en el `select` y ahorrarse el viaje.

## Lo que NO cambia con una clínica inactiva

- `session.status` del webhook WAHA se sigue procesando: es el estado de la conexión de
  WhatsApp, no datos de pacientes, y perderlo dejaría el panel mintiendo sobre la conexión.
- Los health checks, que no leen nada de ninguna clínica.

## Relacionado
[[adr/0020-gestion-cita-por-link]] · [[adr/0004-pii-y-compliance]] ·
[[adr/0011-perfil-profesional-e-ical-feed]] · [[adr/0014-superadmin-como-operador-saas]] ·
[[adr/0018-scheduling-link-wa]] · [[SPEC]]
