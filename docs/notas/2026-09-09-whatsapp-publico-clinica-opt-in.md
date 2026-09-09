# WhatsApp público de la clínica en el snapshot público (opt-in)

Fecha: 2026-09-09 · Relacionado: [[SPEC]] §1 "Página pública", [[2026-09-09-formato-phone-e164-y-dedup-webhook]]

## Problema
`/gracias` quiere un botón "Escribir a la clínica por WhatsApp" (`wa.me/<numero>`), pero
`GET /api/public/clinics/:slug` no exponía teléfonos por diseño y la clínica no tenía ningún
campo con el número del bot en E.164: `Clinic.wahaSession` es sólo el **nombre** de la
instancia WAHA, no un teléfono, y no queremos inferirlo desde la sesión (puede cambiar,
puede no estar conectada, y WAHA devuelve LIDs en vez de números en algunos casos).

## Decisión
- Nuevo campo `Clinic.publicWhatsappPhone String?` (migración
  `20260909150000_add_clinic_public_whatsapp_phone`). **Opt-in explícito**: NULL por defecto →
  el snapshot devuelve `whatsappPhone: null` y `/gracias` no muestra el botón.
- Editable en `/panel/ajustes` → General ("WhatsApp público") vía `PATCH /api/clinics/me`, y por
  SUPERADMIN vía `POST/PATCH /api/admin/clinics`. El DTO quita separadores visuales y valida
  `^(\+|00)?[1-9]\d{7,14}$`; el controller/service canoniza con `normalizeE164` (mismo canon que
  `Patient.phone`). `""` = borrar (NULL).
- El snapshot público mapea explícitamente `publicWhatsappPhone → whatsappPhone`; los teléfonos
  de profesionales/usuarios/pacientes siguen sin salir (hay test que lo asegura aunque Prisma
  los traiga en el `include`).

## Gotchas
- `@ValidateIf(v => v !== '')` desactiva TODOS los validators del campo cuando llega `''`;
  está bien porque `''` es el sentinel de borrado y el controller lo mapea a NULL sin normalizar.
- En el frontend `wa.me` necesita el número **sin** `+`: `whatsappPhone.replace(/^\+/, '')`.
