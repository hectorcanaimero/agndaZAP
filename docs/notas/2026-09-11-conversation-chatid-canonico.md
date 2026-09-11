---
titulo: El chatId canónico y por qué no se puede hacer upsert a ciegas
fecha: 2026-09-11
tags: [bot, whatsapp, conversation, gotcha]
---

# `Conversation.chatId`: formato canónico y orden de resolución

Gotcha descubierto al arreglar [[analisis/2026-09-11-chatbot-analisis-tecnico|B9]]
(follow-up sin `Conversation`). Aplica a **cualquier** código que tenga un teléfono y
necesite la conversación de WhatsApp de ese paciente.

## El formato

`Conversation.chatId` guarda el id de chat tal como lo manda WAHA, y hay dos formas:

| Forma | Ejemplo | Cuándo |
|---|---|---|
| phone-based | `584141234567@c.us` | contacto normal |
| LID | `99887766554433@lid` | WhatsApp está migrando a Linked ID por privacidad |

El formato phone-based es **dígitos pelados + `@c.us`**: sin `+`, sin espacios, sin guiones.
Como `(clinicId, chatId)` es `UNIQUE`, si dos sitios lo arman distinto se crean dos
conversaciones para el mismo paciente y el bot pierde el hilo. Por eso la conversión vive
en un solo lugar: `phoneToChatId()` en `apps/backend/src/common/phone.util.ts`, al lado de
`normalizeE164()`. `WahaService.toChatId` delega ahí; no la reimplementes.

## El orden de resolución (lo no obvio)

Desde un teléfono **solo se puede construir la forma `@c.us`**. WhatsApp no expone
LID→phone públicamente, así que un paciente que escribió desde un LID tiene una
`Conversation` cuyo `chatId` es imposible de derivar de su número.

Consecuencia: **nunca hagas `upsert` por `(clinicId, phoneToChatId(phone))` como primer
paso**. Si ese paciente ya tenía una conversación `@lid`, el upsert no la encuentra, crea
una segunda fila y el hilo se parte en dos (el historial y la FSM quedan en la vieja, los
mensajes nuevos en la nueva).

El orden correcto, implementado en `follow-ups.processor.ts` (y ya antes en `alertReception`
de `reminders.processor.ts`):

1. `findFirst` por `clinicId` + `OR: [{ patientId }, { phone }]`, con
   `orderBy: { updatedAt: 'desc' }` → reusa la conversación existente, sea `@c.us` o `@lid`.
2. Solo si no hay ninguna, `upsert` por `(clinicId, chatId)` con el id derivado.

El `orderBy` del paso 1 no es cosmético: puede haber **dos** filas del mismo paciente en la
clínica (la `@lid` y una `@c.us`), y sin él Postgres devuelve cualquiera. Si elige la que el
paciente ya no usa, el fallo se vuelve intermitente — el peor modo posible.

El paso 2 es `upsert` y no `create` a propósito: entre el `findFirst` y la escritura puede
llegar un mensaje entrante que cree la fila (`BotService.handleIncoming` hace su propio
upsert por la misma clave), y también cubre la fila legacy con el `phone` sin `+`, que la
rama `update` deja corregida.

## Límite conocido

Un paciente que escribió desde un `@lid` **sin llegar a dar su número** tiene
`Conversation.phone = null`. Si además agendó por la web, el paso 1 no lo encuentra (ni por
`phone` ni por `patientId`, que hasta ahora solo escribe este processor) y el paso 2 le crea
una segunda fila `@c.us`. Su respuesta seguirá entrando por el `@lid`, sin `flowStep`.

Es una variante angosta del mismo bug y hoy no tiene arreglo limpio: haría falta que el bot
ligara `Conversation.patientId` cuando resuelve el paciente en la FSM. Anotado como
seguimiento.

## Dirección contraria

La inversa la hace el webhook: `normalizeE164(chatId.replace(/@(c\.us|lid|…)$/, ''))`.
Para un `@lid` devuelve `null` a propósito — un LID no es un teléfono y no debe ensuciar
la columna `phone`. Ver [[notas/2026-09-09-formato-phone-e164-y-dedup-webhook]].

## Relacionado
[[flujo-bot]] · [[adr/0012-feedback-post-atencion]] ·
[[notas/2026-09-09-formato-phone-e164-y-dedup-webhook]] ·
[[analisis/2026-09-11-chatbot-analisis-tecnico]]
