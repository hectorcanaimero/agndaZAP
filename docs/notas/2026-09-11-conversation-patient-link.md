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

### El intento que NO funcionó, y por qué

La primera versión sí ligaba desde el borde público, con esta regla: ligar solo si el
`Patient` nació en ese mismo `createAppointment` (`patientCreated`). El razonamiento
era "si nadie había reclamado ese teléfono, nadie puede quejarse".

**`patientCreated` prueba ausencia de reclamo previo, no propiedad.** Lo destapó el
`security-auditor`, y el ataque es barato: un chat `@lid` pide el link, rellena el form
con el teléfono de otra persona que todavía no es paciente de esa clínica, y se queda
ligado a **su** `Patient`. Como `Patient` es único por `(clinicId, phone)`, a partir de
ahí la vía 1 le entrega todas las citas futuras de ese número — incluidas las que cree
después recepción desde el panel o la propia víctima por la web. Puede leerlas (con el
nombre real en el saludo con contexto) y confirmarlas o cancelarlas. Coste del ataque:
un WhatsApp y un número.

Peor aún, el vínculo contamina el panel: `patients.controller.ts` resuelve "la
conversación del paciente" por `patientId` ordenando por `updatedAt`, así que la ficha
de la víctima mostraría el hilo del atacante y las alertas a recepción irían allí.

**Conclusión: no se liga desde el borde público.** Los tres objetivos de S5 para *esa*
cita (recordatorio-respuesta, follow-up, saludo con contexto) ya los cubre la vía 2 por
`conversationId`. Lo único que se pierde es el enganche con *otras* citas futuras del
mismo paciente, que es exactamente la parte que no se puede autorizar con un teléfono
declarado.

### Lo que sí se controla en el borde público

Queda un filtro sobre qué citas se atan al chat (`conversationId`), que es lo que
después habilita la vía 2. Solo se ata cuando:

- la conversación tiene teléfono verificado por WAHA y **coincide** con el del
  formulario, o
- la conversación no tiene teléfono (`@lid`) y ese número **todavía no es paciente** de
  la clínica, así que la cita nace de ese chat y el nombre lo pone quien la crea.

Sin la segunda condición, un `@lid` que escribiera el teléfono de un paciente existente
se quedaría con su cita por la vía 2 — el mismo secuestro por otra puerta, y además un
oráculo de enumeración: probar números y ver si el bot devuelve un nombre.

Cuando no se ata, **la cita se crea igual** y queda un `warn` sin PII. El paciente no
tiene por qué pagar por una discrepancia nuestra.

## Efecto colateral necesario: el "sí" sin teléfono

`handleReminderReply` exigía `phone` y cortaba antes de buscar nada, así que un chat
`@lid` ligado por `patientId` seguía sin poder confirmar — justo el caso que S5 venía
a arreglar. Ahora resuelve primero por las tres vías y solo deriva a recepción cuando
no encuentra cita **y** además no hay teléfono.

Lo mismo con `hasConfirmationContext`: busca el `Reminder` SENT por `appointmentId` de
la cita ya resuelta, en vez de re-derivar el paciente desde el teléfono. Más simple y
funciona sin número.

## Dónde sí se liga

Solo desde fuentes verificadas, las dos en `BotService`:

- al **confirmar una cita por la FSM**, donde el teléfono es el de WAHA por
  construcción (la FSM no arranca sin él);
- al resolver por la **vía 3**, cuando el teléfono verificado de la conversación lleva a
  un `Patient`.

La vía 3 además **corrige** un enlace que haya quedado apuntando a otro paciente: el
número verificado manda. Y la vía 1 exige que, si la conversación tiene teléfono, el
paciente ligado sea el de ese número — así un enlace viejo no puede ganarle al
teléfono verificado.

## Multi-tenant

Todas las escrituras van por `updateMany` con `clinicId` en el `where` — nunca un
`update` por id suelto. Las tres vías de resolución llevan `clinicId`.

`linkConversationPatient` comprueba además que el `patientId` sea de esa clínica antes
de escribir. La FK de Prisma no valida clínica, así que una fila
`Conversation(A) → Patient(B)` quedaría persistida y el panel, que resuelve por
`patientId`, sí cruzaría. Hoy ningún caller puede provocarlo; es defensa en profundidad.

Cada enlace deja una traza con `convoId`, `patientId` y `clinicId`, sin teléfono ni
nombre: en un incidente, saber qué chat quedó ligado a qué paciente es justo el dato que
hace falta.

Sin migración ni backfill: solo hacia adelante. Un script idempotente que ligue
conversaciones existentes con `phone` a su `Patient` queda como ítem opcional.

Relacionado: [[notas/2026-09-11-bot-matching-saludo-si-persona]] · [[adr/0020-gestion-cita-por-link]]
