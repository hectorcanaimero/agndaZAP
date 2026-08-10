-- Extiende Professional con campos de contacto, perfil, regulatorio y visual.
-- Todos opcionales para no romper profesionales existentes (que quedan con NULL).
-- `email` es unique por clínica para prevenir doble alta del mismo profesional.
-- `updatedAt` se agrega ahora — todos los rows existentes toman `now()` como valor inicial.

-- AlterTable
ALTER TABLE "Professional"
  ADD COLUMN "avatarUrl" TEXT,
  ADD COLUMN "bio" TEXT,
  ADD COLUMN "color" TEXT,
  ADD COLUMN "email" TEXT,
  ADD COLUMN "licenseNumber" TEXT,
  ADD COLUMN "phone" TEXT,
  ADD COLUMN "specialty" TEXT,
  ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Prisma normalmente NO genera un DEFAULT para `@updatedAt` (lo maneja en el
-- cliente), pero acá lo dejamos con default para no fallar en el ALTER sobre
-- rows existentes. Ese default no interfiere con el behavior de Prisma en
-- inserts nuevos — Prisma pisa el valor con `now()` igualmente en cada update.

-- CreateIndex
CREATE UNIQUE INDEX "Professional_clinicId_email_key" ON "Professional"("clinicId", "email");
