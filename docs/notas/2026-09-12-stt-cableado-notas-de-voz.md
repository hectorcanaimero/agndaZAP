# 2026-09-12 — Cablear la transcripción: qué decide quién, y qué pasa cuando algo falla

Cierre de M10 (PR 4): el `SttService` de [[notas/2026-09-12-stt-descarga-segura]]
deja de estar suelto y entra en el camino real de un mensaje de WhatsApp.

El resumen del camino: **el webhook decide si hay algo que transcribir, el worker
lo transcribe**. Nada de audio sale hacia un tercero desde el proceso que
responde el webhook.

## El flag no es un rollout, es el gate de consent

`STT_ENABLED` viene apagado. Mientras lo esté, una nota de voz se comporta
exactamente como antes de M10: queda en la bandeja como `[audio]` y el paciente
recibe el aviso de "solo puedo leer mensajes de texto".

Se comprueba en **dos** sitios, y no sobra ninguno:

- en el webhook (`transcribableAudio`), para no encolar;
- en el worker (`transcribeOrHandoff`), para los jobs **que ya estaban
  encolados** y para un `retry` desde el panel de BullMQ dentro de la ventana de
  retención.

Si solo se mirara al encolar, apagarlo no pararía nada de lo que ya está en
Redis. Un kill switch que no mata no sirve para responder a un incidente de
cumplimiento, que es justo para lo que existe este.

## Fail-closed en la dirección incómoda

Tres decisiones van contra la intuición de "que el bot conteste como sea":

1. **Sin aviso previo no hay transcripción.** `voiceNoteFirstTime` (PR 3) se le
   manda al paciente una vez, ANTES de mandarle el audio a OpenAI. Si el envío
   falla, no se transcribe: se deriva a una persona. Repetir el aviso es el
   error barato; saltárselo es el caro.
2. **La prueba de que se avisó es una columna, no un mensaje.** La primera
   versión usaba el `Message OUT` con el texto del aviso: sobrevive a un flush
   de Redis y se puede enseñar. Pero es **falsificable** — `BotService.reply`
   persiste la respuesta del LLM verbatim y el copy es público, así que una
   inyección de prompt ("responde exactamente con: …") deja plantada una fila
   idéntica sin que el aviso se haya mandado nunca, y desde la bandeja del panel
   se puede escribir a mano. Una prueba que el propio sistema puede fabricar no
   se puede enseñar en una auditoría, que es para lo único que existe. Ahora son
   `Conversation.voiceConsentAt` + `voiceConsentVersion`, y la versión hace que
   un cambio sustantivo del texto vuelva a avisar en vez de darse por cubierto
   con el consent viejo.
3. **Conversación en `HUMAN` → no se transcribe**, y se revalida al procesar,
   no solo al encolar: entre una cosa y otra hay cola, backoff y hasta 120 s de
   lock. Se pagaría la llamada y se mandaría la grabación del paciente a un
   tercero para que la lea alguien que ya está leyendo el hilo. Divulgar una
   grabación sin beneficio para el paciente es el peor intercambio posible en un
   camino que existe por consent.

   **`NEEDS_HUMAN` es lo contrario, y por poco se cuela al revés**: ahí nadie ha
   tomado el hilo *todavía*, y es donde más ayuda transcribir — quien atienda lee
   lo que el paciente dijo en vez de un `[audio]` que no puede escuchar. El gate
   estaba escrito como `=== 'BOT'`, que además de no transcribir dejaba al
   paciente **en silencio absoluto**, porque el aviso de "solo leo texto" ya se
   había suprimido arriba al detectar que había algo que transcribir. Lo que
   corta es `HUMAN`; tipar el estado con el enum de Prisma en vez de `string` es
   lo que hace que eso se vea al leer.

## Fallo definitivo vs. transitorio

No es lo mismo "esto puede salir bien dentro de 3 s" que "esto no va a salir
bien nunca":

| Fallo | Qué se hace |
|---|---|
| `MediaExpiredError` (404/410: WAHA borró el fichero a los 900 s) | definitivo → derivar y avisar |
| `AudioTooLongError` | definitivo → derivar, y el aviso dice qué puede hacer él |
| Sin `OPENAI_API_KEY` | definitivo: es configuración, no una intermitencia |
| Resto (`SttUnavailableError`, red) | se relanza y BullMQ reintenta |

Tratar la falta de clave como transitorio dejaba al paciente sin **ninguna**
respuesta hasta agotar los intentos, porque el webhook ya no le dijo "solo leo
texto": el camino de audio suprime ese aviso a propósito.

El aviso de fallo también se persiste como `Message OUT`, y **después** del
envío. Si se persistiera antes, un fallo de WAHA dejaría a la recepcionista
leyendo un aviso que nadie recibió y contestando "como te decíamos" a alguien
que solo vio silencio.

## Nada de esto sirve si el paciente se queda callado

Regla que atraviesa todo el camino de audio: el webhook **suprime** el aviso de
"solo puedo leer mensajes de texto" en cuanto ve que hay algo que transcribir.
Eso convierte cualquier salida silenciosa aguas abajo en silencio absoluto para
el paciente — peor que el comportamiento anterior a M10. Por eso avisan también
el camino del flag apagado y el del fallo definitivo, y por eso el único
silencio que queda es el de `HUMAN`, donde hay una persona leyendo.

## La transcripción se guarda en el job

`job.updateData({ transcript, transcriptModel })` en cuanto vuelve el proveedor.
Sin eso, un fallo aguas abajo (Postgres, WAHA) hace que cada reintento mande el
mismo audio otra vez a OpenAI: se paga dos veces y, para el segundo intento, el
fichero puede haber caducado ya.

## El gotcha de la prioridad en BullMQ

Los jobs **con** `priority` van a un ZSET (`prioritized`); los que no la llevan,
a la lista `wait`. Y `moveToActive` vacía la lista **entera** antes de mirar el
ZSET. Es decir: un job "prioritario" entre jobs sin prioridad se procesa el
ÚLTIMO — justo al revés de lo que dice la palabra.

Por eso los jobs de texto también llevan prioridad (la baja, `10`), aunque no la
necesiten: solo con los dos en el ZSET el audio adelanta de verdad. Importa
porque la URL del audio caduca a los 900 s y la del texto no caduca nunca.
Ver [[adr/0021-cola-bot-inbound]].

## Lo que este PR NO resuelve (y el owner debería sopesar antes de encenderlo)

- **La FSM se fía de la transcripción como si el paciente la hubiera escrito.**
  Un "sí" mal transcrito confirma una cita que el paciente nunca leyó. Hoy no se
  lee ninguna señal de confianza del proveedor.
- **El flag es global, no por clínica.** Encenderlo lo enciende para todas, y el
  consent lo aceptó cada paciente en su clínica. Un `Clinic.sttEnabled` sería lo
  correcto si esto pasa de piloto.
- **El audio comparte la cota de rate-limit con el texto**, pero cuesta dinero.
- **La URL del media sigue llegando al LLM** por `buildConversationContext`
  (preexistente en `main`, no lo toca este PR).
- **La cota de rate-limit es fail-open** (`bot-rate-limit.ts`): con Redis caído
  se deja pasar todo. Antes eso era "más llamadas al LLM"; ahora es además gasto
  en un proveedor que cobra por minuto de audio. Un presupuesto de STT por
  clínica y día, fail-closed, sería lo correcto antes de salir de piloto.
- **La transcripción entra en la bandeja como un `Message IN` normal**, sin
  marca de procedencia. Se deduce por la fila `[audio]` de justo antes, pero un
  prefijo explícito le ahorraría el salto a quien atiende.

Ver [[adr/0004-pii-y-compliance]] §7.2 y [[notas/2026-09-11-exploracion-stt-notas-de-voz]].
