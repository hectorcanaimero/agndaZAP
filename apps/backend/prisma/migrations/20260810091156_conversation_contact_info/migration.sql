-- AlterTable
ALTER TABLE "Conversation" ADD COLUMN     "avatarFetchedAt" TIMESTAMP(3),
ADD COLUMN     "avatarUrl" TEXT,
ADD COLUMN     "contactName" TEXT,
ADD COLUMN     "lid" TEXT,
ADD COLUMN     "patientId" TEXT,
ALTER COLUMN "phone" DROP NOT NULL;

-- CreateIndex
CREATE INDEX "Conversation_patientId_idx" ON "Conversation"("patientId");

-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Backfill: separar LID de phone en conversaciones existentes.
-- Regla: si el phone termina en "@lid" (bug previo — se guardaba el LID como
-- si fuera phone), moverlo a la columna `lid` sin sufijo y limpiar phone.
UPDATE "Conversation"
   SET "lid" = REPLACE("phone", '@lid', ''),
       "phone" = NULL
 WHERE "phone" LIKE '%@lid';

-- Regla: stripear sufijo "@c.us" de phones legacy (algunos seeds antiguos lo
-- dejaron adentro). Los que ya venian E.164 con "+" no se tocan.
UPDATE "Conversation"
   SET "phone" = REPLACE("phone", '@c.us', '')
 WHERE "phone" LIKE '%@c.us';
