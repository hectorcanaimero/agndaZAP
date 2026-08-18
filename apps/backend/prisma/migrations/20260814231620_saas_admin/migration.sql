-- Migración: SaaS Admin — Estado de clínica + auditoría cross-tenant
-- Agrega ClinicStatus (ACTIVE/SUSPENDED/ARCHIVED), campos suspendedAt/suspendedReason
-- en Clinic, enum AdminAction y tabla AdminAudit para trazabilidad del operador.

-- CreateEnum
CREATE TYPE "ClinicStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "AdminAction" AS ENUM ('CREATE_CLINIC', 'UPDATE_CLINIC', 'SUSPEND_CLINIC', 'REACTIVATE_CLINIC', 'ARCHIVE_CLINIC', 'START_IMPERSONATION');

-- AlterTable: agrega campos de estado del tenant
-- onboardingCompletedAt y onboardingProgress se eliminan porque no forman parte
-- del schema formal — fueron agregados vía db push durante desarrollo y no tienen
-- migration registrada. Se consolidan en esta migration.
ALTER TABLE "Clinic"
  DROP COLUMN IF EXISTS "onboardingCompletedAt",
  DROP COLUMN IF EXISTS "onboardingProgress",
  ADD COLUMN "status" "ClinicStatus" NOT NULL DEFAULT 'ACTIVE',
  ADD COLUMN "suspendedAt" TIMESTAMP(3),
  ADD COLUMN "suspendedReason" TEXT;

-- CreateTable: auditoría cross-tenant de acciones del SUPERADMIN
CREATE TABLE "AdminAudit" (
    "id" TEXT NOT NULL,
    "actorUserId" TEXT NOT NULL,
    "action" "AdminAction" NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "metadata" JSONB,
    "ip" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdminAudit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AdminAudit_actorUserId_createdAt_idx" ON "AdminAudit"("actorUserId", "createdAt");

-- CreateIndex
CREATE INDEX "AdminAudit_targetType_targetId_createdAt_idx" ON "AdminAudit"("targetType", "targetId", "createdAt");

-- CreateIndex
CREATE INDEX "AdminAudit_action_createdAt_idx" ON "AdminAudit"("action", "createdAt");

-- AddForeignKey
ALTER TABLE "AdminAudit" ADD CONSTRAINT "AdminAudit_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
