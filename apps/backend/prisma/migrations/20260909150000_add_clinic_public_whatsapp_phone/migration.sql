-- Clinic.publicWhatsappPhone: número de WhatsApp de la clínica que se expone
-- (opt-in) en el snapshot público `GET /api/public/clinics/:slug` para que la
-- página /gracias muestre "Escribir a la clínica por WhatsApp" (wa.me).
-- NULL = la clínica no lo configuró → el snapshot devuelve `whatsappPhone: null`.
-- Se persiste normalizado a E.164 con `+` (apps/backend/src/common/phone.util.ts).

-- AlterTable
ALTER TABLE "Clinic" ADD COLUMN     "publicWhatsappPhone" TEXT;
