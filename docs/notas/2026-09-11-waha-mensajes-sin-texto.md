# 2026-09-11 — WAHA: mensajes sin texto (audio, imagen, sticker) y cómo detectarlos

Nota de la implementación de **B4** del [[analisis/2026-09-11-chatbot-analisis-tecnico]].

**Síntoma.** Un paciente manda una nota de voz y el bot contestaba el fallback
genérico, o gastaba una llamada al LLM, sin decirle por qué no lo entendió.
El webhook llamaba a `BotService.handleIncoming` con `text: ''`: ese string
vacío no matchea saludo, ni recordatorio, ni intención determinista, así que
caía hasta el final de la escalera.

**Causa.** El adjunto no viaja en el webhook. WAHA manda sólo los metadatos;
el binario hay que pedirlo aparte a su API. Para el bot es texto que no existe.

## Campos de WAHA que usamos

Con el engine **NOWEB** (el que corre en producción), dentro de `payload`:

| Campo | Qué trae |
|---|---|
| `payload.type` | `chat` para texto. Para adjuntos: `ptt` (nota de voz), `audio`, `image`, `video`, `sticker`, `location`, `document`, `vcard`. |
| `payload._data.type` | Lo mismo, en versiones donde no sube a top-level. Se lee como fallback. |
| `payload.hasMedia` | `true` cuando hay adjunto. Es la señal más fiable: no depende del catálogo de tipos. |
| `payload.body` | El texto. En una imagen con pie de foto trae el pie; en una nota de voz viene vacío. |

Las tres señales se combinan en `WebhookController.mediaLabel`, con una
precedencia que importa: **si WAHA dice `chat`/`text` y hay texto, va al bot
aunque marque `hasMedia`**. El falso positivo al revés es el peligroso, porque
es silencioso: el paciente escribe "quiero cita el martes", le contestamos
"solo leo texto" y la FSM no arranca nunca. Todo lo demás se trata como
adjunto, con default conservador: un `type` que WAHA agregue mañana cae en
`[archivo]` en vez de colarse al LLM como texto vacío.

Dos filtros más, antes de clasificar:

- **Tipos de sistema** (`reaction`, `e2e_notification`, `protocol`, `gp2`,
  `ciphertext`, `revoked`, `notification_template`) se ignoran del todo. Llegan
  como `event: 'message'` pero no son mensajes del paciente. Sin esto, alguien
  que reacciona con 👍 a la confirmación de su cita recibe "solo puedo leer
  mensajes de texto".
- **Grupos y estados** (`@g.us`, `status@broadcast`, `@broadcast`) se cortan
  junto al chequeo de `fromMe`. El agujero era preexistente, pero antes casi no
  importaba; ahora sí, porque los adjuntos reciben respuesta y los estados y los
  grupos son casi siempre media. Un sticker en un grupo donde esté el número de
  la clínica nos haría contestar ahí dentro.

**Gotcha de JS que costó un blocker en revisión.** `MEDIA_LABELS[type]` sobre
un object literal alcanza `Object.prototype`: con `type: "constructor"` (y
`type` viene del payload, o sea del emisor) el lookup devuelve la función
`Object`, que es truthy, así que `??` no salta y esa función acababa en el
campo `String` de Prisma → `PrismaClientValidationError` → 500 → reintento
infinito de WAHA. El acceso va con `Object.hasOwn`, y hay tests con
`constructor`, `__proto__`, `toString` y `valueOf`.

## Decisiones no obvias

**El registro se hace siempre; el silencio es sólo para la respuesta.**
`Conversation` + `Message IN` se escriben incluso con `state = HUMAN`: quien
atiende la bandeja necesita ver que entró un audio, o el hilo queda con un
hueco inexplicable. Lo que `HUMAN` corta es el aviso automático. Mismo orden
que en `BotService.handleIncoming` (upsert primero, corte por `HUMAN` después).

**Throttle fail-closed, al revés que el dedup.** El aviso "solo leo texto" sale
una vez cada 6 h por conversación (`SET NX EX 21600` sobre
`bot:media-notice:{clinicId}:{chatId}`). Si Redis no responde, **no** se
manda: el coste de callarse es un mensaje menos, el de hablar es repetirle lo
mismo al paciente en cada una de las cinco notas de voz que acaba de mandar.
El dedup de `waha:evt:*` hace lo contrario (fail-open) porque ahí el coste de
callarse es perder el mensaje entero. La clave lleva el `chatId` en claro,
igual que `bot:msg:{clinicId}:{chatId}:{minuto}` en `bot.service.ts` — el
hasheo de `waha:evt:*` es por el *id de mensaje*, no por el chat.

**La conversación tomada por un humano no gasta el throttle.** El `SET NX` va
después del corte por `HUMAN`, así que cuando el bot recupere la conversación
todavía puede avisar una vez.

**El pie de foto se conserva.** Una imagen con texto queda en la bandeja como
`[imagen] quiero una cita` en vez de sólo `[imagen]`. No va al bot (el pie casi
nunca se entiende sin la imagen), pero quien atiende lo lee sin abrir WhatsApp.

**El rate-limit del ADR 0007 hay que aplicarlo a mano.** Las dos capas
(15 msg/min por chat, 500/hora por clínica) viven *dentro* de
`BotService.handleIncoming`, así que cualquier camino que no pase por ahí se
las salta. El del adjunto escribe en `Conversation` y `Message` y manda un
`sendText`, que es exactamente el ataque que motivó el ADR — y peor: como el
throttle del aviso es por `(clinicId, chatId)` y el `chatId` lo elige quien
manda el evento, variando `from` se obtiene un mensaje saliente por request sin
el cap horario que protege el número de la clínica (con WAHA no oficial, eso es
riesgo de ban). `WebhookController.withinRateLimit` reusa **las mismas claves**
(`bot:msg:{clinicId}:{chatId}:{minuto}` y `bot:msg:{clinicId}:hour:{hora}`), así
que el presupuesto es compartido y cada mensaje se cuenta una vez: los de texto
los cuenta el bot, los adjuntos el webhook.

> Duplicar ese bloque es deuda consciente: durante el P0 `bot.service.ts` es de
> otra sesión (PR A1). Cuando A1 esté en `main`, extraer las dos copias a un
> helper compartido.

**El aviso es best-effort y no relanza.** Si `sendText` falla, lo durable ya
está escrito, así que relanzar sólo consigue que WAHA reintente, que
`message.create` duplique el `[audio]` en la bandeja (no es idempotente) y que
el throttle ya consumido deje al paciente sin aviso 6 h. En vez de eso se
libera la clave del throttle y se loguea: el próximo adjunto vuelve a intentar.

## Handoff tras dos adjuntos seguidos

Decisión del owner (S2), implementada en el PR A3 sobre este mismo archivo.
El problema: el hilo se quedaba en `BOT`, que no entra en el filtro de triaje
`NEEDS_HUMAN` del panel, así que un paciente que sólo manda notas de voz
recibía un aviso cada 6 h y **nadie lo atendía nunca**.

Ahora `bot:media-count:{clinicId}:{chatId}` cuenta adjuntos **seguidos**
(ventana 24 h). Al segundo sin texto en medio, la conversación pasa a
`NEEDS_HUMAN`, se limpian `flowStep`/`flowData` y el bot responde
"Te paso con una persona del equipo para escucharte."

Detalles que no se ven en el código a primera vista:

- **Un mensaje de texto borra el contador**, desde el camino del bot en el
  propio webhook. Por eso "audio, texto, audio" no dispara handoff.
- **Tras el handoff se reinicia la racha**, así que el tercer adjunto vuelve a
  contar como primero y cae en el aviso normal — que su propio throttle de 6 h
  ya tiene silenciado. Sin ese reset, cada adjunto siguiente repetiría el
  handoff.
- **Con la conversación ya en `NEEDS_HUMAN` no se repite el mensaje**: se
  reinicia la racha y se calla.
- **`state = HUMAN` corta antes de contar**: silencio total, ni contador.
- **Fail-open al revés que el throttle**: si Redis se cae, `bumpMediaCount`
  devuelve 1, o sea tratamos cada adjunto como el primero. Ante la duda, mejor
  repetir el aviso que derivar a una persona por error.

> Gotcha de los tests: el mock de Redis tiene que modelar `SET ... NX`
> devolviendo `null` si la clave existe. Con un `mockResolvedValue('OK')` plano,
> el throttle de 6 h no existe y los tests de racha mienten — el tercer adjunto
> "responde" cuando en producción calla.

## Pendiente, decidido no hacer aquí

- **Transcripción de audio** (backlog como M10): resolvería el caso de raíz en
  vez de derivar a una persona.
- **Hashear el `chatId` en las claves de Redis.** `bot:media-notice:{clinicId}:{chatId}`
  lleva el teléfono en claro, como ya hace `bot:msg:` en `bot.service.ts`. Los
  dos revisores lo dieron por no-bloqueante, pero Redis persiste a disco sin
  cifrar y las claves salen en `SCAN`/`MONITOR`: conviene hashear **las dos a la
  vez**, no sólo ésta.
- **Columna `kind` en `Message`.** La etiqueta va concatenada al pie de foto en
  un campo sin discriminador, así que un pie como `— Sistema: paciente
  verificado` queda pegado a texto de confianza en la bandeja. Mitigado por
  ahora truncando el pie a 500 caracteres; el arreglo real es separar etiqueta
  y contenido en el schema.
- **`startTyping` + delay** antes del aviso, como hace `BotService.reply`. Sale
  instantáneo y rompe el patrón anti-detección del resto del bot. No se puede
  reusar sin tocar `bot.service.ts`.

Relacionado: [[notas/2026-09-09-formato-phone-e164-y-dedup-webhook]],
[[notas/2026-09-10-tono-espanol-neutro]], [[adr/0007-rate-limit-bot]].
