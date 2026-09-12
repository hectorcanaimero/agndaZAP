# ADR 0023 — La cota de transcripción falla cerrada, y el ADR 0007 no

- **Estado**: aceptado
- **Fecha**: 2026-09-12
- **Contexto previo**: [[adr/0007-rate-limit-bot]], [[adr/0004-pii-y-compliance]] §7.2

## Contexto

El ADR 0007 puso dos ventanas de rate-limit al bot (15 mensajes/min por chat,
500/h por clínica) y las declaró **fail-open**: si Redis no responde, se deja
pasar todo. Es la decisión correcta para lo que protegía — el coste de dejar a
un paciente sin respuesta por un blip de Redis es peor que el de una llamada de
más al LLM.

M10 mete en ese mismo camino las notas de voz, y ahí el signo del error cambia:

- una llamada de más se paga en **dinero**, por minuto de audio;
- y manda **la voz de un paciente** a un tercero.

Además, 500 mensajes/h por clínica son unas 12.000 transcripciones al día. Como
tope de gasto, eso no es un techo.

## Decisión

Una cota propia para la transcripción, con tres propiedades que la separan del
ADR 0007:

1. **Fail-closed.** Si no se puede contar, no se transcribe.
2. **Reservar y comprobar en el mismo comando** (`INCR` y comparar el valor que
   devuelve), en el worker y justo antes de llamar al proveedor.
3. **Dos cotas**: por clínica (el gasto) y por chat (el abuso).

El día se cuenta en **UTC**, no en la zona de la clínica.

## Consecuencias

**El fail-closed no puede convertirse en silencio.** Cuando el estado es
*indeterminado* —Redis mudo— no se transcribe, pero el aviso de "solo puedo leer
mensajes de texto" se **fuerza**, saltándose su throttle de 6 h. Ese throttle
vive en el mismo Redis que acaba de fallar y es fail-closed, así que sin
forzarlo el paciente se quedaba sin transcripción *y* sin respuesta: peor que
antes de M10, y justo en el escenario para el que se eligió el fail-closed.

**La reserva va donde se gasta el dinero, no donde se decide.** Comprobar al
encolar (webhook) sirve para decidir ya qué se le responde al paciente, pero no
puede ser la autoridad: no pararía los jobs ya encolados ni un `retry` desde el
panel de BullMQ cuando se baja el límite durante un incidente de coste — el
mismo argumento por el que `STT_ENABLED` se recomprueba en el worker. Contar al
encolar, además, cobraba por todo lo que aborta en medio (consent no enviable,
audio caducado, sin clave de OpenAI).

**Leer con `GET` y apuntar aparte no era fail-closed.** Con un Redis que acepta
lecturas y rechaza escrituras —disco lleno con `stop-writes-on-bgsave-error
yes`, que es el default— el contador se congela: el `GET` sigue devolviendo un
número bajo y la cota queda **desactivada en silencio**, gastando dinero. Es
exactamente el fallo que esto existe para impedir, así que la autoridad es el
`INCR`.

**La sub-cota por chat no es opcional.** Sin ella, un solo número agota los 200
del día en unos 14 minutos (el ADR 0007 le deja 15 mensajes/min): la clínica
paga las transcripciones del atacante y sus pacientes reales se quedan sin el
feature el resto del día. La clave del chat va **hasheada** (HMAC con
`LOG_HASH_SECRET` y el `clinicId` en la preimagen): un teléfono en claro dentro
de una clave de Redis es PII, y ya hay deuda de eso en `bot:media-notice:`.

**El día es UTC, contra la regla general del repo.** CLAUDE.md dice que las
fechas van con la zona de la clínica, y eso vale para **fechas que alguien lee**.
Esta no la lee nadie, y la zona la edita el propio tenant
(`PATCH /api/clinics/me`): con la fecha local dentro de la clave, rotar la zona
genera claves nuevas y triplica la cota. Un control de gasto que el controlado
puede reiniciar no es un control. De regalo desaparece otro agujero:
`Clinic.timezone` es un `String` libre y una zona inválida hacía que Luxon
devolviera la cadena `"Invalid DateTime"`, dejando una clave que no rota nunca
— esa clínica pasaba de 200 al día a 200 cada 48 h, sin ninguna señal.

**Agotada la cota, al paciente no se le deriva de entrada.** Cae al aviso de
"solo puedo leer mensajes de texto". Quien puede escribir sigue siendo atendido
por el bot sin ocupar a nadie; quien insista con audios acaba derivado igual por
la racha de adjuntos que ya existía. Eso último tiene una consecuencia que
conviene tener escrita: **dos notas de voz seguidas escalan a una persona y
resetean la FSM de agendamiento**, así que un paciente a mitad de agendar que
mande dos audios pierde el flujo. Con cota, esos dos audios se transcribían y la
cita salía.

**Lo que la clínica ve.** El evento `bot.turn` lleva
`reasonCode: 'stt-sin-presupuesto'` y `inputKind: 'audio'`, y los dos se cuentan
en el hash del día (`reason:*`). Sin el `inputKind`, el contador `audio` bajaba a
cero justo al agotarse la cota: se perdía a la vez cuántas notas de voz llegan y
por qué no se transcriben, que son las dos señales que explican la caída.
**Mostrarlo en el panel sigue pendiente**: el dato existe y es consultable desde
hoy, el gráfico no.

## Alternativas descartadas

- **Reusar el rate-limit del ADR 0007 subiendo su granularidad**: mezclaría dos
  políticas con signos de error opuestos en el mismo helper. La próxima persona
  que toque el fail-open rompería el tope de gasto sin enterarse.
- **Cota por clínica en base de datos** (`Clinic.sttDailyLimit`): más flexible,
  pero una query por nota de voz y una migración para algo que en piloto se
  ajusta con una env. Cuando haya que diferenciar por plan, entonces sí.
