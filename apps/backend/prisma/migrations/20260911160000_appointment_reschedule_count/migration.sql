-- Traza de reagendamientos (S6). Señal de riesgo del "reagendador reincidente":
-- no puede ir por estado, porque reagendar devuelve la cita a PENDIENTE.
--
-- Idempotente (`IF NOT EXISTS`): la base de prod ya pasó por migraciones
-- aplicadas a mano durante el sprint 0, así que no damos por sentado el estado.
ALTER TABLE "Appointment"
  ADD COLUMN IF NOT EXISTS "rescheduleCount" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "Appointment"
  ADD COLUMN IF NOT EXISTS "lastRescheduledAt" TIMESTAMP(3);

-- Contador separado para el tope del paciente: los reagendamientos que hace
-- recepción desde el panel no deben gastarle el cupo al paciente.
ALTER TABLE "Appointment"
  ADD COLUMN IF NOT EXISTS "patientRescheduleCount" INTEGER NOT NULL DEFAULT 0;
