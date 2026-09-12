# 2026-09-12 — Transcribir notas de voz: por qué el servicio desconfía de su propia URL

`SttService` (M10, PR 2). La elección de proveedor y su motivo están en
[[notas/2026-09-11-exploracion-stt-notas-de-voz]]; esta nota es sobre cómo se
baja el audio, que es donde estaba el riesgo real.

## El dato de partida: la URL del audio viene de fuera

WAHA manda `media.url` dentro del payload del webhook. Ese endpoint es público
y se autentica con **un token compartido, global para todas las clínicas**. O
sea que la URL que este servicio va a pedir no es nuestra: es un campo que llega
de fuera, y hay que tratarlo como tal.

Y la petición lleva la `WAHA_API_KEY`, que **abre las sesiones de WhatsApp de
todas las clínicas**. Un servicio que pide URLs ajenas con una credencial de
administración adjunta es exactamente la forma de un SSRF con premio.

## Tres defensas, y por qué las obvias no bastan

**1. El host no basta: hay que acotar la ruta.** La primera versión comparaba
host y protocolo, y con eso `http://waha:3000/api/sessions` pasaba el filtro —
con la clave de admin puesta y la respuesta enviada a OpenAI. Ahora se exige
además que la ruta empiece por `/api/files/`. También se rechaza `userinfo`
(`http://user:pass@waha:3000/…`), que mandaría un Basic auth inesperado.

> El host **se compara entero**, no por prefijo: `startsWith(baseUrl)` deja
> pasar `http://waha:3000.atacante.com`. Hay un test para ese caso concreto.

**2. `fetch` sigue redirecciones, y el allowlist sólo mira la primera URL.**
Con el default (`redirect: 'follow'`), un 30x en el host de WAHA devuelve el
SSRF entero — y undici **conserva las cabeceras propias entre saltos**: quita
`Authorization`, pero no `X-Api-Key`. Es decir, la clave de WAHA acabaría en el
servidor de destino. No hace falta un open redirect clásico: cualquier proxy
delante de WAHA que normalice una barra final emite un 30x. Se pide con
`redirect: 'manual'` y cualquier 3xx es un rechazo.

**3. Comprobar el tamaño después de bajarlo no es una defensa.** La versión
inicial miraba `content-length` y luego volvía a comprobar sobre
`arrayBuffer()`. Si la respuesta va en *chunked* no hay cabecera, y para cuando
se mide el tamaño **el cuerpo entero ya está en memoria**: el segundo check
detectaba, no protegía. Ahora el cuerpo se lee con un reader y se corta en
cuanto se pasa del tope.

> El patrón común a los tres: **validar donde el dato se consume, no donde se
> declara.** El host se validaba una vez y luego `fetch` se iba a otro sitio; el
> tamaño se validaba sobre una cabecera; la duración se valida sobre un campo
> que manda el mismo que manda la URL.

## El tope de duración se deriva del de bytes, no al revés

La política de producto son 120 s ("los audios largos son monólogos, no
consultas"). Pero `durationSec` lo declara el payload: omitirlo desactivaría el
tope. El límite que de verdad manda es el de bytes, y por eso se **deriva** de
la duración objetivo: 120 s de opus de WhatsApp son ~250 KB, así que 1 MB deja
margen para otros códecs. Con los 5 MB de la primera versión cabían ~40 minutos
de audio y el límite de producto era papel mojado.

## Un 404 de WAHA es definitivo

WAHA borra los ficheros a los 900 s (`WHATSAPP_FILES_LIFETIME`). Un 404 o un 410
no son un fallo transitorio: el audio no existe y no va a volver. Tienen su
propio error (`MediaExpiredError`) para que el caller **no lo reintente** —
reintentar sólo gasta intentos y retrasa el fallback a una persona. Por lo mismo,
quien encole la transcripción debe hacerlo con prioridad alta y backoff corto: la
ventana entera son 15 minutos.

## Lo que este servicio NO puede garantizar

**Que el audio sea de esta clínica.** Las URLs de WAHA son `/api/files/<id>`,
sin la sesión en la ruta, así que no hay forma de comprobar el tenant desde la
URL. La garantía tiene que venir de aguas arriba: que el `media.url` se tome
siempre del mismo payload que ya resolvió la clínica, nunca de otra fuente. Está
anotado en el JSDoc del servicio para quien lo cablee.

## Antes de encenderlo: el consent

El texto vigente del ADR 0004 §7 dice que "tus mensajes" se procesan con IA.
**Mandar grabaciones es un salto que ese texto no explica** — la propia nota de
exploración lo señala, y el ADR es tajante: sin consent explícito, handoff a una
persona sin invocar al proveedor.

El plan pone el PR 3 (texto nuevo, versionado) *después* de éste, con el
argumento de que el texto debe describir lo que el sistema hace de verdad. El
argumento es bueno para redactarlo y malo para el orden de encendido: si esto se
cablea antes, hay una ventana en la que se mandan grabaciones de pacientes bajo
un consent que sólo habla de mensajes. Y eso tira por tierra el motivo por el que
se eligió OpenAI en vez de Deepgram, que era justamente no tocar esa lista.

**Recomendación: o entra antes el PR 3, o el cableado va detrás de un flag por
clínica apagado por defecto.**

Relacionado: [[adr/0004-pii-y-compliance]] ·
[[notas/2026-09-11-exploracion-stt-notas-de-voz]] · [[adr/0002-waha-no-oficial]]
