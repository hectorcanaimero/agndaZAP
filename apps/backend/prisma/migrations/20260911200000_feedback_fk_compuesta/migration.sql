-- FK compuesta Feedback → Appointment(clinicId, id).
--
-- `Feedback` llevaba dos FKs sueltas: `clinicId` → Clinic y `appointmentId` →
-- Appointment. Nada en la BD impedía que apuntaran a clínicas distintas, y un
-- feedback con el clinicId equivocado filtraba nombre de paciente, profesional
-- y servicio de otra clínica por el `include` del panel. El chequeo en
-- `recordFeedback` cierra el camino conocido; esto lo cierra para cualquier
-- caller futuro.

-- 1) Unique compuesta en Appointment. Redundante por sí sola (`id` ya es PK),
--    pero es lo que permite que otra tabla la referencie por (clinicId, id).
CREATE UNIQUE INDEX IF NOT EXISTS "Appointment_clinicId_id_key"
  ON "Appointment" ("clinicId", "id");

-- 2) Si ya hay filas inconsistentes, la FK del paso 4 fallaría con un mensaje
--    genérico de constraint. Preferimos parar acá y decir exactamente qué pasa
--    y qué mirar: son datos cruzados entre tenants y hay que revisarlos a mano,
--    no borrarlos a ciegas desde una migración.
DO $$
DECLARE inconsistentes bigint;
BEGIN
  SELECT count(*) INTO inconsistentes
  FROM "Feedback" f
  JOIN "Appointment" a ON a."id" = f."appointmentId"
  WHERE f."clinicId" <> a."clinicId";

  IF inconsistentes > 0 THEN
    RAISE EXCEPTION
      'Hay % filas de Feedback cuyo clinicId no coincide con el de su Appointment. Son datos cruzados entre clínicas: revísalos antes de aplicar esta migración con:  SELECT f.id, f."clinicId" AS feedback_clinic, a."clinicId" AS appointment_clinic FROM "Feedback" f JOIN "Appointment" a ON a.id = f."appointmentId" WHERE f."clinicId" <> a."clinicId";',
      inconsistentes;
  END IF;
END $$;

-- 3) Unique que Prisma exige para usar (clinicId, appointmentId) como lado
--    definidor de la relación 1-1. `appointmentId` ya era UNIQUE por sí solo,
--    que es la restricción de negocio real (un feedback por cita).
CREATE UNIQUE INDEX IF NOT EXISTS "Feedback_clinicId_appointmentId_key"
  ON "Feedback" ("clinicId", "appointmentId");

-- 4) Swap de la FK simple por la compuesta.
ALTER TABLE "Feedback" DROP CONSTRAINT IF EXISTS "Feedback_appointmentId_fkey";

ALTER TABLE "Feedback"
  ADD CONSTRAINT "Feedback_clinicId_appointmentId_fkey"
  FOREIGN KEY ("clinicId", "appointmentId")
  REFERENCES "Appointment" ("clinicId", "id")
  ON DELETE CASCADE ON UPDATE CASCADE;
