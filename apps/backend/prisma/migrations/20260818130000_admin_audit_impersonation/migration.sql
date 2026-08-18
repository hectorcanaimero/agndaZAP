-- Extiende AdminAudit para persistir mutations bajo impersonation (ADR 0016).
-- Cierra hallazgo Alto #1 del review de seguridad: SUPERADMIN impersonando
-- una clínica podía tocar datos de pacientes sin trail estructurado en DB.

-- Nuevo valor de enum. Postgres NO permite ALTER TYPE ADD VALUE dentro de
-- una transacción — Prisma migrate lo separa automáticamente en su propio
-- statement si detecta este patrón. Si prisma migrate deploy falla acá,
-- separar el ALTER TYPE en su propia migration file.
ALTER TYPE "AdminAction" ADD VALUE IF NOT EXISTS 'IMPERSONATED_WRITE';

-- Nuevo campo. Nullable: solo se popula cuando la acción viene bajo
-- impersonation (JWT con claim impersonatedBy). Los inserts previos quedan
-- con NULL — no requieren backfill.
ALTER TABLE "AdminAudit" ADD COLUMN "impersonatedBy" TEXT;

-- Index para queries de compliance tipo "todas las acciones del super X
-- impersonando la clínica Y en el rango de fechas Z".
CREATE INDEX "AdminAudit_impersonatedBy_createdAt_idx"
  ON "AdminAudit"("impersonatedBy", "createdAt");
