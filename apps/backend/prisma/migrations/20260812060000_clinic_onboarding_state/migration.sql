-- Onboarding wizard first-time para CLINIC_ADMIN (ver docs/notas/2026-08-11-onboarding-wizard.md).
--
-- Dos columnas nuevas en Clinic:
--  * onboardingCompletedAt: señal boolean barata (NULL = pending, timestamp = done)
--    que consulta el middleware Next.js + /auth/me para decidir redirect a /onboarding.
--  * onboardingProgress: JSON abierto con { currentStep, clinicType, serviceId,
--    professionalId, hoursPreset, wahaAttempts }. Permite iterar steps sin
--    migration futura y preservar contexto si el user hace refresh mid-step.
--
-- Backfill crítico: cualquier clínica que ya tenga al menos un Service se marca
-- como completada — evita que clientes existentes vean el wizard tras el deploy.
-- Validar con SUPERADMIN antes de aplicar en prod si hay clínicas manuales sin
-- Service que sí deberían ver el wizard.

-- AlterTable
ALTER TABLE "Clinic"
  ADD COLUMN "onboardingCompletedAt" TIMESTAMP(3),
  ADD COLUMN "onboardingProgress" JSONB;

-- Backfill: clínicas activas (con al menos un Service) se consideran onboarded.
UPDATE "Clinic"
SET "onboardingCompletedAt" = NOW()
WHERE id IN (SELECT DISTINCT "clinicId" FROM "Service");
