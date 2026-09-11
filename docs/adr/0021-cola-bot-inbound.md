# ADR 0021 — Cola `bot-inbound` entre el webhook de WAHA y el bot

- Fecha: 2026-09-11
- Estado: aceptado
- Relacionados: [[0002-waha-no-oficial]], [[0007-rate-limit-bot]], [[0004-pii-y-compliance]], [[0015-observabilidad]]

## Contexto

`WebhookController` llamaba a `BotService.handleIncoming` **dentro de la
request** y no devolvía 200 hasta que el bot terminaba. Ese trabajo incluye una
o dos llamadas al LLM, consultas de disponibilidad y un `sendText` a WAHA: con
el LLM de por medio son segundos.

WAHA reintenta el webhook cuando tarda. El resultado era el mismo mensaje
procesado dos veces: doble respuesta al paciente o, en el peor caso, doble cita.
El dedup por `SET NX` lo tapaba en parte, pero sólo si el segundo intento
llegaba después de que el primero hubiera marcado la clave.

## Decisión

El webhook **encola y responde 200 al instante**; un worker de BullMQ
(`bot-inbound`) hace el trabajo lento.

Esto **mueve la garantía de entrega de WAHA a BullMQ**, y eso es lo que hace
que esto sea un ADR y no una nota: antes, si el bot fallaba, el webhook
devolvía 500 y WAHA reintentaba; ahora el webhook ya respondió, así que la
única red es la cola. Son 3 intentos con backoff exponencial y, agotados, el
mensaje se descarta.

### Consecuencias que hubo que compensar

**1. El fallo pasa de ruidoso a silencioso.** Un worker muerto ya no produce
errores visibles: el webhook sigue respondiendo 200 y los mensajes se apilan
mientras el paciente no recibe nada. Por eso el cambio incluye un check en
`/api/health` que mira la cola. La señal principal es la **antigüedad del
mensaje más viejo sin procesar**, no la profundidad: con una clínica piloto de
5-10 mensajes/hora, un worker muerto tardaría días en acumular 50 pendientes.

**2. Un mensaje que agota los reintentos desaparecía.** Ahora, en el último
intento, la conversación pasa a `NEEDS_HUMAN`: el paciente no recibe respuesta
automática, pero la clínica lo ve en el triaje del panel en vez de no enterarse
de que escribió.

**3. El rate-limit del ADR 0007 tuvo que subir al borde.** Sus dos capas viven
en `handleIncoming`, que ahora corre *después* de escribir en Redis. Sin cota
delante, cualquiera con el token del webhook llenaría Redis a request por
request — y con Redis lleno se caen también el dedup, los tokens de la página
pública y la cola de recordatorios. La cota se aplica ahora en el webhook,
antes del `add`.

**4. Datos del paciente pasan a vivir en Redis.** El job lleva el teléfono y el
texto del mensaje, que puede ser información de salud. El ADR 0004 razona el
riesgo aceptado **sobre Postgres** (TLS, cifrado de disco gestionado); Redis no
cumple ninguna de esas premisas. Mitigaciones aplicadas: retención **por edad**
(15 min los completados, 24 h los fallidos) en vez de por cantidad, truncado
del texto a 4 000 caracteres, y `parseRedis` pasando ya usuario, contraseña y
`rediss://` al cliente, que antes descartaba en silencio.

**5. El orden de los mensajes deja de estar garantizado por construcción.** La
concurrencia del worker se fija explícitamente en 1, porque la FSM de
agendamiento vive en `Conversation.flowStep` y dos mensajes procesados a la vez
se pisarían el paso. Aun así, **un reintento reordena**: un job que falla vuelve
al final de la cola. Ver "Pendiente" abajo.

## Alternativas descartadas

- **Responder 200 y procesar en background sin cola** (`void handleIncoming()`):
  no sobrevive a un reinicio del proceso y no da reintentos ni observabilidad.
- **Subir el timeout del webhook en WAHA**: no lo controlamos del todo y no
  arregla el reproceso, sólo lo hace menos frecuente.
- **Encolar sólo un identificador** y releer el texto de Postgres en el worker:
  es la mejor opción para el punto 4 —Redis se queda sin datos del paciente y
  el borrado LGPD tiene una sola fuente de verdad— pero exige mover la
  escritura de `Conversation` + `Message IN` al webhook, y eso vive hoy dentro
  de `handleIncoming`. Queda como el siguiente paso, no descartada.

## Pendiente

1. **Quitar el rate-limit de `handleIncoming`.** Mientras siga en los dos
   sitios, cada mensaje consume presupuesto dos veces (límites efectivos a la
   mitad) y, peor, **un reintento vuelve a consumir**: si cruza el cap,
   `handleIncoming` hace `return` en silencio, el job se marca completado y el
   mensaje se pierde sin fallo ni alerta. Es el camino de pérdida silenciosa que
   queda abierto.
2. **Encolar sólo el id** (alternativa de arriba).
3. **Lock por conversación** si algún día hay más de una réplica del backend:
   `concurrency: 1` sólo ordena dentro de un proceso.
4. **`handleIncoming` no es idempotente**: `reply()` manda el `sendText` y
   *después* escribe el `Message` OUT, así que un reintento reenvía el texto al
   paciente. No es nuevo, pero 3 reintentos automáticos multiplican la
   exposición.
