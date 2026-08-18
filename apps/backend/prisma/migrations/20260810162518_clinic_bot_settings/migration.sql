-- Extiende Clinic con settings del bot (Fase 1 de /panel/ajustes).
-- Todos NULL para clínicas existentes → BotService cae a los mensajes
-- default hardcodeados. La UI de ajustes permite personalizar por tenant.

-- AlterTable
ALTER TABLE "Clinic"
  ADD COLUMN "botFallback" TEXT,
  ADD COLUMN "botGreeting" TEXT,
  ADD COLUMN "botHandoffMsg" TEXT,
  ADD COLUMN "botTone" TEXT;
