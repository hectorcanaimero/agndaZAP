# ADR 0010 — WhatsApp LID, identidad del contacto y perfil visible

- Fecha: 2026-08-10
- Estado: aceptado
- Relacionados: [[0002-waha-no-oficial]], [[0004-pii-y-compliance]], [[0006-panel-mvp-y-deuda]]

## Contexto

WhatsApp está migrando el identificador de usuarios en su red desde el JID
tradicional basado en teléfono (`<phone>@c.us`) hacia un **LID** (Linked ID,
`<lid>@lid`) — un identificador aleatorio de 14–17 dígitos que no revela el
número. Es parte de su iniciativa de privacidad (2025-2026).

En AgendaZap detectamos el problema cuando un chat legítimo del piloto
apareció en el panel con el "número" `+63556976398516`. La conversación en
DB tenía `chatId = 63556976398516@lid`, y el código del webhook
(`webhook.controller.ts`) hacía `phone: from.replace('@c.us', '')`, lo que:

1. No stripeaba el sufijo `@lid`.
2. Aunque lo hiciera, **el LID no es el teléfono** — el número real de ese
   contacto era `+5541998819501` (BR).
3. La lista del panel mostraba un "número" ficticio que confundía al operador
   y hacía imposible correlacionar con la ficha del paciente.

Además, notamos gaps adyacentes:

- El header del chat mostraba "Bot · NaN mensajes" (bug: el endpoint
  `GET /api/conversations/:id` no incluía `messageCount`).
- No guardábamos el `pushName` (nombre visible que el contacto configura
  en su perfil), aunque WhatsApp lo manda en cada mensaje.
- No traíamos la foto de perfil, aunque WAHA la expone tanto para `@c.us`
  como para `@lid`.

### Investigación sobre resolución LID → phone

Probamos varias vías con el engine `noweb` (Baileys) de WAHA en Docker:

- Endpoints de contacts/chats requieren `config.noweb.store.enabled=true` al
  crear la sesión — no eran accesibles.
- WAHA **no expone ningún endpoint documentado** para resolver un LID a su
  phone real. La primitiva existe en Baileys internamente (mapping en
  `store.sqlite3`) pero no está expuesta por HTTP.
- El payload del mensaje entrante puede incluir campos alternativos que
  Baileys ya expone (`senderPn`, `remoteJidAlt`) — dependemos de la versión
  de WAHA/Baileys. Agregamos logging condicional en dev (marker `[LID]`)
  para poder refinarlo cuando veamos datos reales.

## Decisión

1. **Extender `Conversation` en vez de crear tabla `Customer`.** Un
   `Customer` separado duplicaría la unicidad natural de `Conversation`
   (`[clinicId, chatId]`) y agregaría un join más al pipeline hot del bot.
   `Patient` ya existe con `consent` y va ligado a `Appointment`; NO es el
   lugar para "cualquiera que te escribió por WhatsApp" (muchos escriben
   solo para FAQ). Nuevos campos en `Conversation`:
   - `phone: String?` (era `String NOT NULL`) — E.164 cuando lo conocemos;
     `null` cuando el `chatId` vino como `@lid` y no lo resolvimos.
   - `lid: String?` — LID de WhatsApp sin sufijo `@lid`.
   - `contactName: String?` — pushName visible del contacto.
   - `avatarUrl: String?` — URL de la foto de perfil (expira ~48h).
   - `avatarFetchedAt: DateTime?` — para refresh con TTL.
   - `patientId: String?` (FK opcional) — se liga cuando el bot completa el
     flujo de agendamiento y crea el `Patient` con phone real.

2. **Habilitar NOWEB store al crear la sesión.** `WahaService.startSession`
   ahora hace primero `POST /api/sessions` con `config.noweb.store.enabled=true`
   y `fullSync=false` (~3 meses de historial). Si la sesión ya existe (409),
   fallback a `POST /api/sessions/start` legacy — pero se **loguea que las
   sesiones creadas antes de este cambio no tienen el store** y hay que
   `logout` + re-escanear QR para activarlo.

3. **Fetch de avatar en background (fire-and-forget).** En cada
   `handleIncoming` del bot, si `avatarFetchedAt` es null o >24h, se dispara
   `WahaService.getContactAvatar` sin bloquear el pipeline. Errores se
   loguean como `warn` y no rompen el ingest.

4. **Frontend: nombre > phone > "Contacto WhatsApp".** Introducimos
   `displayName(conv)` que prioriza `contactName`, luego phone formateado,
   y jamás el LID pelado. `ContactAvatar` acepta `avatarUrl` y cae a
   iniciales si la imagen falla (`onError`) o no la tenemos.

5. **Sin phone conocido, el flujo de agendamiento se aborta con mensaje
   explícito.** El FSM actual necesita phone para crear el `Patient`. Cuando
   `convo.phone` es null, el bot responde pidiendo al usuario que escriba
   desde el número directo. Follow-up: agregar step `ASK_PHONE` al FSM.

6. **Backfill de datos existentes en la migración SQL.** Conversaciones
   preexistentes con `phone LIKE '%@lid'` se mueven a la columna `lid` y su
   `phone` se setea a `null`. Los legacy con `phone LIKE '%@c.us'` se
   stripean.

## Consecuencias

**Positivas**
- El operador ve el nombre real del contacto en el panel (o el número
  formateado si el nombre no está seteado), nunca un LID confuso.
- La foto de perfil (ya disponible en WAHA para LIDs) da contexto visual.
- El bug "NaN mensajes" queda cerrado con el `_count` en `findOne`.
- La conversación sigue teniendo un identificador estable (`chatId`) aunque
  no conozcamos el phone — el operador puede responder normalmente vía
  `POST /api/sendText` con el chatId (funciona con LID).

**Negativas / deuda técnica**
- Sin ASK_PHONE en el FSM, un contacto con LID NO puede completar un
  agendamiento por bot. Se lo pide manualmente. Es aceptable para el piloto
  (los contactos existentes de la clínica siguen viniendo por `@c.us`), pero
  hay que resolverlo antes del launch en Brasil (donde ya vemos LIDs).
- Sesiones WAHA creadas antes de este cambio no tienen el store habilitado.
  Requieren re-escaneo de QR para activarlo. No es breaking porque el flujo
  actual no dependía del store — pero perdemos capacidad de resolver
  contactos hasta que se re-escanee.
- Las URLs de perfil de WhatsApp expiran (~48h). Si el operador abre un chat
  después de ese TTL, puede ver el avatar vacío por unos segundos hasta que
  el próximo mensaje entrante dispare el refresh. Aceptable — nunca rompe.

**Neutrales**
- El log `[LID]` en dev nos va a permitir descubrir qué campos alternativos
  manda Baileys (senderPn, remoteJidAlt) y refinar la resolución sin cambiar
  el contrato. Es observabilidad barata.
