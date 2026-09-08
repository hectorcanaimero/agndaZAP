-- CreateEnum
CREATE TYPE "AppointmentSource" AS ENUM ('BOT', 'PUBLIC', 'BOT_WEB');

-- AlterTable
-- `source` NOT NULL con DEFAULT 'PUBLIC' asegura que las citas legacy quedan
-- clasificadas como públicas (verdad histórica: todas venían del endpoint
-- público). El bot y el flujo BOT_WEB setean explícito en cada create.
--
-- `conversationId` nullable + ON DELETE SET NULL: si algún día se purga una
-- Conversation antigua (por retención) la cita no se rompe — solo pierde el
-- link al chat.
ALTER TABLE "Appointment"
  ADD COLUMN "source" "AppointmentSource" NOT NULL DEFAULT 'PUBLIC',
  ADD COLUMN "conversationId" TEXT;

-- CreateIndex
-- Índice para: (a) dashboard "citas por conversación WA", (b) reverse-lookup
-- rápido cuando el bot procesa un webhook y quiere ver si el paciente ya tiene
-- cita atada a este chat.
CREATE INDEX "Appointment_conversationId_idx" ON "Appointment"("conversationId");

-- AddForeignKey
ALTER TABLE "Appointment"
  ADD CONSTRAINT "Appointment_conversationId_fkey"
  FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
