-- Distingue la cancelación que pidió el paciente desde el link de gestión de la
-- que hizo la clínica. Es la señal de que la feature funciona: un hueco
-- liberado con aviso es lo contrario de un no-show.
ALTER TABLE "Appointment"
  ADD COLUMN IF NOT EXISTS "canceledByPatient" BOOLEAN NOT NULL DEFAULT false;
