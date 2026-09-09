-- Normalización de `phone` al formato canónico E.164 con `+`.
--
-- Contexto: el webhook de WAHA guardaba el phone sin `+` (derivado de
-- `<phone>@c.us`) mientras la página pública, el panel y leads lo guardaban
-- con `+`. Desde este sprint todas las vías pasan por `normalizeE164()`
-- (apps/backend/src/common/phone.util.ts); esta migración corrige las filas
-- históricas. Idempotente: sólo toca filas que no empiezan por `+`.
--
-- Patient tiene `@@unique([clinicId, phone])`: sólo anteponemos `+` cuando
-- NO existe ya la fila con `+` en la misma clínica. Los pares duplicados
-- (con y sin `+`) quedan como están y requieren un merge manual (reasignar
-- citas al paciente con `+` y borrar el otro). Ver
-- docs/notas/2026-09-09-formato-phone-e164-y-dedup-webhook.md.

UPDATE "Patient" p
SET "phone" = '+' || p."phone"
WHERE p."phone" !~ '^\+'
  AND p."phone" ~ '^[1-9][0-9]{7,14}$'
  AND NOT EXISTS (
    SELECT 1 FROM "Patient" q
    WHERE q."clinicId" = p."clinicId"
      AND q."phone" = '+' || p."phone"
  );

-- Conversation: unique es (clinicId, chatId), no phone → sin riesgo de choque.
UPDATE "Conversation"
SET "phone" = '+' || "phone"
WHERE "phone" IS NOT NULL
  AND "phone" !~ '^\+'
  AND "phone" ~ '^[1-9][0-9]{7,14}$';

-- Lead: sin unique por phone.
UPDATE "Lead"
SET "phone" = '+' || "phone"
WHERE "phone" !~ '^\+'
  AND "phone" ~ '^[1-9][0-9]{7,14}$';
