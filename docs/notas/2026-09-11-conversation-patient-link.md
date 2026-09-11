---
titulo: "Ligar Conversation.patientId: el teléfono del form es declarado, no verificado"
fecha: 2026-09-11
tags: [bot, multi-tenant, seguridad, s5]
---

# S5 — ligar `Conversation.patientId`

Una conversación que llegó por `@lid` (WhatsApp no expone el teléfono) y agendó por la
web no se encontraba ni por `phone` ni por `patientId`. Perdía el
recordatorio-respuesta, el follow-up y el saludo con contexto: el bot le hablaba
como si no tuviera cita.

## Orden de resolución

`findUpcomingAppointment(clinicId, convo)` prueba tres vías y se queda con la primera
que devuelva algo:

1. **`convo.patientId`** si está ligado. Lo más preciso, y lo único que funciona en un
   chat `@lid` sin teléfono.
2. **`appointment.conversationId = convo.id`**: la cita nació de este mismo chat (link
   tokenizado). Deja que un `@lid` gestione **sus propias** citas sin heredar el
   historial de un teléfono que no verificamos.
3. **El `phone` de la conversación** — el que reporta WAHA. Si por esa vía aparece un
   `Patient` y `convo.patientId` era null, se liga de paso: a partir de ahí entra por
   la vía 1 y nos ahorramos la búsqueda.

## La decisión que da forma a todo lo demás

**Nunca se rellena `Conversation.phone` con el número del formulario público.**

El plan original lo proponía para el caso `@lid`: rellenar el teléfono con el del form
y ligar. Suena inofensivo porque el campo llega *readonly*, pero el token de
agendamiento viaja en una URL y el formulario es público: basta con teclear otro
número. Y una vez escrito en `Conversation.phone`, todo lo que viene después lo trata
como verificado — `findUpcomingAppointment` resuelve por ese número, así que ese chat
podría responder `SÍ` o `CANCELAR` sobre las citas del paciente dueño del teléfono,
incluidas las que no creó.

De ahí las tres reglas del enlace desde el token `BOT_WEB`:

- No se escribe `phone`. El único teléfono en el que confiamos es el de WAHA.
- Se liga `patientId` **solo si el `Patient` nació en ese mismo `createAppointment`**
  (`patientCreated`): nadie más pudo reclamarlo todavía. Si el paciente ya existía, no
  se liga — esa cita sigue siendo alcanzable desde el chat por la vía 2.
- Si la conversación ya tenía teléfono y **no** coincide con el del form, no se liga y
  queda un `warn` sin PII. La cita se crea igual: el paciente no tiene por qué pagar
  por una discrepancia nuestra.

`patientCreated` es exacto incluso con dos peticiones simultáneas del mismo teléfono:
`SchedulingService.createAppointment` lo resuelve con `create` + captura del P2002, no
deduciéndolo de un `findUnique` previo.

## Efecto colateral necesario: el "sí" sin teléfono

`handleReminderReply` exigía `phone` y cortaba antes de buscar nada, así que un chat
`@lid` ligado por `patientId` seguía sin poder confirmar — justo el caso que S5 venía
a arreglar. Ahora resuelve primero por las tres vías y solo deriva a recepción cuando
no encuentra cita **y** además no hay teléfono.

Lo mismo con `hasConfirmationContext`: busca el `Reminder` SENT por `appointmentId` de
la cita ya resuelta, en vez de re-derivar el paciente desde el teléfono. Más simple y
funciona sin número.

## Multi-tenant

Todas las escrituras van por `updateMany` con `clinicId` en el `where` — nunca un
`update` por id suelto. Las tres vías de resolución llevan `clinicId`.

Sin migración ni backfill: solo hacia adelante. Un script idempotente que ligue
conversaciones existentes con `phone` a su `Patient` queda como ítem opcional.

Relacionado: [[notas/2026-09-11-bot-matching-saludo-si-persona]] · [[adr/0020-gestion-cita-por-link]]
