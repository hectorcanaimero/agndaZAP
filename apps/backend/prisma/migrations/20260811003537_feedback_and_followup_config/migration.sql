-- Feedback + follow-up config (Fase 1 de NPS/Satisfaction — ver ADR 0012).
--
-- Nuevo modelo Feedback: unique por appointment (1 respuesta por cita).
-- Professional gana followUpEnabled + followUpDelayHours (default false + 2h).
--
-- Sin backfill destructivo:
--  * Los profesionales existentes quedan con followUpEnabled=false → no
--    reciben follow-ups hasta que el operador lo prenda en el panel.
--  * followUpDelayHours=2 es el default acordado con el usuario (mientras la
--    experiencia está fresca — ni tan agresivo como 30min ni tan tarde como 24h).

-- AlterTable
ALTER TABLE "Professional"
  ADD COLUMN "followUpEnabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "followUpDelayHours" INTEGER NOT NULL DEFAULT 2;

-- CreateTable
CREATE TABLE "Feedback" (
    "id" TEXT NOT NULL,
    "clinicId" TEXT NOT NULL,
    "appointmentId" TEXT NOT NULL,
    "score" INTEGER NOT NULL,
    "comment" TEXT,
    "respondedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Feedback_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Feedback_appointmentId_key" ON "Feedback"("appointmentId");

-- CreateIndex
CREATE INDEX "Feedback_clinicId_respondedAt_idx" ON "Feedback"("clinicId", "respondedAt");

-- AddForeignKey
ALTER TABLE "Feedback" ADD CONSTRAINT "Feedback_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "Clinic"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Feedback" ADD CONSTRAINT "Feedback_appointmentId_fkey" FOREIGN KEY ("appointmentId") REFERENCES "Appointment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
