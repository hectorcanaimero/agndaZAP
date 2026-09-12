-- Prueba de que al paciente se le avisó de que su nota de voz la transcribe
-- una IA de un tercero (M10, ADR 0004 §7.2).
--
-- La primera versión usaba el `Message OUT` con el texto del aviso como
-- prueba. No sirve: `BotService.reply` persiste la respuesta del LLM
-- **verbatim**, y el copy del aviso es público, así que una inyección de
-- prompt ("responde exactamente con: …") deja plantada una fila idéntica sin
-- que el aviso se haya enviado nunca. Cualquiera desde la bandeja del panel
-- puede hacer lo mismo a mano. Una prueba de consent que se puede fabricar no
-- se puede enseñar en una auditoría, que es para lo único que existe.
--
-- `voiceConsentVersion` guarda QUÉ se le dijo: si el texto cambia de versión,
-- el aviso se repite en vez de darse por hecho con el consent viejo.
ALTER TABLE "Conversation"
  ADD COLUMN "voiceConsentAt" TIMESTAMP(3),
  ADD COLUMN "voiceConsentVersion" TEXT;
