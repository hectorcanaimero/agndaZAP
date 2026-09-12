# Bitácora de sesiones — AgendaZap

## 2026-09-12 — Panel: la cita de las 23:45 desaparecía de "próximas" (rama `fix/dashboard-today-spec-hora`)
- Apareció como un test flaky (`dashboard.controller.spec` fallaba sólo pasadas
  las ~22:30 hora de la clínica) y resultó ser un bug de verdad: `upcoming`
  filtraba por `endAt < endOfToday`, así que una cita de las 23:45 que acaba a
  las 00:15 contaba en `today.total` pero no salía en la lista. La clínica veía
  "6 citas hoy" y 5 debajo, **al final del día**, que es justo cuando mira qué
  le queda por atender.
- El rango del día ya lo aplica la query sobre `startAt`; el filtro en memoria
  sólo tiene que descartar las pasadas.
- El reloj del spec queda fijado con `Settings.now` (no con fake timers: el
  controller usa Luxon, y así el `now` del test y el del código son el mismo
  instante). El test que quedaba a merced de la hora era el síntoma, no la
  causa, pero un test que falla según cuándo se ejecute es ruido que acaba
  ignorándose.
- Verificado por mutación: con el filtro viejo, el test nuevo cae.

## 2026-09-12 — B6: el aviso de "asistente automático" deja de repetirse en cada saludo (rama `feat/bot-disclosure-24h`)
- **Antes**: `resolveBotMessage('greeting')` concatenaba `aiDisclosure` SIEMPRE. Un paciente que saluda tres veces en la semana leía tres veces que habla con un bot. **Ahora**: el primer saludo de la conversación siempre lo lleva, y después como mucho una vez cada 24 h.
- **Sin estado nuevo**: no hay columna `disclosureShownAt` ni flag en `flowData`. `shouldSendAiDisclosure` pregunta si hay algún `Message OUT` de esa conversación en las últimas 24 h **cuyo cuerpo contenga el aviso**. La query cae en el índice `[conversationId, createdAt]` que ya existe.
- **El bug que encontró el code-reviewer, y por qué el filtro es por texto**: mi primera versión contaba tráfico OUT, no avisos. La conversación no la crea solo el bot — el aviso de adjuntos (B4), el prompt de NPS, la alerta a recepción y el retorno del handoff escriben `OUT` sobre conversaciones que ellos mismos acaban de crear. Un paciente cuyo primer mensaje es una foto recibía "solo puedo leer texto", saludaba después y **se quedaba sin aviso en su primer contacto**: justo la garantía que el ADR promete. Y no era solo compliance — el aviso es el único sitio donde se le dice que escriba *humano*. Filtrando por `body contains`, la consulta pregunta literalmente lo que dice el ADR.
- **Lección**: el proxy barato ("¿hubo tráfico?") y la propiedad que quieres ("¿ya se lo dijimos?") coinciden solo mientras un único subsistema escriba en esa tabla. Aquí escriben cuatro.
- **Fail-open**: si la consulta al historial falla, el aviso se manda igual. Repetirlo es ruido; omitirlo sería incumplir.
- **Un solo sitio concatena el aviso**: `resolveBotMessage` y `greetingWithAppointment` ahora devuelven el saludo pelado y `buildGreeting` decide. Era la única forma de que la ventana no se saltara por un call-site nuevo, y de paso las dos ramas del saludo (genérico y con cita próxima) comparten la regla en vez de copiarla.
- **Deuda que NO cierra este PR** (anterior a B6, anotada en el ADR): el aviso solo viaja en las ramas del saludo. Un primer contacto que entra directo a la FSM, al RAG o al handoff nunca lo ve. Cerrarlo es moverlo al primer `OUT` de la conversación dentro de `reply()`; toca el copy de varios flujos, así que es ítem propio.
- **Encuadre de compliance** (aprobado por el owner, anotado en [[adr/0004-pii-y-compliance]] §7.1): el requisito es que el paciente sepa que habla con un bot y cómo salir, no que se lo repitan. El consentimiento con la lista de proveedores sigue viviendo en el form público y la política de privacidad, que es lo que tiene valor legal.
- **Tests**: 11 nuevos en el `describe` de B6, más el de `resolveBotMessage` reescrito y un invariante en `bot.messages.spec.ts` que prohíbe placeholders y comodines de `LIKE` en `aiDisclosure` — un `{clinicName}` ahí apagaría B6 en silencio, porque la consulta casa contra el copy sin renderizar. El mock de `message.count` es una bandeja en memoria que aplica los cuatro filtros de la consulta, así que los tests comprueban lo que el servicio pregunta y no lo que el mock devuelve; incluye los `OUT` de otros subsistemas que tumbaban la versión anterior.
- **Deuda de tests anotada**: `prisma.message.findFirst` es un único `mockResolvedValue` compartido por `hasConfirmationContext` y `withClosingCta`; un tercer call-site recibiría el stub equivocado **en silencio**. La `outbox` de este PR es la pieza que debería respaldarlo también, enrutando por `where`. Ítem propio.

## 2026-09-12 — M10 PR 4: la transcripción cableada de verdad (rama `feat/stt-cableado`)
- Cierra M10. El webhook decide si hay algo que transcribir y el worker lo
  transcribe: el proceso que responde el webhook no manda audio a nadie.
  Detalles y decisiones en [[notas/2026-09-12-stt-cableado-notas-de-voz]].
- **`STT_ENABLED` apagado por defecto, y comprobado dos veces** (al encolar y al
  procesar). Solo en el webhook no habría parado los jobs ya encolados ni un
  `retry` desde el panel de BullMQ: un kill switch que no mata no sirve para
  responder a un incidente de cumplimiento.
- **Sin `voiceNoteFirstTime` entregado no se transcribe.** El aviso de #100 sale
  una vez por conversación antes de mandar nada a OpenAI, y si no se puede
  enviar se deriva a una persona.
- **La prueba del consent es una columna, no un mensaje** (`voiceConsentAt` +
  `voiceConsentVersion`). La primera versión usaba el `Message OUT` con el texto
  del aviso; el auditor mostró que es falsificable — `reply` persiste la
  respuesta del LLM verbatim y el copy es público, así que una inyección de
  prompt planta una fila idéntica sin que el aviso salga nunca. Una prueba que
  el propio sistema puede fabricar no se puede enseñar.
- **`NEEDS_HUMAN` dejaba al paciente en silencio absoluto**, el hallazgo en el
  que coincidieron auditor y revisor. El gate era `=== 'BOT'`, pero el aviso de
  "solo leo texto" ya se había suprimido arriba: ni transcripción ni respuesta,
  peor que antes de M10. Corta `HUMAN` y solo `HUMAN`; `NEEDS_HUMAN` es justo
  donde más ayuda transcribir. El estado pasa a tiparse con el enum de Prisma.
- **El error que se relanza sale saneado.** BullMQ escribe `message` y
  `stacktrace` en el `failedReason` del job, en Redis sin cifrado at-rest: lo
  que ya se cuidaba para el log y para Sentry se estaba escribiendo ahí entero,
  y desde M10 puede llevar la transcripción dentro.
- **Conversación en `HUMAN` → no se transcribe.** Se pagaría la llamada y se
  mandaría la grabación a un tercero para que la lea alguien que ya está
  leyendo el hilo.
- **El gotcha de BullMQ que invertía la prioridad**: los jobs sin `priority` van
  a `wait` y `moveToActive` la vacía entera antes de mirar el ZSET
  `prioritized`. El job "prioritario" de audio iba el último. Los de texto
  llevan ahora prioridad baja para que el audio adelante de verdad.
- La transcripción se guarda en el job (`updateData`): un fallo aguas abajo ya
  no hace que el reintento pague otra vez la llamada sobre un audio que además
  pudo caducar.
- Pendiente de decisión del owner **antes de encender el flag**: la FSM se fía
  de la transcripción como si fuera texto escrito (un "sí" mal transcrito
  confirma una cita que el paciente nunca leyó) y el flag es global, no por
  clínica.
- Tres pasadas de `security-auditor` y una de `code-reviewer`. De la última:
  copy de fallo localizado (`pt` recibía español), `botLocale()` sobre el
  `Clinic.locale` crudo, `latencyMs` en los eventos de fallo, la URL del media
  entera o nada (un `slice` dejaba un enlace roto en la bandeja) y tres tests
  que pasaban por el motivo equivocado.
- `pnpm --filter @showly/backend test` en verde: 68 suites, 1464 tests.

## 2026-09-12 — M10 PR 3: listo para mergear ahora que PR 2 está en `main`
- #99 (`feat/stt-notas-de-voz`, `SttService`) se mergeó en `9b8d814`. Mergeé
  `main` en PR 3 y corregí el ADR 0004 §7.2 para reflejarlo: PR 1 y PR 2 ya
  están en `main`, ninguno desplegado/cableado todavía.
- El propio PR 2 marcó el orden correcto: cablear `SttService` al bot **antes**
  de que este PR 3 esté en `main` abriría una ventana real donde se mandan
  notas de voz a OpenAI bajo un consent que solo habla de texto. Quedó anotado
  en el ADR como "orden de encendido, no solo de merge", con la recomendación
  de un flag por clínica si el cableado necesita salir antes del deploy del
  copy nuevo.
- Quito el borrador: `pnpm --filter @showly/backend test:ci` sigue en verde
  tras el merge.

## 2026-09-12 — M10 PR 3 (borrador): copy de consent para notas de voz (rama `feat/consent-notas-de-voz-ia`)
- Actualiza el texto de consent (form público, política de privacidad `es`/`pt`) y agrega
  `BotCopy.voiceNoteFirstTime` en `bot.messages.ts` para el aviso que el bot manda la primera vez
  que un paciente envía una nota de voz. Versión 2 del texto de consent del ADR 0004 §7
  (documentado en la nueva §7.2): agrega que las notas de voz se transcriben con IA (OpenAI) y que
  el audio se elimina en minutos.
- **PR abierto como borrador a propósito**: el texto describe lo que hace M10 PR 1 (#98, ya en
  `main`, WAHA descarga y borra el audio a los 15 min) y PR 2 (`SttService` transcribe y descarta
  el audio, todavía no mergeado). No se mergea hasta que PR 2 lo esté.
- No toca `bot.service.ts` ni `webhook.controller.ts`: es copy y documentación, según el reparto de
  `docs/plans/2026-09-11-p0-bot-reparto.md`.

## 2026-09-12 — M10 PR 1: que WAHA descargue los adjuntos (rama `feat/waha-media-storage`)
- **El gotcha**: NOWEB entrega `hasMedia: true` con `media: null` si el contenedor no tiene `WAHA_MEDIA_STORAGE`. Detecta el adjunto y no lo descarga, así que no hay nada que transcribir ni que escuchar. Las variables van al servicio `waha`, no al backend.
- **La decisión de verdad es `WHATSAPP_FILES_LIFETIME`**, que el encargo no contemplaba. El default de WAHA son **180 s**, que deja sin audio a cualquier reintento de la cola de transcripción; y `0` desactiva la limpieza, convirtiendo la base en un archivo permanente de grabaciones de pacientes — PHI sin retención ni cifrado at-rest. Elegimos **900 s**, explícito en los tres compose.
- Es lo que hace aplicable el *"transcribir y no guardar el audio"* de la nota de exploración: no basta con que el backend no lo persista, hay que configurar que WAHA tampoco.
- El `Message IN` pasa de `[audio]` a `[audio] (17s · url)`. La duración viene anidada y cambia de sitio entre versiones de NOWEB, así que se prueban varias rutas; y la URL se valida a `http(s)` antes de guardarla, porque viene de un tercero y acaba en la bandeja del panel.
- **No rompe nada si no se despliega**: sin las envs, `media` llega `null` y el body queda como antes.
- **Tests**: 1380 verdes.

## 2026-09-11 — S8-bis: revisión de los pares `clinicId` + FK restantes (nota, sin migración)
- Nota en [[notas/2026-09-11-revision-fks-compuestas-restantes]] con la decisión pareja por pareja y un plan de un solo PR.
- **Comprobado contra la base**: cero filas cruzadas en los ocho pares. La query queda escrita para correrla contra producción antes de migrar.
- **El que más urge es `Appointment → Patient`**: es el único de la lista donde cruzar el par no solo muestra datos ajenos sino que **contacta a alguien** — los recordatorios le mandarían un WhatsApp al paciente equivocado.
- **Se quedan fuera** `BusinessHour` y `TimeOff` (tienen validación, los escriben endpoints estables y lo que filtran es un horario, cero PII) y `User → Professional`, que es un problema de modelo y no de integridad: `User.clinicId` es nullable por el SUPERADMIN.
- **Trampa documentada**: con `MATCH SIMPLE` —el default de Postgres— una FK compuesta **no se comprueba si alguna columna es NULL**, y cinco de los ocho pares tienen la suya nullable. La FK añade una red, no sustituye la validación de código. Conviene no descubrirlo revisando el PR de la migración, ni creer que el problema quedó cerrado.
## 2026-09-11 — S31: el fallback de Gemini estaba muerto y nadie lo sabía (rama `fix/router-gemini-modelo-vigente`)
- **Dos fallos que se tapaban entre sí**: el router llamaba a `models/gemini-2.0-flash`, que Google marca como **(Shut down)** en su documentación, y además `GEMINI_API_KEY` nunca se configuró en producción. Como el router se saltaba **en silencio** los providers sin clave, la cadena real llevaba semanas siendo `deepseek → opencode` sin tercer eslabón.
- Lo encontré preparando la nota de STT (M10), verificando la premisa de que "Gemini multimodal ya está en el router".
- **Arreglos**: modelo por defecto `gemini-2.5-flash` (el que Google documenta como mejor relación precio/rendimiento para baja latencia y alto volumen) y **configurable por `GEMINI_MODEL`** — el fallo original fue quedarse clavado en un modelo retirado, así que migrar debe ser una variable de entorno y no un deploy.
- **El router avisa al arrancar** qué providers se va a saltar y qué env les falta; si no queda ninguno, lo registra como `error` y no como `warn`, porque sin LLM el bot no clasifica intenciones ni responde consultas: degrada a "no te entendí" en cada mensaje.
- **Caso real cubierto en test**: en Coolify hay variables duplicadas con valor vacío (`OPENCODE_API_KEY` aparece dos veces, una en blanco). Un provider "a medias" ahora cuenta como no disponible y se nombra qué le falta.
- **Tests**: 1345 verdes.

## 2026-09-11 — M10: exploración de STT para notas de voz (sin código)
- Nota en [[notas/2026-09-11-exploracion-stt-notas-de-voz]] con comparativa, precios verificados en septiembre de 2026 y plan de 3 PRs.
- **Recomendación: OpenAI `gpt-4o-mini-transcribe`.** No por precio —a este volumen las tres opciones cuestan céntimos— sino porque es el único proveedor **ya dentro del consent del ADR 0004**, que nombra explícitamente a OpenAI, DeepSeek y Google. Sumar Deepgram obligaría a reescribir el texto legal, versionarlo y volver a pedirlo.
- **Deepgram es la mejor tecnología de las tres y aun así la peor opción aquí**: su ventaja es la latencia de streaming, y una nota de voz llega entera. Pagaríamos un coste legal real por una ventaja que este caso de uso no usa.
- **Regla propuesta: transcribir y NO guardar el audio.** Una nota de voz es mucho más sensible que el texto equivalente —lleva la voz, el ruido de fondo, quién más está en la habitación— y el ADR 0004 §1 ni siquiera cifra las `notes` at-rest.
- **Tres premisas del encargo que no se sostenían**, verificadas: (a) Gemini NO está usable en el router —llama a `gemini-2.0-flash`, retirado en junio de 2026, y `GEMINI_API_KEY` no está en Coolify, así que la cadena real es `deepseek → opencode`—; (b) WAHA no descarga media (faltan las envs `WAHA_MEDIA_*`), así que hoy llega `hasMedia: true` con `media: null`; (c) el handoff tras dos adjuntos no está en producción porque #46 quedó huérfano.
## 2026-09-11 — S17: CI falla si la corrida de tests fue verde pero incompleta (rama `ci/fallar-si-un-suite-no-arranca`)
- **Lo que ya estaba cubierto** (verificado con sondas, no asumido): un suite que no arranca sale con exit 1, y un fichero de test sin tests también. CI ya los cazaba.
- **El hueco real**: los tests que EXISTEN y no se ejecutan. Un `it.only` olvidado deja el resto del fichero sin correr y Jest sale **0** diciendo "1 passed" — incluidos los tests que habrían fallado. Un suite entero con `it.skip` sale 0 también. Es el caso peligroso porque es el que ocurre sin querer: alguien depura en local y commitea el `.only`.
- **Arreglo**: `pnpm test:ci` corre Jest con `--json` y `scripts/assert-test-run.mjs` falla si hay suites que no arrancaron, ficheros sin tests, o tests en estado `pending`/`todo`. El mensaje nombra cada test que no corrió.
- **Auditoría M4/M6 en `bot.service.spec.ts`: no hay duplicados.** Ningún nombre repetido (96 tests), y los dos únicos pares que se solapaban en tema —los de `answer=null` y los de chat `@lid`— afirman cosas distintas y son complementarios: uno comprueba el cambio a `NEEDS_HUMAN` y el otro que NO se anexa el link; uno que el `phone` llega null al RAG y el otro que la invitación sale igual. No se borra nada.
- **Nota de método**: mi primer intento de auditar fue un parser de texto sobre el spec, y volvió a atribuir tests al `describe` equivocado —el mismo error que ya cometí con el `});` perdido—. La herramienta correcta es `jest --verbose`, que imprime el árbol real.
- **Tests**: 1307 verdes.

## 2026-09-11 — M3-a: clasificador de intención v2 (rama `feat/intent-clasificador-v2`)
- **Prompt con definición y 2 ejemplos por intención**, en es/pt según el locale de la clínica. Es lo que de verdad mueve la precisión con un modelo barato: sin definiciones, el modelo inventa su propio criterio para las clases ambiguas. Los ejemplos son frases reales de WhatsApp, no prosa de manual.
- **Salida JSON `{ intent, confidence }`** con parseo de igualdad EXACTA contra el enum. El parser viejo usaba `includes`, así que una respuesta como "no es agendar" clasificaba como AGENDAR — y había un test que lo daba por bueno. Confianza < 0.6 → `OTRO`: preferimos "no te entendí" a ejecutar la acción equivocada, porque un CANCELAR mal clasificado le cancela la cita a alguien que solo preguntaba.
- **Intenciones nuevas**: `AGRADECER` y `CONSULTA_CITA` (pregunta por SU cita, distinta de `PREGUNTA_FAQ`, que pregunta por la clínica).
- **Contexto opcional** de los últimos 3 mensajes (600 chars, recortando por el principio porque lo reciente desambigua más). **Es texto de un tercero**: va en bloque delimitado, con los `---` neutralizados como en `knowledge.service.ts`, y con instrucción explícita de que solo sirve para resolver referencias. Test de inyección: una orden dentro del historial no decide la clasificación.
- **Set de 30 frases reales** que fija la frontera entre prefiltro determinista y LLM — 17 se resuelven sin gastar una llamada. Es donde están los errores caros: si el prefiltro se traga una frase que no le toca, el LLM nunca la ve y no hay prompt que lo arregle (B2 y B3 fueron eso).
- **Hallazgo del set**: `"muchas gracias 🙏"` no lo reconoce el prefiltro porque `normalizeText` no quita emojis. No es grave —el LLM lo clasifica como AGRADECER— pero es una llamada que sobra en una de las frases más comunes de WhatsApp. Arreglarlo toca `message-matching.ts`, compartido con `bot.service.ts`, así que queda como ítem propio.
- **Tests**: 1283 verdes (el único rojo es el test de temporización flaky de health, ajeno).

## 2026-09-11 — M8: fallback léxico del RAG y spec de calibración (rama `feat/rag-fallback-lexico`)
- **El hueco**: `text-embedding-3-small` falla justo con las preguntas cortas y coloquiales de WhatsApp. "Donde están ubicados" daba 0.619 contra el chunk correcto; el umbral está en 0.65, o sea que pasaba por poco, y "dónde queda la clínica" matcheaba el chunk equivocado.
- **Arreglo**: cuando el vector no devuelve nada y la pregunta tiene ≤ 6 palabras, se busca con `word_similarity` de pg_trgm. Migración que instala la extensión + índice GIN.
- **El umbral se midió, no se eligió a ojo**: con las preguntas reales de la nota contra las FAQ de la BD de desarrollo. Los aciertos inequívocos dan 0.650 y 0.548; el ruido ≤ 0.368, y por debajo de 0.22 además apunta al chunk equivocado. Umbral 0.5, conservador porque la muestra es pequeña.
- **`word_similarity` y no `similarity`**: la segunda normaliza sobre las cadenas enteras, así que una pregunta de tres palabras contra un chunk largo da siempre un número diminuto.
- **Solo preguntas cortas**: en una larga, que el vector no encuentre nada es información, y buscar coincidencias de texto solo añade ruido.
- **`rag-calibracion.spec.ts`** fija las mediciones reales sin llamar a OpenAI. No re-embebe ni valida el modelo: fija la **frontera de decisión**, de modo que quien mueva un umbral vea exactamente qué preguntas de pacientes rompe. Incluye la propiedad de fondo —que existe un corte limpio entre preguntas de clínica y ajenas— y deja constancia de que el margen es estrecho (0.619 pasa, 0.723 no).
- **Tests**: 1233 verdes.

## 2026-09-11 — S18: tests de integración contra Redis real en CI (rama `ci/tests-integracion-redis`)
- **El motivo concreto**: escribiendo los tests unitarios del índice de tokens (S13), mi mock de `del` solo borraba claves de tipo string, así que el test de "borra también el índice" pasaba **sin que el índice —un SET— se borrara**. El `DEL` real borra la clave sea del tipo que sea. El mock confirmaba lo que yo creía en vez de lo que Redis hace.
- **Qué se prueba**: lo que un mock no puede demostrar — atomicidad de `SET NX` (dedup del webhook) y de `INCR` (rate-limit) bajo concurrencia real, semántica de expiración, mezcla de tipos de clave, y el dedup por `jobId` de BullMQ.
- **El test de BullMQ fija un comportamiento que ya nos mordió**: un `add` con un `jobId` existente es un **no-op silencioso** — no lanza, no reemplaza, no avisa, y el job conserva el delay viejo. Es la razón de que el `check-risk` pudiera quedarse rancio y de que ahora lleve `startAtMs`.
- **Job de CI separado** del `backend`: los unitarios siguen corriendo en segundos y sin servicios, que es lo que hace que se ejecuten a menudo. El de integración levanta `redis:7-alpine` con healthcheck.
- Los de integración se llaman `*.int-spec.ts` **con guion**, para que el `testRegex` de los unitarios no los capture.
- **Pendiente**: los tests de la cola `bot-inbound` en sí, cuando #65 esté en main. La semántica de la que depende ya queda cubierta.
- **Tests**: 1163 unitarios + 21 de integración, verdes.
## 2026-09-11 — S25: error tipado para el tope de reagendamientos (rama `fix/reschedule-limit-error-tipado`)
- **Deuda propia**: al implementar el tope en S6 dejé que el controller distinguiera los dos 409 de `rescheduleAppointment` con `e.message.includes('tope de reagendamientos')`. Funcionaba y era frágil por definición — este repo reescribe copy a menudo, por tono o por traducción, y cualquiera de esas pasadas rompía la lógica sin fallar en compilación ni en los tests del emisor.
- **Arreglo**: `SchedulingConflictException` con `code` en el cuerpo, y dos subclases — `RescheduleLimitExceededException` (`RESCHEDULE_LIMIT`) y `SlotTakenException` (`SLOT_TAKEN`). Siguen siendo `ConflictException`, así que el status y todo el manejo existente no cambian: quien no mire el `code` se comporta igual que antes.
- **Por qué importa el caso**: los dos 409 piden respuestas **opuestas** — "el horario se ocupó" invita a elegir otro, "ya cambiaste demasiadas veces" invita a llamar a la clínica. Confundirlos manda al paciente al sitio equivocado.
- **Tests**: 1168 verdes, incluido uno que reescribe el mensaje por completo y comprueba que la distinción sobrevive.

## 2026-09-11 — S13: los links de gestión mueren con la cita (rama `fix/invalidar-tokens-gestion`)
- **El problema**: solo se podía quemar el token que el paciente acababa de usar. Se emiten varios por cita (respuesta del POST, recordatorios, mensajes del bot), así que los demás sobrevivían apuntando a una cita ya cancelada y seguían mostrando nombre, servicio, profesional y horario hasta agotar su TTL de 30 días. No permitían mutar nada, pero era PII expuesta sin motivo.
- **Arreglo**: índice `sched:manage:appt:{id}` en Redis e `invalidateAllForAppointment`, llamado desde el panel (al pasar a estado terminal) y desde la cancelación por link.
- **Solo en estados terminales, no al reagendar** — discrepé aquí con el plan y se aceptó: tras un reagendamiento la cita sigue viva y el token sigue apuntando a la cita correcta mostrando el horario nuevo. Invalidarlo rompería un link que funciona justo después de que la clínica le moviera la cita al paciente, sin ninguna ganancia de seguridad.
- **El TTL del índice es el techo (30 días), no el del último token**: si heredara uno más corto, el índice moriría antes que un token más antiguo y lo dejaría huérfano — justo lo que esto viene a evitar.
- Todo best-effort: si Redis falla, ni la emisión del link ni la cancelación se caen. Perder la capacidad de revocar antes del TTL es malo; no poder mandarle el link al paciente, o revertirle una cancelación ya hecha, es peor.
- **Tests**: 1038 verdes.

## 2026-09-11 — S22: validar el tenant del `conversationId` al crear cita (rama `fix/appointment-conversation-tenant`)
- Salió del barrido de [[adr/0022-fk-compuestas-multi-tenant|S8]]: era el único de los diez pares `clinicId` + FK **sin ninguna validación**. `createAppointment` persistía `conversationId` con `source === 'BOT_WEB'` sin comprobar que la conversación fuera de la misma clínica.
- **Por qué importa aunque hoy no sea alcanzable**: `findUpcomingAppointment` resuelve por `appointment.conversationId` (S5), así que una cita atada a la conversación de otra clínica dejaría que ese chat viera y gestionara la cita de un paciente ajeno. Hoy el id llega de un token que ya valida el slug — exactamente lo que se decía de `Feedback` antes de S4, hasta que alguien miró el `include`.
- **Falla en vez de ignorar el id en silencio**: si se dispara hay datos inconsistentes, y una cita creada a medias —sin el enlace al chat del que depende todo el flujo BOT_WEB— es peor que un error visible.
- Sin cambios para `PUBLIC`/`BOT`, que siguen descartando el id sin consultar nada.
- **Tests**: 1083 verdes, con el caso cross-tenant y los de no-regresión de los otros `source`.
## 2026-09-11 — S8: FK compuesta en Feedback y barrido de tablas que copian `clinicId` (rama `fix/feedback-fk-compuesta`)
- **El problema**: `Feedback` llevaba dos FKs sueltas (`clinicId` → Clinic y `appointmentId` → Appointment) y nada en la BD impedía que apuntaran a clínicas distintas. El `include` del panel trae nombre de paciente, profesional y servicio **de la cita**, así que una fila cruzada habría servido datos de otra clínica. El chequeo de S4 cierra el camino conocido; esto lo cierra para cualquier caller futuro.
- **La decisión** (→ [[adr/0022-fk-compuestas-multi-tenant]]): FK compuesta `(clinicId, appointmentId)` → `Appointment(clinicId, id)`, con `@@unique([clinicId, id])` en Appointment. Un par cruzado deja de ser un bug que hay que recordar evitar y pasa a ser un INSERT que Postgres rechaza.
- **La migración falla ruidosamente** si ya hay filas cruzadas, con la query exacta para revisarlas: si existen son datos mezclados entre tenants y hay que mirarlos a mano, no borrarlos desde una migración.
- **Barrido**: seis tablas copian `clinicId` junto a una FK a otra entidad con `clinicId`, con 10 pares en total. Casi todas tienen validación en el camino de escritura; el único sin ella que merece mirarse pronto es `Appointment.conversationId`, que hoy no es alcanzable pero tiene exactamente la forma del bug de `Feedback` antes de S4.
- **`feedback.controller.ts` no tenía spec** pese a servir PII de pacientes con scoping multi-tenant. Ahora sí, y el `where` exige el tenant también sobre la cita, no solo sobre el feedback — defensa que no depende de que la migración se haya aplicado.
- **Tests**: 1086 verdes.

## 2026-09-11 — S11: avisar a recepción cuando el paciente gestiona su cita (rama `feat/aviso-recepcion-cancelacion`)
- **El hueco que cerraba**: una cancelación por link solo aparecía si alguien refrescaba el panel. Para un producto anti no-show eso es media feature — el valor está en que la clínica pueda rellenar el hueco.
- **`alertReception` extraído** de `reminders.processor.ts` a `conversations/reception-alert.ts` y compartido. Es función suelta y no `@Injectable` porque el worker de recordatorios se construye a mano en `main.ts`, fuera del contenedor de Nest.
- **Los errores de escritura se propagan desde el helper**, y cada caller decide: el worker los deja subir para que BullMQ reintente, los endpoints los capturan porque la cancelación ya está persistida. La primera versión del refactor se los tragaba y rompió un test que existía justo para fijar esa propagación — buen recordatorio de que un `try/catch` movido de sitio cambia semántica.
- **`NEEDS_HUMAN` se reserva**: cancelación a menos de 24 h, o 2 cambios de horario o más. Marcarlo todo habría llenado la bandeja de hilos que nadie tiene que atender, y el aviso dejaría de significar nada.
- **`Appointment.canceledByPatient`** + `selfService` en el dashboard: cuánto resuelve el paciente solo. Una cancelación con aviso es un hueco recuperable, lo contrario de un no-show.
- **Apilado sobre #62** porque el disparo por `rescheduleCount >= 2` lo necesita.
## 2026-09-11 — S6: traza de reagendamientos y tope por link (rama `feat/reschedule-count-y-tope`, apilada sobre M2-a)
- **Campos nuevos**: `Appointment.rescheduleCount` y `lastRescheduledAt`, incrementados en `rescheduleAppointment` venga del panel o del link. Migración idempotente.
- **Reagendar reinicia el ciclo de confirmación**: la cita vuelve a `PENDIENTE` y se reprograman recordatorios + `check-risk`. `confirmedAt` **no** se borra: `status` dice si está confirmada ahora, `confirmedAt` si llegó a confirmarse alguna vez. Borrarlo reescribía métricas de días ya cerrados (el numerador perdía la confirmación y el denominador de recordatorios `SENT` se quedaba), y un dashboard histórico que cambia hacia atrás es un problema de confianza con la clínica. Una confirmación vale para un horario concreto; mantenerla haría que la clínica contara como confirmada una cita que el paciente no volvió a mirar.
- **Consecuencia que el plan no contemplaba**: eso es una transición `CONFIRMADA → PENDIENTE` que `ALLOWED_TRANSITIONS` declaraba imposible. El primer intento fue añadirla a la FSM, pero la revisión mostró que ensancharla es global: `PATCH /status` habría aceptado "desconfirmar" a mano por una ruta que no limpia `confirmedAt` ni reprograma nada, dejando la cita contada a la vez como pendiente y como confirmada en el dashboard. Solución final: la tabla se queda como estaba y se documenta que son las transiciones **que un humano puede pedir**; el reset del reagendamiento es una operación de sistema, con su propia regla y sus propios efectos.
- **Agujero encontrado en revisión, no por los tests**: degradar a `PENDIENTE` siempre dejaba sin recordatorio NI check-risk a toda cita movida a corto plazo (offsets `[24,3]` ya pasados), o sea desconfirmada para siempre y en silencio — y el caso típico es recepción moviendo una cita de hoy un par de horas, justo cuando el paciente acaba de confirmar por teléfono. Ahora `scheduleForAppointment` devuelve cuántos avisos quedaron armados y el estado solo se degrada si hay vía de recuperación.
- **Dos contadores**: `rescheduleCount` (todos, señal de riesgo) y `patientRescheduleCount` (solo los del link, gasta cupo). Sin separarlos, tres movimientos de recepción dejaban al paciente sin poder reagendar sin haber tocado nunca el link.
- **Job `check-risk` rancio**: `cancelForAppointment` borra con `.catch(() => undefined)` y `scheduleForAppointment` reusa el mismo `jobId`, que BullMQ deduplica. Si el borrado fallaba, el job viejo sobrevivía con el delay antiguo; antes era inofensivo porque la cita seguía `CONFIRMADA`, pero con S6 vuelve a `PENDIENTE` y la habría marcado `EN_RIESGO` a destiempo. Ahora el job lleva `startAtMs` y el processor se descarta solo.
- **La señal de riesgo va por el contador, no por el estado** — decisión del owner vía planner. Reagendar saca de `EN_RIESGO`, así que el estado perdería la traza en cada movimiento; `rescheduleCount` solo sube y se expone en la lista del panel.
- **Tope de 3 reagendamientos por link**, con 409 que deriva a la clínica. No aplica al staff ni afecta a cancelar: cancelar es justo lo que queremos que sea más fácil que no aparecer, así que `canCancel` sigue `true` con el tope alcanzado.
- De paso: `PATIENT_MUTABLE_STATUSES` pasa a reusar `RESCHEDULABLE_STATUSES` en vez de duplicar la lista (hallazgo del code-reviewer en M2-a).
- **Tests**: 999 verdes.

## 2026-09-11 — S10: los scripts de `prisma/` no los typecheckeaba nadie (rama `chore/typecheck-scripts-prisma`)
- **Causa raíz del CI rojo de #42**: `apps/backend/tsconfig.json` tiene `include: ["src/**/*"]`, así que `prisma/seed.ts` y `prisma/reindex-faq.ts` quedaban fuera. `pnpm tsc --noEmit` pasaba en verde con el seed roto y el error solo aparecía cuando el job E2E ejecutaba `ts-node prisma/seed.ts` — tarde, en un job caro y sin señalar al PR culpable.
- **Arreglo**: `tsconfig.scripts.json` aparte (con `noEmit`), script `typecheck:scripts` y paso propio en el job Backend de CI. **No** se amplía el `include` del tsconfig base: `tsconfig.build.json` lo extiende y con dos raíces TypeScript inferiría `rootDir: apps/backend`, la salida pasaría a `dist/src/main.js` y el `node dist/main.js` del Dockerfile dejaría de arrancar en prod.
- **Segundo bug encontrado al activarlo**: `prisma/reindex-faq.ts:51` construía `KnowledgeService` con 1 argumento de 3. Estaba en main y no lo cubría el hotfix #53; `pnpm prisma:reindex-faq` habría explotado al ejecutarse.
- Los `as any` sueltos de ambos scripts se sustituyen por una factory `makeIngestOnlyKnowledgeService` con casts tipados. Verificado que `ingest()` y `embedText()` no tocan `llm` ni `clinicFacts` (solo los usa `answer()`), así que las dependencias ausentes no se llaman nunca.
## 2026-09-11 — S12: auditoría de `Clinic.status` en la superficie sin auth (rama `fix/clinic-status-endpoints-publicos`)
- **Disparador**: al construir los endpoints de gestión de cita por link se me olvidó el filtro `status = ACTIVE` que los otros endpoints públicos sí tenían. Lo cazó el `security-auditor` y la pregunta obvia fue dónde más faltaba. Faltaba en tres sitios.
- **El feed iCal era el peor**: servía nombre y teléfono del paciente en cada evento sin mirar el estado de la clínica, y la URL vive indefinidamente en la app de calendario del profesional — habría seguido sincronizando PII de salud meses después de cerrar la cuenta, sin que nadie visite nada. Ahora devuelve feed vacío.
- **Invitaciones**: se podía entrar a una clínica suspendida. Comprobado en `getByToken` y otra vez en `accept`, porque entre ver la pantalla y pulsar el botón la clínica puede suspenderse y `accept` es el paso que da acceso de verdad.
- **Token de agendamiento**: hidrataba el form con nombre y teléfono del paciente. Alcance menor (TTL 30 min) pero es PII igual.
- **Ya estaban bien** y se verificaron: los tres endpoints de `/public/clinics`, el webhook WAHA (para `message`; `session.status` se procesa igual a propósito) y el login. `POST /public/leads` no es de clínica y los health checks no leen datos.
- Regla que queda escrita en [[notas/2026-09-11-offboarding-clinic-status]]: un token emitido cuando la clínica estaba activa **no es un permiso permanente**; el estado se comprueba al usarlo.
- **Tests**: 947 verdes, con caso `SUSPENDED`/`ARCHIVED` por endpoint.
## 2026-09-11 — S6: traza de reagendamientos y tope por link (rama `feat/reschedule-count-y-tope`, apilada sobre M2-a)
- **Campos nuevos**: `Appointment.rescheduleCount` y `lastRescheduledAt`, incrementados en `rescheduleAppointment` venga del panel o del link. Migración idempotente.
- **Reagendar reinicia el ciclo de confirmación**: la cita vuelve a `PENDIENTE` y se reprograman recordatorios + `check-risk`. `confirmedAt` **no** se borra: `status` dice si está confirmada ahora, `confirmedAt` si llegó a confirmarse alguna vez. Borrarlo reescribía métricas de días ya cerrados (el numerador perdía la confirmación y el denominador de recordatorios `SENT` se quedaba), y un dashboard histórico que cambia hacia atrás es un problema de confianza con la clínica. Una confirmación vale para un horario concreto; mantenerla haría que la clínica contara como confirmada una cita que el paciente no volvió a mirar.
- **Consecuencia que el plan no contemplaba**: eso es una transición `CONFIRMADA → PENDIENTE` que `ALLOWED_TRANSITIONS` declaraba imposible. El primer intento fue añadirla a la FSM, pero la revisión mostró que ensancharla es global: `PATCH /status` habría aceptado "desconfirmar" a mano por una ruta que no limpia `confirmedAt` ni reprograma nada, dejando la cita contada a la vez como pendiente y como confirmada en el dashboard. Solución final: la tabla se queda como estaba y se documenta que son las transiciones **que un humano puede pedir**; el reset del reagendamiento es una operación de sistema, con su propia regla y sus propios efectos.
- **Agujero encontrado en revisión, no por los tests**: degradar a `PENDIENTE` siempre dejaba sin recordatorio NI check-risk a toda cita movida a corto plazo (offsets `[24,3]` ya pasados), o sea desconfirmada para siempre y en silencio — y el caso típico es recepción moviendo una cita de hoy un par de horas, justo cuando el paciente acaba de confirmar por teléfono. Ahora `scheduleForAppointment` devuelve cuántos avisos quedaron armados y el estado solo se degrada si hay vía de recuperación.
- **Dos contadores**: `rescheduleCount` (todos, señal de riesgo) y `patientRescheduleCount` (solo los del link, gasta cupo). Sin separarlos, tres movimientos de recepción dejaban al paciente sin poder reagendar sin haber tocado nunca el link.
- **Job `check-risk` rancio**: `cancelForAppointment` borra con `.catch(() => undefined)` y `scheduleForAppointment` reusa el mismo `jobId`, que BullMQ deduplica. Si el borrado fallaba, el job viejo sobrevivía con el delay antiguo; antes era inofensivo porque la cita seguía `CONFIRMADA`, pero con S6 vuelve a `PENDIENTE` y la habría marcado `EN_RIESGO` a destiempo. Ahora el job lleva `startAtMs` y el processor se descarta solo.
- **La señal de riesgo va por el contador, no por el estado** — decisión del owner vía planner. Reagendar saca de `EN_RIESGO`, así que el estado perdería la traza en cada movimiento; `rescheduleCount` solo sube y se expone en la lista del panel.
- **Tope de 3 reagendamientos por link**, con 409 que deriva a la clínica. No aplica al staff ni afecta a cancelar: cancelar es justo lo que queremos que sea más fácil que no aparecer, así que `canCancel` sigue `true` con el tope alcanzado.
- De paso: `PATIENT_MUTABLE_STATUSES` pasa a reusar `RESCHEDULABLE_STATUSES` en vez de duplicar la lista (hallazgo del code-reviewer en M2-a).
- **Tests**: 999 verdes.

## 2026-09-11 — M2-a: gestión de cita por link (rama `feat/cita-gestion-por-link-api`)
- **Qué**: backend para que el paciente vea, cancele o mueva su cita desde `/agendar/{slug}/cita?t={token}`, sin escribir por WhatsApp. Token `manage` en Redis (no se consume al leerlo, TTL derivado de `startAt`), `SchedulingService.cancelByPatient`, tres endpoints públicos con rate-limit y `manageUrl` en la respuesta de creación. Ver [[adr/0020-gestion-cita-por-link]].
- **Decisión que cambió el contrato**: el plan pedía que reagendar creara una cita nueva y cancelara la vieja. Se descartó porque el no-show rate se calcula sobre `ATENDIDA + NO_SHOW + CANCELADA`: cada reagendamiento habría inflado el denominador y **diluido hacia abajo la métrica estrella del producto**, justo cuando la feature funcionara bien. Se mueve in-place reusando `rescheduleAppointment`. La traza de reagendamientos va aparte como S6 (`rescheduleCount`), sin tocar el enum de estados.
- **Segunda desviación del contrato**: el rate-limit iba a ser por token+ip. Se dejó por `scope:slug:ip` porque limitar por token lo vuelve inútil — cada token probado estrenaría su propio cupo, que es lo que necesita quien quiere iterar.
- **Cambio de firma**: `createAppointment` pasa a devolver `{ appointment, patientCreated }` (lo consume la sesión A en S5). Los tres callers actualizados. `patientCreated` **no sale nunca** al borde público: diría si un teléfono ya es paciente de la clínica, o sea un oráculo para enumerar pacientes. El dato se calcula con `create` + captura de P2002 en vez de deducirlo del `findUnique`, que mentiría bajo concurrencia.
- **Tests**: 980 backend verdes, `tsc --noEmit` limpio. Cobertura nueva en `scheduling-session.service.spec.ts` (TTL, suelo/techo, aislamiento entre los dos tipos de token), `scheduling.service.spec.ts` (cancelación, idempotencia, estados terminales, carrera del patientCreated) y `public.controller.spec.ts` (los tres endpoints, multi-tenant, no filtrar teléfono ni `patientCreated`).
- De paso: `Elegí otro` → `Elige otro` en el 409 del endpoint público, por [[notas/2026-09-10-tono-espanol-neutro]].

## 2026-09-11 — B9: el follow-up de satisfacción perdía el score (rama `fix/follow-up-upsert-conversation`)
- **Bug** (ítem B9 de [[analisis/2026-09-11-chatbot-analisis-tecnico]], ya anotado como deuda el 2026-09-09: "follow-up sin Conversation"): `send-follow-up` mandaba el prompt "1-5" por WhatsApp pero solo marcaba `flowStep=AWAITING_NPS_SCORE` dentro de un `if (convo)`. Un paciente que agendó por la página pública y nunca escribió por WhatsApp no tiene `Conversation`, así que el prompt salía igual y su "5" entraba al bot sin `flowStep`: caía al clasificador LLM, el score se perdía y el paciente recibía un fallback sin sentido. Silencioso — no había error en logs.
- **Fix**: la conversación se resuelve siempre. Primero `findFirst` por `(clinicId, phone)`; si no hay, `upsert` por la clave única `(clinicId, chatId)` con el id canónico `<digitos>@c.us`. Luego `flowStep` y `Message OUT` se escriben sin condicional.
- **Decisión no obvia** (→ [[notas/2026-09-11-conversation-chatid-canonico]]): el orden importa. Un `upsert` directo por `chatId` derivado del teléfono habría partido en dos el hilo de todo paciente que hubiera escrito desde un `@lid`, porque un LID no se puede derivar del número. `upsert` y no `create` para tolerar la carrera con un mensaje entrante (`BotService.handleIncoming` escribe la misma clave).
- **De paso**: `phoneToChatId()` extraído a `common/phone.util.ts` (estaba duplicado como privado en `WahaService`) — el formato tiene que ser único porque `(clinicId, chatId)` es `UNIQUE`; y el prompt de satisfacción decía "Respondé" (voseo) → "Responde", por [[notas/2026-09-10-tono-espanol-neutro]].
- **Tests**: 763 backend verdes, `tsc --noEmit` limpio. Regresión en `follow-ups.processor.spec.ts` (sin Conversation → se crea con el chatId canónico y queda en `AWAITING_NPS_SCORE`; con Conversation `@lid` → la reusa y no crea otra; multi-tenant) y 4 casos nuevos de `phoneToChatId` en `phone.util.spec.ts`. El test que documentaba el comportamiento buggy quedó invertido.
- **Contexto de sesiones**: P0 del bot repartido en paralelo (ver [[planes/2026-09-11-p0-bot-reparto]]). B9 es P2 pero chico y aislado; no toca `bot.service.ts`, `intent.service.ts`, `webhook.controller.ts` ni `knowledge.service.ts`, que estaban tomados por otras sesiones.

## 2026-09-09 (noche) — Sprints 2 y 3 en PRs apilados + dos hotfixes de producción
- **Hotfix 1 (PR #30, mergeado)**: en el primer deploy real TODO `POST` con JSON devolvía `500 "stream is not readable"` (login, leads, citas, webhook WAHA). Causa: `main.ts` registraba `express.json()` de `express@5` (dep directa desde el 18-08) además del body-parser de Nest (Express 4). Ahora `NestFactory.create<NestExpressApplication>(..., { rawBody: true })` + `useBodyParser` (1mb). Deuda: quitar `express@5` de `package.json`.
- **Hotfix 2 (PR #35)**: el merge de #29 dejó `pnpm-lock.yaml` con `luxon`/`@types/luxon` en specifier exacto y `package.json` con `^` → `--frozen-lockfile` falla, CI de `main` en rojo y build de Coolify roto. Sólo dos líneas del lockfile.
- **Fix (PR #36)**: el rate-limit público compartía UNA clave por `slug+ip` entre snapshot, disponibilidad y reserva; el `POST` (5/min) contaba los `GET` previos y el paciente recibía 429 al confirmar (lo reprodujo el smoke E2E). Clave `ratelimit:<scope>:<slug>:<ip>:<minuto>` y scopes `public-clinic` / `public-availability` / `public-book`. Spec nuevo del guard.
- **Sprint 2 cerrado en PRs**: #28 tests reminders/follow-ups (+125, bug de recordatorio a cita ATENDIDA corregido) · #29 UX/conversión web (11 commits tras revisión: .ics RFC 5545, radiogroup, pasos, /gracias, CTA WhatsApp, precio unificado) · #33 smoke E2E Playwright 1.63 + job `e2e` en CI + `scripts/e2e-local.sh` con `docker-compose.e2e.yml`.
- **Sprint 3 en PRs**: #31 `publicWhatsappPhone` opt-in (migración, campo en Ajustes, 744 tests, security-auditor OK) · #34 leads en móvil, chart por tokens, `/privacidad` y `/terminos` (borrador para revisión legal), sitemap/robots/JSON-LD · #32 README, SPEC y PRD al día, `.claude/worktrees/` ignorado, `bootstrap-super.js` con contraseñas por env.
- **Producción**: bootstrap del SUPERADMIN ejecutado con contraseñas fuertes (fuera del repo, `~/.config/showly/bootstrap-creds.env`). El login funciona en cuanto se despliegue `main` con #30 y #35.
- **Orden de merge** (las ramas están rebaseadas en cadena, sin conflictos si se respeta): #35 → #36 → #33 → #31 → #34 → #32. Luego redeploy en Coolify y cargar `NEXT_PUBLIC_WHATSAPP_SALES`, `NEXT_PUBLIC_PLAUSIBLE_DOMAIN` y `NEXT_PUBLIC_WEB_URL` cuando existan los valores.
- **Pendiente de decisión**: s0-3 borrados locales sin commitear · s3-1 wizard de onboarding (rama `feature/onboarding-wizard`) · s3-4 prueba social real · s3-8 pasada final de security-auditor y GO formal · el `express@5` sin uso · deuda de reminders (`CONFIRMED`/`FAILED` sin uso, follow-up sin Conversation, fila `Reminder` sin `jobId` si Redis falla).

## 2026-09-09 — Sprint 1: P1 de seguridad de la auditoría (rama `fix/sprint-1-p1-seguridad`)
- 6 commits atómicos, cada uno con test: clínica no ACTIVE → 404 en `/public/clinics/:slug/*` · secretos del webhook en el fail-fast de prod (`common/env.util.ts`) · WAHA no loguea el body de error (PHI) · `normalizeE164` único para webhook/público/panel/leads · `bufferMin` de las citas ocupadas en disponibilidad · dedup de eventos WAHA por `payload.id` en Redis. Ver [[notas/2026-09-09-formato-phone-e164-y-dedup-webhook]].
- **Decisión**: formato canónico de `phone` = E.164 con `+`. Sin migración de datos; pacientes viejos del bot (sin `+`) quedan como deuda de merge.
- **Segunda pasada (revisión security-auditor + code-reviewer)**: buffer simétrico + tenant check en disponibilidad · dedup con clave hasheada y rollback si el bot falla · webhook ignora `message` de clínicas no ACTIVE · fortaleza de secretos del webhook · migración Prisma idempotente de `phone` (verificada en Postgres descartable) · consent de IA de terceros en form/panel/greeting del bot (ADR 0004 §7) · JWT de impersonation re-valida `Clinic.status` (`ClinicStatusCache`, Redis TTL 60 s). Estado de los P1 en [[auditoria/RESUMEN-finalizacion]] §3 "Estado al 2026-09-09".

## 2026-09-09 — Sprint 0: CI verde + primer deploy en Coolify (PR #24)
- **Contexto**: radiografía completa del proyecto (hecho / funciona / falta) y plan de 4 sprints. `main` no pasaba el job web de CI: `AgendaLive.tsx` (sin importar en ningún lado) usaba 7 claves `landing.agendaLive.*` inexistentes. Tests backend 560/560. Ver [[deploy-coolify]] para la infra.
- **Coolify**: creado proyecto `showly` + app docker compose desde el repo público (rama `main`, `docker-compose.coolify.yml`) en la instancia del VPS. Dominios temporales sslip.io porque `showly.us` apunta a otro servidor. Secretos generados fuera del repo; keys de LLM/Resend/Axiom/Sentry pendientes.
- **Deploys**: 1) falló en `pnpm build` del web por AgendaLive. 2) pasó el build, `db` unhealthy: Coolify escribía `POSTGRES_USER='showly'` con comillas por `is_literal=true`. 3) db/redis/waha sanos, backend en crash-loop: `@InjectPinoLogger(HealthController.name)` sin provider (introducido el 03-09, nunca desplegado). 4) con el fix de health.
- **Commits en `fix/sprint-0-ci-verde`**: claves agendaLive es/pt + label tipado · `WEB_BASE_URL` en compose prod/coolify (faltaba, los links del bot caían a localhost) · `next build` en el job web de CI · fix del logger en HealthController · `docs/deploy-coolify.md`.
- **Regla nueva**: nunca `@InjectPinoLogger(Nombre)`; siempre `@InjectPinoLogger()` + `setContext` en el ctor (patrón de AuthController). Candidato sprint 2: test de bootstrap del `AppModule` que habría atrapado esto.
- **Pendiente**: mergear PR #24 y volver la app de Coolify a `main`; decidir los borrados locales sin commitear (`.codex`, `.obsidian`, `orchestrator/`, `specs/`, `tasks.json`, `scripts/task-*.sh`); cargar keys reales; actualizar `.coolify` con los uuids nuevos.

## 2026-08-10 — Feedback post-atención (satisfacción) — PR #15
- Sistema end-to-end para medir satisfacción por WhatsApp cuando una cita pasa a ATENDIDA. Ver [[adr/0012-feedback-post-atencion|ADR 0012]] para el "por qué" completo.
- **Schema**: `Professional.followUpEnabled` (default `false`) + `followUpDelayHours` (default `2h`, rango 0-168), y nuevo modelo `Feedback` (score 1-5, `comment?`, unique en `appointmentId`).
- **Backend `FollowUpsModule`**: Queue BullMQ separada de reminders (mismo Redis). `scheduleForAppointment` se dispara desde `AppointmentsController` en `case ATENDIDA` con fail-open. Processor manda prompt "1-5" y deja `Conversation.flowStep=AWAITING_NPS_SCORE`.
- **Sub-FSM del bot**: `AWAITING_NPS_SCORE` parsea dígito o palabra (`uno`…`cinco`). Guarda el `Feedback`, avanza a `AWAITING_NPS_COMMENT` (texto libre max 1000 chars o "no"/"nada"/"listo" para cerrar). Idempotente por unique — 2da respuesta se ignora silenciosamente pero se agradece.
- **Backend `FeedbackController`**: `GET /api/feedback` (lista, filtro por `professionalId`, cap 200), `GET /api/feedback/summary` (count, avg, distribución 1-5, ranking por profesional). Multi-tenant estricto vía `tenantWhere` (el modelo tiene `clinicId` propio).
- **Frontend**: sección "Follow-up post-atención" en `panel/profesionales` (toggle + input horas + hint), y nueva página `panel/feedback` con stat cards (total, promedio, % 4-5★, top prof), distribución 5→1, ranking por profesional, lista de últimas respuestas con estrellas + comment. Entry "Feedback"/"Satisfação" en el nav (sección "Operación").
- **i18n** es/pt paridad OK: `panel.feedback.*`, `panel.professionals.followUp.*`, `panel.nav.feedback`.
- **Decisión clave**: escala **1-5 en vez de NPS 0-10** — cabe en un mensaje corto, intuitivo en voseo, y para volumen bajo por tenant NPS es overkill. En código `Feedback` (neutro); en UI "satisfacción/experiencia".
- **Delay = 2h default** (consensuado): fresca la experiencia, pero el paciente ya salió. Rango 0-168h configurable por profesional (0 útil para dev).
- **Tests**: 337/337 backend siguen pasando. Actualicé mocks de `AppointmentsController` (DI de `FollowUpsService`) y `BotService` (idem + `recordFeedback`).

## 2026-08-10 — CI + observability básica (plan B — punto 3/4)
- Sin CI antes de esto — los checks corrían solo en local del dev. Los bugs de i18n post-merge (3× en la sesión) confirmaron la necesidad. Este PR mueve TODOS los quality gates a CI automatizado.
- **`.github/workflows/ci.yml`** con 2 jobs paralelos (`backend` + `web`):
  - `backend`: `pnpm install --frozen-lockfile` → `prisma generate` → `tsc --noEmit` → `jest`.
  - `web`: `pnpm install --frozen-lockfile` → `tsc --noEmit` → `node scripts/i18n-check.mjs`.
  - Corre en `pull_request` y `push` contra `staged` y `main`.
  - `concurrency: cancel-in-progress` — ahorra minutos si se pushea de nuevo al mismo PR.
  - Cache de pnpm via `pnpm/action-setup@v4` + `actions/setup-node@v4 with cache: pnpm`.
- **`scripts/i18n-check.mjs`** — script node standalone (cero deps) que reemplaza el `diff <(jq)` bash + los scripts adhoc que estaba usando entre commits. Chequea:
  1. **Paridad estricta** de paths escalares `es.json` (source) ↔ `pt.json` (y cualquier locale nuevo que aparezca). Reporta paths faltantes/sobrantes con contexto.
  2. **Missing keys por consumidor** — para cada `.tsx` que usa `useTranslations('namespace')`, verifica que cada `t('key')` / `t.rich('key')` matchee un path del source.
  3. Salida con colores ANSI, exit 0/1/2 semánticos (OK / validation error / config error).
- **Scripts npm root nuevos** — reproducen exactamente lo que corre CI:
  - `pnpm check` — todo (backend + web + i18n).
  - `pnpm check:backend` / `pnpm check:web` / `pnpm i18n:check` — granulares.
  - Renombré de `ci` a `check` porque `pnpm ci` es un comando reservado (ERR_PNPM_CI_NOT_IMPLEMENTED).
- **Docs de deploy** (`docs/deploy.md`):
  - Sección 11 (Monitoring): documenta el `GET /api/health` que ya existía (`{ ok, db, redis, timestamp }`). Se marca "listo" el item de deuda de la sección 15.
  - Nueva sección 16 (Quality gates): describe qué chequea CI + comandos locales equivalentes.
- **Observability**: el health endpoint ya existía (verificado — `apps/backend/src/health/`) con chequeos reales de DB (Prisma `SELECT 1`) y Redis (`PING`). El `Logger` de NestJS ya emite structured logs. Sentry queda documentado como opcional/follow-up — el MVP no lo necesita.
- **Cero cambios de código de app** — solo infra (workflow YAML + script node + docs + package.json scripts). No toca ningún cliente, endpoint ni schema.
- Deuda:
  - GitHub Branch Protection "require status checks to pass" en `staged`/`main` — setup manual en Settings (fuera del alcance del código del repo).
  - Cuando actualicemos next-intl a v4+ (usa `AppConfig` en vez de `IntlMessages`), el chequeo i18n sigue funcionando igual (parseo estructural).
- Archivos tocados: `.github/workflows/ci.yml` (nuevo), `scripts/i18n-check.mjs` (nuevo), `package.json`, `docs/deploy.md`.

## 2026-08-10 — Pacientes con historial (primer consumidor del MasterDetailShell)
- Gap cerrado: el modelo `Patient` existía como referencia en `Appointment` y `Conversation` pero no tenía página propia. El operador no podía ver "quiénes son los pacientes de la clínica" ni consolidar su historial. Nueva ruta `/panel/pacientes` con master-detail.
- **Primer consumidor del `<MasterDetailShell>` post-refactor** — validación práctica del componente extraído en el PR #12. El shell escaló bien: cero cambios necesarios, se usa con las props documentadas (`mobileSheetMaxWidth="sm:max-w-lg"` para dar más espacio al detail de 3 secciones).
- Backend:
  - Nuevo `PatientsModule` con `PatientsController` (`GET /`, `GET /:id`, `GET /:id/history`, `PATCH /:id`).
  - `list` con búsqueda case-insensitive server-side (`contains + mode: insensitive` en Postgres via Prisma) por `name` y `phone`. Paginación con `limit`/`offset`. `_count.appointments` inline para el badge sin N+1.
  - `history` devuelve últimas 50 citas ordenadas desc + conversación ligada (uno-a-uno, tomamos la más reciente si hay varias). Excluye `notes` de citas por PII hygiene.
  - `update` sólo acepta `name` y `consent`. **Consent es ratchet legal** — solo se puede prender (false→true). Enviar `consent: false` con estado actual `true` se ignora silenciosamente para no perder evidencia LGPD/GDPR. Body vacío → no-op (evita UPDATE innecesario + `updatedAt` bump).
  - Sin `POST /` — pacientes nacen automáticamente al crear cita o desde el bot. "Nuevo paciente manual" es baja prioridad.
  - Sin cambios de schema.
  - **15 tests nuevos** cubriendo list (sin q, con q, trim, limit/offset, aplana _count), findOne (happy + cross-tenant), history (404 + happy + short-circuit sin patient + conversation null), update (name, ratchet true→false ignorado, ratchet false→true, cross-tenant, body vacío). **337/337 verdes** en full suite.
- Frontend:
  - `PatientsClient` con `<MasterDetailShell>`. Búsqueda **server-side** (a diferencia de servicios/profesionales que filtran client-side) — pacientes pueden ser miles, cargar todos y filtrar en memoria escala mal. La `q` va en la query key para cachear por búsqueda.
  - Row con avatar circular (iniciales del nombre o últimas 2 cifras del phone), meta con teléfono formateado (mismo `formatPhone` que conversaciones — cubre AR y BR) y contador de citas + badge verde de "Consent OK" cuando corresponde.
  - Detail con 3 secciones:
    1. **Identidad** — name editable, phone readonly con botón "Abrir en WhatsApp" (deep link `wa.me`), checkbox de consent (disabled si ya está en true — ratchet visual).
    2. **Historial de citas** — timeline con chip de fecha (día + mes) tipo agenda, badge de status con color, servicio + profesional. Slice a 10 con "y N más" si hay más.
    3. **Conversación** — link a `/panel/conversaciones?open={id}` con el último mensaje + estado como preview.
  - Empty state SVG específico: silueta persona + 3 líneas al costado (evocando "ficha con historial") + sparkle amber.
- Nav: entrada nueva "Pacientes" en la sección "Operación" con icono `UserRound`.
- i18n: bloque `panel.patients` completo (~40 keys) + `panel.nav.patients` en es/pt. Paridad estricta validada con `diff <(jq)`. Missing keys scan corrido antes del commit.
- Deuda:
  - No hay UI para crear paciente manualmente → sigue naciendo del bot/cita.
  - No hay merge de duplicados (mismo paciente con 2 phones) — flow separado con auditoría cuando aparezca la necesidad.
  - No hay campos nuevos (birthdate, email, notes internas) — se agregan cuando la clínica los pida específicamente.
- Archivos tocados: `apps/backend/src/patients/{patients.controller,patients.module,dto/{list-patients,update-patient}}.ts` (nuevos), `apps/backend/src/app.module.ts`, `apps/backend/src/patients/patients.controller.spec.ts` (nuevo), `apps/web/src/app/[locale]/panel/pacientes/{page,PatientsClient}.tsx` (nuevos), `apps/web/src/app/[locale]/panel/PanelShell.tsx`, `apps/web/src/lib/query-keys.ts`, `apps/web/messages/{es,pt}.json`.

## 2026-08-10 — Refactor: extract MasterDetailShell + useMobileSheet
- Cierre del rollout master-detail: extracción de los helpers compartidos que estaban duplicados en los 5 clientes CRUD del panel (servicios, profesionales, horarios, bloqueos, faq).
- Nuevo módulo `apps/web/src/components/panel/master-detail/`:
  - **`MasterDetailShell`** — layout split card + Sheet drawer mobile. Props: `sidebar`, `panel`, `mobile`, `mobileTitle`, `hidePanelInSheet`, `mobileSheetMaxWidth` (default `sm:max-w-md`; FAQ overrides a `sm:max-w-2xl` por el markdown editor), `headerSlot` (para el banner "sin embedding" de FAQ arriba del card).
  - **`useMobileSheet()`** hook — encapsula el guard con `matchMedia('(max-width: 767.98px)')` que evita el bug de Radix (overlay del portal renderizando en desktop aunque el content tenga `md:hidden`). Devuelve `{ isOpen, openIfMobile, close, onOpenChange }`.
  - **`EmptyStatePanel`** y **`MasterDetailRow`** — disponibles pero no adoptados en los clientes existentes (el chrome duplicado es chico y el contenido interno de los rows es muy variado). Quedan para futuros consumidores o refactor quirúrgico si aparece un tweak común.
- Cambio en los 5 clientes: se reemplaza el JSX del shell (~40 líneas c/u de `<div><aside><section>` + `<Sheet>`) por `<MasterDetailShell>`. Se reemplazan `useState<boolean> + isMobileViewport()` (~10 líneas c/u) por `useMobileSheet()`. Total: **460 líneas removidas, 340 agregadas** (los helpers cuentan en las agregadas — neto ~120 menos de código duplicado, y todo el nuevo código vive en un solo lugar).
- **Cero cambios de comportamiento** — mismo lenguaje visual, mismo behavior, mismo a11y. Verificado con typecheck limpio en toda la app web.
- Archivos tocados: `apps/web/src/components/panel/master-detail/{MasterDetailShell,MasterDetailRow,EmptyStatePanel,useMobileSheet,index}.{tsx,ts}` (nuevos), y los 5 clientes CRUD.
## 2026-08-10 — Type-safe next-intl (previene MISSING_MESSAGE + FORMATTING_ERROR)
- Motivación concreta: 3 bugs post-merge del mismo patrón en esta sesión — MISSING_MESSAGE por keys inexistentes (`panel.conversations.live`, `panel.timeOff.empty.cta`, `roles.CLINIC_ADMIN`) + FORMATTING_ERROR por variables ICU no pasadas (`hints.botGreeting` con `{clinicName}` literal). El scan bash con `jq` atrapaba las primeras pero NO las segundas — TypeScript atrapa ambas de un saque.
- Setup: `apps/web/global.d.ts` con `interface IntlMessages extends typeof esMessages`. next-intl v3 lee esa declaración automáticamente vía module augmentation. `es.json` es la source of truth (paridad estricta con `pt.json` sigue validándose con `diff <(jq)`).
- **Un error real atrapado apenas se activó el chequeo**: `WhatsappConnectionClient.tsx:243` tenía `t(\`status.${statusKey}\`)` donde `statusKey` era `string` genérico (perdió el narrowing por venir de `Set.has`). TypeScript no podía verificar que la key era válida. Fix: `KNOWN_STATUSES` pasa de `Set<string>` a `readonly array as const` + tipo `KnownStatus` derivado; se mantiene un `KNOWN_STATUS_SET` interno para el chequeo O(1). Ahora `t(\`status.${statusKey}\`)` compila con la union completa.
- Smoke test verificado: escribir `t('nonexistent.key')` da error TS. Escribir `t('countLabel')` (que requiere `{ n }`) sin pasar la variable también da error. Los `@ts-expect-error` pasaron limpios.
- **Cero cambios de behavior** — solo agrega chequeo estático. Todo el i18n existente sigue funcionando idéntico.
- Deuda: migrar a next-intl v4+ cuando salga estable — usa `AppConfig` interface en vez de `IntlMessages`, más clean. Follow-up documentado.
- Archivos tocados: `apps/web/global.d.ts` (nuevo), `apps/web/src/app/[locale]/panel/config/whatsapp/WhatsappConnectionClient.tsx`.

## 2026-08-10 — Ajustes: consolidar WhatsApp como tab + URL query sync
- Follow-up al PR de Ajustes: WhatsApp deja de ser página separada (`/panel/config/whatsapp`) y se consolida como el **4to tab** dentro de `/panel/ajustes`. "Todo lo que es configurar la clínica" queda en un solo lugar.
- Cambios:
  - `AjustesClient`: cambio de `useState<TabKey>` a URL query `?tab=general|reminders|bot|whatsapp` con `useSearchParams` + `router.replace({scroll: false})`. Bonus: deep-linkeable + el redirect del wrapper aterriza en el tab correcto.
  - Nuevo componente `WhatsappTab` que envuelve el `WhatsappConnectionClient` existente con el mismo `FormHeader` (consistencia visual con los otros tabs). **Cero cambios** al componente WhatsApp — se importa y renderiza tal cual, con toda su lógica de polling QR, mutations, connection status.
  - `ajustes/page.tsx`: fetch en paralelo del `/api/clinics/me` + `/api/clinics/me/waha/status` para hidratar el tab WhatsApp sin flash de loading.
  - `config/whatsapp/page.tsx`: **redirect server-side** con `redirect()` de Next → `/{locale}/panel/ajustes?tab=whatsapp`. Zero JS ejecutado. No rompe bookmarks del piloto.
  - `PanelShell`: entrada "WhatsApp" removida del nav (queda solo "Ajustes"). Import de `MessageCircle` limpiado.
  - i18n: `settings.tabs.whatsapp` + `settings.whatsapp.{title,description}` en es/pt.
- El `key={tab}` en el JSX ya remonta cada tab component al cambiar — para WhatsApp esto asegura que el polling arranca desde cero al entrar y se limpia al salir (unmount natural).
- Verificado: typecheck limpio, paridad i18n estricta, missing keys scan sin hits.
- Deuda: la carpeta `config/whatsapp/WhatsappConnectionClient.tsx` sigue ahí — hoy importada desde `/ajustes`. Podría moverse a un lugar más neutral (`components/settings/` o similar) cuando aparezca el 2do consumidor. Por ahora, mantener el archivo donde vive evita un rename ruidoso.

## 2026-08-10 — Página de Ajustes: General + Recordatorios + Bot personalizable
- Nueva ruta `/panel/ajustes` — la clínica finalmente puede editar sus settings sin necesitar tocar la DB. Cierra un gap del panel: el schema de `Clinic` ya tenía `timezone`, `locale`, `reminderOffsetsH`, `confirmThresholdH`, `autoConfirm` pero eran solo settable via seed/psql.
- **Nuevo también:** el bot deja de tener respuestas hardcodeadas. La clínica personaliza greeting, fallback y handoff con placeholders (`{clinicName}`, `{patientName}`), y elige un tono (cercano/formal/técnico) que se inyecta al system prompt del LLM.
- Schema: nuevos campos opcionales en `Clinic` — `botGreeting`, `botFallback`, `botHandoffMsg`, `botTone`. Migration sin backfill (NULLs → BotService cae a defaults hardcodeados). Sin cambios breaking para clínicas existentes.
- Backend:
  - **Nuevo `PATCH /api/clinics/me`** con `UpdateClinicDto` estricto. NO acepta `slug`/`wahaSession`/`wahaConnected` (cambios peligrosos — se hacen por CLI). Validación custom de timezone con `Intl.DateTimeFormat`. Log de auditoría específico para cambios de TZ (afectan citas futuras).
  - **`BotService.resolveBotMessage(clinic, key, ctx?)`** helper con defaults + placeholders. Cambio: los 4 hardcodes de mensajes (2× handoff explícito, 1× handoff post-RAG, 1× fallback) ahora pasan por este helper.
  - **Nuevo trigger de greeting**: `GREETING_REGEX` (hola/holis/buenas/buenos días/etc.) dispara antes del intent LLM. Cero costo LLM, respuesta inmediata con `botGreeting`.
  - **`KnowledgeService.answer`** acepta `tone?` opcional. Inyecta al system prompt del RAG una instrucción de estilo (cercano/formal/técnico) sin tocar la fuente de verdad (las fuentes FAQ).
- Frontend:
  - Layout con **sub-tabs verticales** (sidebar izq 224px + card der con el form activo). Mobile: tabs horizontal scroll arriba del card.
  - **3 tabs independientes** — cada uno con su propio `useForm` + submit + `isDirty` check. Cambiar de tab con datos sin guardar NO los pierde (isDirty por form). El `key` en el JSX remonta el form al cambiar de tab.
  - **General**: name, address, timezone (select con 12 zonas comunes + "personalizada" con input libre), locale, autoConfirm (toggle).
  - **Recordatorios**: chips agregables/removibles (max 5, entre 1h y 168h) con validación cliente (rango, duplicados, cap). Threshold EN_RIESGO como input numérico.
  - **Bot**: 4 textareas (greeting/fallback/handoff) + select de tono. Panel de ayuda con los placeholders soportados (formateados con `code`). Placeholders visibles en los `placeholder=` de los inputs para que el operador vea cómo se usan.
  - Warning ámbar inline cuando cambia el timezone (afecta cómo se ven citas futuras).
- Tests: 322/322 verdes (5 nuevos en `bot.service.spec.ts` cubriendo `resolveBotMessage`: default fallback, custom pisando default, `{clinicName}` replace, `{patientName}` con y sin ctx, greeting dispara antes de intent).
- Deuda documentada:
  - No hay upload de logo/avatar de la clínica → follow-up cuando tengamos infra R2/S3.
  - **Branding avanzado** (color primario custom por tenant) requiere CSS variables per-tenant en el layout root — Fase 2.
  - Notificaciones al operador (email cuando NEEDS_HUMAN) → Fase 2.
  - Auto-respuesta fuera de horario → Fase 2, o simplemente usar `botGreeting` condicional en el bot.
- Missing keys scan corrido ANTES del commit (lección de PRs pasados). Cero MISSING_MESSAGE.
- Archivos tocados: `apps/backend/prisma/schema.prisma`, migration nueva `20260810162518_clinic_bot_settings`, `apps/backend/src/clinics/{clinics.controller,dto/update-clinic.dto}.ts`, `apps/backend/src/bot/{bot.service,bot.service.spec}.ts`, `apps/backend/src/knowledge/knowledge.service.ts`, `apps/web/src/app/[locale]/panel/{PanelShell.tsx,ajustes/{page,AjustesClient}.tsx}`, `apps/web/src/lib/query-keys.ts`, `apps/web/messages/{es,pt}.json`.

## 2026-08-10 — FAQ / Base de conocimiento: master-detail
- 5to y último CRUD del panel migrado al patrón master-detail (después de servicios, profesionales, horarios, bloqueos).
- **Contexto:** FAQ ya tenía un split view viejo (grid 30/70), pero con estilo pre-tokens (`bg-white`, `text-gray-*`, `max-w-5xl`) y mobile via `hidden`/`block` en lugar de Sheet drawer. Además faltaban features UX importantes: sin search, sin filtro por "solo sin indexar", empty state genérico.
- **Preservado:**
  - `MarkdownEditor` component (`@/components/ui/markdown-editor`).
  - Banner amarillo "sin embedding" (bug fix P0 previo — `docs/ux/2026-08-09-faq-embedding-banner.md`).
  - Badges "Indexada" / "Sin indexar" con AA color contrast.
  - Schema Zod estricto (title max 200, content 5-4000).
  - Vector `embedding` NUNCA viaja al cliente — el flag `hasEmbedding` se deriva server-side.
- **Nuevo:**
  - Layout full-height card + toolbar + list + panel, alineado con el resto del panel.
  - **Búsqueda cliente-side** por title + content strippeado (usa `stripMarkdown` local para matchear texto plano sin ruido de sintaxis MD).
  - **Toggle "Solo sin indexar"** — visible solo cuando hay al menos una. Útil tras subir `OPENAI_API_KEY` para batch fixing (encontrar las que quedaron sin embedding).
  - Row activo con marker vertical brand (mismo lenguaje que conversaciones).
  - Empty state SVG específico: libro abierto con líneas de texto + 2 sparkles.
  - Mobile Sheet drawer con guard `matchMedia` (evita backdrop en desktop — el bug que aprendimos en servicios).
  - Row más compacto: título + badge inline + excerpt de 2 líneas + fecha corta (día + mes).
  - Botón "Volver" con `ArrowLeft` en el header, solo visible en mobile (`md:hidden`).
- **Lección aplicada:** verifiqué el missing keys scan **antes** del commit (no después como en los PRs anteriores). Cero MISSING_MESSAGE.
- **Cero cambios de contrato:** endpoints `/api/faq` (GET/POST/PATCH/DELETE) y shape del `FaqChunk` idénticos.
- i18n: se renombró `panel.faq.empty` (era string) a `emptyList` para liberar `empty.{title,description,cta}` como objeto del panel derecho. ~10 keys nuevas (`newSubtitle`, `close`, `createFirst`, `listAriaLabel`, `onlyPending` con ICU, `countLabel`/`countMatch`, `noSearchResults`, `searchPlaceholder`, `empty.{title,description,cta}`). Paridad estricta es/pt validada con `diff <(jq)`.
- **Deuda estable:** el patrón master-detail ya vive en **5 clientes** (servicios, profesionales, horarios, bloqueos, faq). Momento óptimo para extraer `<MasterDetailShell>` + `useMobileSheet()` hook + `<EmptyStatePanel>` — en un PR separado de refactor puro (cero cambios de comportamiento).
- Archivos tocados: `apps/web/src/app/[locale]/panel/faq/{page,FaqClient}.tsx`, `apps/web/messages/{es,pt}.json`.

## 2026-08-10 — Horarios y Bloqueos: master-detail (cierre del patrón CRUD del panel)
- Última migración del patrón master-detail: `/panel/horarios` y `/panel/bloqueos`. Cierra el rollout iniciado en servicios (PR #6) y continuado en profesionales (PR #7). Ahora los 4 CRUDs del panel comparten lenguaje visual: agenda, conversaciones, servicios, profesionales, horarios y bloqueos.
- **Bloqueos (TimeOff)** — master-detail directo, mismo patrón que servicios/profesionales. Diferenciales:
  - **Agrupamiento temporal:** rows separadas en "Próximos y activos" (asc por fecha) y "Pasados" (desc). Los pasados con opacity-70 para no confundirse.
  - **Chip de fecha visual** al inicio del row (día + mes chico, tipo agenda de escritorio) — comunica el "cuándo" antes que el "qué".
  - Row muestra hora inicio→fin si es mismo día, o rango de días si abarca varios.
  - Búsqueda cliente-side por reason, nombre del profesional, o fecha formateada (permite buscar "15 mar" o "vacaciones" o "Ríos").
  - Empty state SVG: calendario con X amber (bloqueo).
- **Horarios (BusinessHour)** — master-detail con **agrupamiento visual por día de la semana**. Decisión de diseño: `BusinessHour` es matricial (7 días × N profesionales); una lista plana no comunica bien. Alternativa considerada y descartada: grilla semanal completa tipo Google Calendar (scope enorme, valor solo en setup inicial).
  - Sticky headers por weekday (Lun/Mar/.../Dom) con contador de rows en la esquina.
  - Orden semanal: L, M, X, J, V, S, D (weekday 1..6, 0 al final — más natural que el orden Prisma 0..6).
  - **Filtro en el toolbar:** "Todos los horarios" / "Solo horarios de la clínica" (sin professionalId) / lista de profesionales. Sin caja de búsqueda porque los horarios son datos estructurados (hora + día), no texto libre.
  - Cada row muestra `HH:mm – HH:mm` con `tabular-nums` grande + profesional debajo.
  - Empty state SVG: reloj con manecillas + sparkle.
  - Bonus en el form: "Duración: Xh Ym" preview que se actualiza en tiempo real cuando el usuario cambia startTime/endTime.
- Cambios de contrato: **cero**. Los endpoints (`GET/POST/PATCH/DELETE /api/business-hours` y `/api/time-off`) y sus DTOs quedan idénticos. Solo cambia el chrome.
- i18n: en ambos módulos se renombró `empty` (era string) a `emptyList` para liberar `empty.{title,description}` como objeto del panel derecho. ~35 keys nuevas por módulo (`countLabel`/`countMatch` ICU plural, `groups.upcoming/past`, `filters.*`, `hints.*`, `newSubtitle`, `close`, `optional`, `createFirst`, `durationHint`, `untitled` en TimeOff). Paridad estricta es/pt validada con `diff <(jq)`.
- Deuda documentada:
  - **Aún NO se extrajeron helpers compartidos** (el patrón master-detail vive duplicado en 4 clientes). Considerar `<MasterDetailShell>` + `useMobileSheet()` hook cuando aparezca el 5to consumidor o cuando queramos ajustar un detalle común y evitar 4 edits paralelos.
  - Horarios: no hay "duplicar horario" (típico: mismo horario L-V). Follow-up: acción "duplicar en otros días" en el header del form.
  - Bloqueos: no hay recurrencia (cada bloqueo es puntual). Follow-up si se necesitan feriados recurrentes tipo "Navidad todos los años".
- Archivos tocados: `apps/web/src/app/[locale]/panel/horarios/{page,BusinessHoursClient}.tsx`, `apps/web/src/app/[locale]/panel/bloqueos/{page,TimeOffClient}.tsx`, `apps/web/messages/{es,pt}.json`.

## 2026-08-10 — Profesionales: perfil ampliado + master-detail + iCal feed (ADR 0011)
- Reescritura de `/panel/profesionales` alineando con el patrón master-detail que ya se aplicó en servicios. Aparte, el modelo `Professional` estaba minimalista (solo `name + active`) — el usuario planteó que era insuficiente para la app mobile futura del profesional y para que puedan sincronizar sus turnos con el calendar del teléfono.
- Ver [[adr/0011-perfil-profesional-e-ical-feed]] para el análisis completo (por qué iCal feed en vez de Google OAuth, decisión del HMAC token, deuda documentada).
- Cambios de schema:
  - Migration `20260810115333_professional_profile_fields` agrega 7 campos opcionales a `Professional`: `email`, `phone`, `specialty`, `bio`, `avatarUrl`, `licenseNumber`, `color`. Todos NULL para profesionales existentes.
  - `@@unique([clinicId, email])` para prevenir doble alta.
  - `updatedAt @updatedAt` con default `now()` para tomar valor inicial en el ALTER sin fallar sobre rows existentes.
- Cambios backend:
  - Nuevo `ProfessionalProfileFieldsDto` compartido entre create y update via `extends`. Validaciones: `@IsEmail`, regex E.164 phone, `@IsUrl` para avatar, `@IsHexColor` para color, `@Transform` que normaliza strings vacíos a `undefined`.
  - Controller: helper `pickProfileFields` que filtra `undefined` (no pisa valores en patch parcial). Nuevo helper `throwIfEmailTaken` que traduce `P2002` a `409 Conflict` claro.
  - **Nuevo `IcalService`** (RFC 5545) — genera `.ics` con las citas activas del profesional en ventana [30d atrás, 90d adelante]. Excluye `CANCELADA`/`NO_SHOW`. Escape correcto de `,`, `;`, `\`, newlines. CRLF entre líneas. Mapea PENDIENTE/EN_RIESGO → TENTATIVE, CONFIRMADA/ATENDIDA → CONFIRMED.
  - **HMAC token** `HMAC-SHA256(professionalId, ICAL_SECRET)` truncado a 32 hex. Comparado con `timingSafeEqual`. Determinístico + revocable rotando `ICAL_SECRET`. Fail-fast en prod si no está seteado.
  - **Nuevo `ProfessionalsIcalController`** — `GET /ical/professionals/:id?token=X`. `@Public` (opt-out del JWT guard global). Fuera del prefijo `/api` (agregado a `main.ts` exclude, junto al webhook de WAHA). Content-Type: `text/calendar; charset=utf-8`.
  - `findOne` del controller de professionals ahora expone `icalUrl` pre-firmada en el response, para que el frontend pueda mostrar "Copiar URL" sin re-firmar.
  - Tests: 316/316 verdes (14 nuevos en `IcalService` cubriendo token determinismo/rotación, verify con timing-safe, feed vacío defensivo, VEVENT generation, exclusión de CANCELADA/NO_SHOW, mapeo de status, escape RFC 5545, tolerancia a Patient.name null, CRLF).
- Cambios frontend:
  - Rewrite de `ProfessionalsClient.tsx` con layout master-detail (~900 LOC). Lista izq con avatar circular (foto o iniciales sobre `color` propio o brand-500 fallback), specialty visible bajo el nombre, conteo de servicios.
  - Form con **5 secciones** (`FormSection` helper para consistencia visual): Identidad (name, email, phone), Perfil profesional (specialty, licenseNumber, bio), Servicios (checkboxes existentes), Visual (avatarUrl, color con color picker + input hex sincronizados), Calendar (solo edit — sync con iCal feed URL copiable + instrucciones iOS/Android).
  - `CalendarUrlCopy` component: fetch del detail on demand → construye URL absoluta (`window.location.origin + icalUrl`) → botón "Copiar" con feedback visual "Copiado ✓" 2 segundos.
  - Avatar preview en el header del form (foto o iniciales sobre color) — se actualiza en tiempo real mientras el operador escribe.
  - Sheet mobile con guard `matchMedia('(max-width: 767.98px)')` (mismo patrón que servicios para evitar backdrop en desktop).
- i18n: ~60 keys nuevas bajo `panel.professionals.{sections,fields,placeholders,hints,errors,calendarSync,empty}`. Renombramos `empty` (era string) a `emptyList` para liberar `empty.{title,description,cta}` como objeto del panel. Paridad estricta es/pt verificada con `diff <(jq)`.
- Deuda documentada (en ADR 0011):
  - `avatarUrl` es URL manual — upload propio queda para follow-up.
  - iCal es read-only — Google Calendar OAuth para bi-direccional queda para follow-up cuando aparezca demanda concreta.
  - No hay revocación por profesional individual — rotar `ICAL_SECRET` invalida TODAS las suscripciones.
  - Botón "Invitar a la app" (crear User linkeado con email del profesional) queda para PR siguiente.
- Archivos tocados: `apps/backend/prisma/schema.prisma`, migration nueva `20260810115333_professional_profile_fields`, `apps/backend/src/professionals/{professionals.controller,professionals.module}.ts`, `apps/backend/src/professionals/dto/{create,update}-professional.dto.ts` (+ nuevo `professional-profile-fields.dto.ts`), `apps/backend/src/professionals/{ical.service,ical.service.spec,professionals-ical.controller}.ts` (nuevos), `apps/backend/src/main.ts`, `apps/web/src/app/[locale]/panel/profesionales/{page,ProfessionalsClient}.tsx`, `apps/web/messages/{es,pt}.json`, `docs/adr/0011-perfil-profesional-e-ical-feed.md`.

## 2026-08-10 — Servicios: layout master-detail (prototipo del nuevo patrón CRUD)
- Reescritura completa de `/panel/servicios` — antes era DataTable full-width + Dialog modal (patrón shadcn genérico), ahora master-detail 2-col alineado con agenda/conversaciones. Ver [[notas]] siguientes:
  - **Diagnóstico**: la tabla tenía 4 columnas simples y ~5-15 filas por clínica típica → un DataTable con sorting + column-visibility era sobreingeniería. El form vivía en un dialog modal que tapaba la lista → contexto perdido al editar. Contra el resto del panel se veía "genérico".
- Layout nuevo:
  - Izquierda `w-[380px]`: search + CTA "Nuevo" + lista custom (no DataTable). Cada row muestra nombre grande + meta compacta (duración+buffer, precio) + chips de profesionales (max 3 visibles, "+N" resto). Row activo con marker vertical `bg-brand-600` + fondo `bg-brand-50` (mismo lenguaje que conversaciones).
  - Derecha `flex-1`: panel dual-state — empty con SVG inline (reloj estilizado + sparkles decorativos) + CTA cuando no hay selección; `ServiceForm` inline (no modal) con header sticky (título + botón eliminar + botón cerrar), body scrollable con 5 campos, footer sticky con Cancelar + Guardar. El botón "Guardar" queda disabled hasta que hay `isDirty` en modo edit.
  - Mobile `<md`: solo la lista full-width. Tap sobre row o CTA "Nuevo" abre `Sheet` desde la derecha con el mismo `ServiceForm` (respeta touch targets 44×44 del spec de mobile).
- Detalles de UX (skill `/frontend-design` — dirección "refined minimalism con carácter en los detalles"):
  - `ProfessionalChip` con inicial + color estable por hash djb2 modulado en paleta de 7 colores brand-safe (mismo nombre → mismo color siempre, sin librería).
  - Números en `tabular-nums` para duración/precio/count (jerarquía visual del "producto").
  - Empty state con SVG inline (120×120) — reloj + sparkles amber, no un ícono lucide sin contexto.
  - Icons contextuales en labels del form (`Clock`, `DollarSign`, `Users`) para acelerar el escaneo visual.
  - Transición de estados: sin animaciones dramáticas — todo con `transition-colors` estándar. El foco es la información, no el show.
- Comportamiento no obvio:
  - Al pasar de `edit A` → `edit B`, el `<ServiceForm>` remonta via `key={service.id}` para evitar defaults stale del `useForm`. Defensa extra con `useEffect(reset, [service?.id])`.
  - Tras crear un servicio, el panel queda en `edit` con el servicio recién creado (permite tweaks inmediatos). En mobile cerramos el sheet igual para que el user vea la lista actualizada.
  - Al eliminar el servicio activo desde el header del form, el panel vuelve a `empty` automáticamente (evita mostrar datos de un servicio inexistente).
  - Búsqueda cliente-side (nombre + nombres de profesionales) — no toca URL.
- Cambios de contrato: **cero**. La schema Zod, el endpoint API (`POST/PATCH/DELETE /api/services`), y el shape del `Service` quedan idénticos.
- i18n: renombrada `panel.services.empty` (era string) a `emptyList` para liberar `empty.{title,description,cta}` como objeto del estado vacío del panel derecho. Agregadas ~10 keys nuevas (`newSubtitle`, `close`, `noProfessionalsRow`, `noSearchResults`, `createFirst`, `countLabel` con ICU plural, `countMatch`, `selectedCount`, `placeholders.name`, `hints.buffer`). Paridad estricta es/pt verificada con `diff <(jq)`.
- Deuda / follow-ups:
  - Aplicar el mismo patrón a `/panel/profesionales`, `/panel/horarios`, `/panel/bloqueos` (los 3 son CRUDs con la misma forma). PRs separados, uno por página, para mantener revisiones acotadas.
  - Considerar sacar `ProfessionalChip` a `components/ui/` cuando aparezca el 2do consumidor (agenda o dashboard).
  - Sin cambios de backend — no hay tests nuevos. Verificación por typecheck + smoke manual.
- Archivos tocados: `apps/web/src/app/[locale]/panel/servicios/{page,ServicesClient}.tsx`, `apps/web/messages/{es,pt}.json`.

## 2026-08-10 — Agenda: agendar / reagendar / cancelar desde el panel
- Feature CRUD sobre `/panel/agenda`. Antes solo se podía "cambiar status" (que incluye CANCELADA) desde el detalle; ahora hay un flow completo con:
  - **Nueva cita**: botón "Nueva cita" en el toolbar → dialog con form (paciente name+phone, servicio, profesional, slot picker de 7 días, consent obligatorio). Los selectores cross-filtran entre sí (elegir profesional filtra servicios que atiende, y viceversa).
  - **Reagendar**: botón nuevo en el detalle, solo visible en estados vivos (PENDIENTE/CONFIRMADA/EN_RIESGO). Dialog con paciente/servicio/profesional readonly + slot picker filtrado al mismo combo. El slot actual de la cita no bloquea la reprogramación (nuevo param `excludeAppointmentId` en `AvailabilityService.getSlots`).
  - **Cancelar con confirmación**: los botones CANCELADA / NO_SHOW ahora abren un `ConfirmDialog` (destructive, con el nombre del paciente en el mensaje) en vez de disparar directo.
- Cambios backend:
  - **Nuevo endpoint** `PATCH /api/appointments/:id/reschedule` con FSM check (`assertReschedulable` — solo estados vivos), delegando a `SchedulingService.rescheduleAppointment`. Reprograma reminders vía `scheduleForAppointment` (idempotente: cancela viejos + agenda nuevos). Fail-open en reminders — no rollbackea la cita si la cola explota.
  - **Nuevo endpoint** `GET /api/appointments/slots?serviceId&professionalId&from&days&excludeAppointmentId` para alimentar el slot picker interno (era solo público antes vía `/api/public/clinics/:slug/availability`).
  - **Nuevo endpoint** `GET /api/clinics/me` (módulo `ClinicsModule` nuevo, mínimo) devolviendo `{ id, name, slug, timezone, locale }`. Consumido por la agenda para armar el picker en la TZ correcta.
  - `AvailabilityService.getSlots` acepta `excludeAppointmentId` opcional — evita que la propia cita se cuente como "ocupando su slot actual" al reagendar.
  - Tests: 302/302 verdes (14 nuevos: 8 en `SchedulingService.rescheduleAppointment` cubriendo happy + exclude + no-op idempotente + 404 + past + 409 slot + 409 race + BadRequest ISO + fail-open reminders; 6 en `AppointmentsController` cubriendo happy + status vivos + 422 terminales + 404 + slots endpoint + validación).
- Cambios frontend:
  - Nuevo componente `AppointmentDialog.tsx` (~500 LOC) con dos modos: `create` (form completo) y `reschedule` (paciente/servicio/profesional readonly + solo slot picker). Sin Luxon en el web — helpers Date/Intl vanilla para navegar por semanas del picker.
  - `AgendaClient` ahora acepta `services` + `timezone` como props (nuevos), renderiza el botón "Nueva cita" en el toolbar, agrega el botón "Reagendar" en el detalle (solo estados vivos) y envuelve CANCELADA/NO_SHOW en `ConfirmDialog`.
- i18n: 50+ keys nuevas bajo `panel.agenda.{dialog,confirmCancel,confirmNoShow,detail.reschedule,newAppointment}` en es y pt (paridad estricta validada con `diff <(jq)`).
- Deuda documentada:
  - No hay endpoint `GET /api/patients` — cuando se agende para un paciente ya existente, el operador tipea de nuevo el phone (el backend hace `upsert` por `[clinicId, phone]` — misma persona). Follow-up: autocomplete de paciente en el form de "Nueva cita".
  - `Cancelar` no permite capturar motivo (`reason` fue removido en M4 — ver ADR 0006 §Deuda). Se re-integra cuando exista tabla `AuditEvent`.
- Archivos tocados: `apps/backend/src/appointments/{appointments.controller,dto/reschedule-appointment.dto,appointment-status.util}.ts` (+ specs), `apps/backend/src/scheduling/{scheduling.service,availability.service}.ts` (+ specs), `apps/backend/src/clinics/{clinics.controller,clinics.module}.ts` (nuevos), `apps/backend/src/app.module.ts`, `apps/web/src/app/[locale]/panel/agenda/{page,AgendaClient,AppointmentDialog}.tsx`, `apps/web/messages/{es,pt}.json`.

## 2026-08-10 — WhatsApp LID + contact info en Conversation (ADR 0010)
- Detectado en el panel: un chat legítimo aparecía con "número" `+63556976398516` cuando el real era `+5541998819501`. Causa raíz: WhatsApp está migrando de `<phone>@c.us` a `<lid>@lid` (Linked ID por privacidad) y el webhook stripeaba solo `@c.us`, guardando el LID como si fuera phone. Verificado en DB (`chatId=63556976398516@lid`) y en logs de WAHA (`myPN`/`myLID` separados).
- Decisión: extender el modelo `Conversation` en vez de crear tabla `Customer`. Ver [[adr/0010-lid-y-contacto-whatsapp]].
- Cambios:
  - **Prisma**: `Conversation.phone` pasa a `String?`; nuevas columnas `lid`, `contactName`, `avatarUrl`, `avatarFetchedAt`, `patientId?` (FK a `Patient`). Migración incluye backfill que separa `phone LIKE '%@lid'` → columna `lid` (sin sufijo) y phone=null; también stripea legacy `@c.us`.
  - **WahaService**: `startSession` usa ahora `POST /api/sessions` con `config.noweb.store.enabled=true` (fullSync=false). Fallback al legacy `/api/sessions/start` con 409/422. Sesiones creadas antes de este cambio necesitan re-escaneo de QR para activar el store. Nuevo `getContactAvatar(session, chatId)` que consulta `/api/contacts/profile-picture` — funciona con `@c.us` y `@lid`.
  - **Webhook**: parsea `from` separando phone/lid según sufijo; extrae `notifyName` de top-level o `_data.pushName`. Log condicional `[LID]` en dev para observar campos alternativos de Baileys (`senderPn`, `remoteJidAlt`) sin ensuciar el ingest.
  - **Bot**: `handleIncoming` acepta `contactName + lid + phone|null`. Upsert respeta `contactName` existente si no vino nuevo. `refreshAvatar` en background con TTL 24h. FSM defensivo con `phone|null`: confirmaciones deterministas (sí/cancelar) y lookup de `Patient` se saltan si phone es null; `CONFIRM` aborta con mensaje pidiendo el número directo (TODO: agregar `ASK_PHONE` al FSM).
  - **Conversations controller**: `list`/`findOne` exponen los nuevos campos. `findOne` agrega `messageCount` — cierra el bug "NaN mensajes" en el header del chat.
  - **Panel (web)**: `displayName(conv)` prioriza `contactName` > phone formateado > "Contacto WhatsApp" (nunca renderiza el LID pelado). `ContactAvatar` acepta `avatarUrl` y cae a iniciales con `onError` cuando la URL de WhatsApp expira (~48h). Búsqueda incluye `contactName`. Botón "Abrir en WhatsApp" se esconde si `phone` es null.
- Verificaciones: 284/284 tests backend verdes (nuevos: happy path + fallback 409 de `startSession`, `getContactAvatar` con `@lid`, `getContactAvatar` degradando a null con WAHA caído). Typecheck limpio en web y backend. Backfill validado en DB.
- Deuda documentada: (1) `ASK_PHONE` en el FSM para completar agendamientos de contactos que llegaron con LID, (2) procedimiento de re-escaneo QR para activar el store en sesiones WAHA preexistentes, (3) refinamiento del parsing cuando se confirmen los campos alternativos que expone Baileys via el log `[LID]`.
- Archivos tocados: `apps/backend/prisma/schema.prisma`, migration nueva `20260810091156_conversation_contact_info`, `apps/backend/src/whatsapp/{waha.service,webhook.controller}.ts` (+ specs), `apps/backend/src/bot/bot.service.ts` (+ spec), `apps/backend/src/conversations/conversations.controller.ts`, `apps/web/src/app/[locale]/panel/conversaciones/ConversationsClient.tsx`, `docs/adr/0010-lid-y-contacto-whatsapp.md`.

## 2026-08-09 — FAQ banner "sin embedding" — fallo silencioso resuelto (spec P0)
- Ejecutado [[ux/2026-08-09-faq-embedding-banner]]: cerrado el fallo silencioso donde una FAQ cargada sin `OPENAI_API_KEY` quedaba en DB con `embedding=NULL`, el bot NO podía responderla (`KnowledgeService.retrieve` filtra por `embedding IS NOT NULL`), y el operador NO lo sabía porque el `FaqClient` no distinguía chunks indexados vs no indexados.
- Cambios:
  - **Backend** `apps/backend/src/faq/faq.controller.ts`: nuevo helper `selectFaqChunks(clinicId, {id?})` con `$queryRawUnsafe` que retorna `id, clinicId, content, createdAt, (embedding IS NOT NULL) AS hasEmbedding`. El vector `embedding` (1536 floats) NUNCA se carga a memoria ni sale del backend. Aplicado a `list()`, `findOne()`, `create()` (happy + fallback), `update()`.
  - **Backend tests** `faq.controller.spec.ts`: agregado bloque `vector embedding NUNCA se expone en la response` (6 sub-tests) + ajustes en tests existentes para mockear `$queryRawUnsafe` con guard-rail interno que tira si detecta `SELECT ... embedding` sin `IS NOT NULL`. Total 258 tests (antes 249).
  - **Frontend** `apps/web/src/app/[locale]/panel/faq/page.tsx`: shape con `hasEmbedding`, compute `pendingCount`, pasa a client.
  - **Frontend** `apps/web/src/app/[locale]/panel/faq/FaqClient.tsx`: banner amarillo `role="status"` con pluralización ICU cuando `pendingCount > 0`, y `Badge` "Indexada" (brand-100) / "Sin indexar" (amber-100) por row con `aria-label` descriptivo. Reutiliza tokens del design system (spec #28).
  - **i18n** `apps/web/messages/{es,pt}.json`: 5 keys nuevas bajo `panel.faq.*` (`indexed`, `notIndexed`, `notIndexedAriaLabel`, `notIndexedBanner` con plural ICU, `notIndexedHint`). Paridad de paths escalares verificada con `diff <(jq)`.
- Verificaciones: 258/258 tests backend verdes, `pnpm build` de web limpio (25/25 páginas), diff i18n = vacío.
- Deuda: el CLI `pnpm prisma:reindex-faq` sigue siendo la vía para reindexar chunks huérfanos (no se agregó botón "Reindexar" en el UI — fuera de scope explícito del spec).

## 2026-08-09 — Traducción pt-BR del panel y login (spec P0)
- Ejecutado [[ux/2026-08-09-pt-json-panel-en-espanol]]: traducido a português do Brasil todo el bloque `login.*` y `panel.*` de `apps/web/messages/pt.json` (unblock piloto pt-BR).
- Adaptaciones de tono clave (voseo Rioplatense → você imperativo):
  - "Iniciá sesión" → "Entrar" · "Ingresá" → "Digite/Entre" · "Elegí" → "Selecione/Escolha" · "Cerrar sesión" → "Sair" · "Tomá la conversación" → "Assuma a conversa"
  - Weekdays 0-6 → Domingo/Segunda/Terça/Quarta/Quinta/Sexta/Sábado.
  - Estados de cita mantienen keys en español (`PENDIENTE`, `EN_RIESGO`, `NO_SHOW`) pero valores en pt-BR (`Pendente`, `Em risco`, `No-show`).
  - "Cita" → "consulta" · "Bandeja" → "Caixa de entrada" · "Buffer" y "No-show" mantenidos como jerga técnica.
  - Precio en `services.hints.priceCents`: "Ej: 1500 = $15,00" → "Ex: 1500 = R$ 15,00" (adaptado a moneda BRL).
- Aprovechado el pase para traducir las 6 keys nuevas del spec #27 (ScheduleForm) que quedaban con `_TODO_pt_translation`: `emptyDescription`, `tryNextWeek`, `tryOtherProfessional`, `loadingSlotsAria`, `submit`, `submitting`. Eliminado el marcador `_TODO_pt_translation` para restaurar paridad estricta con `es.json`.
- Verificaciones: `diff` de paths escalares es.json vs pt.json = vacío (paridad exacta), `rg` de residuos Rioplatenses = 0, `pnpm --filter @agendazap/web build` verde (25/25 páginas), 249/249 tests backend verdes.
- Archivo tocado: `apps/web/messages/pt.json` (388 líneas). Cero cambios en TSX/TS.

## 2026-08-08 — Arranque del proyecto
- Definidos PRD, SPEC (Gherkin) y ARCHITECTURE.
- Modelo Prisma multi-tenant + motor de disponibilidad + motor de recordatorios anti no-show + WAHA + bot base.
- Decidido monorepo pnpm (backend/web/shared) + Flutter aparte → ver [[adr/0001-monorepo]].
- Añadida al alcance la página pública de agendamiento `/agendar/[clinicSlug]`.
- Configurado vault Obsidian + agentes (.claude/agents) + CLAUDE.md con regla de auto-alimentar el vault.
- Pendiente inmediato: wiring NestJS ejecutable.
- Plan del próximo incremento documentado en [[proximo-incremento]] (wiring NestJS → FSM agendamiento → página pública).

## 2026-08-08 (tarde) — Infra + Bloque 1 cerrados
- Levantada infra dev (db + redis + waha). WAHA con `platform: linux/amd64` sobre Apple Silicon.
- Prisma `migrate dev --name init` aplicada; `pgvector 0.8.6` activo. Ver [[notas/2026-08-08-prisma-pgvector-y-env]].
- `apps/backend/.env` → symlink a `.env` raíz. `DATABASE_URL` agregado a la raíz (apunta a `localhost:5432` para host; el compose ya override a `db:5432` en el container).
- **Bloque 1 del incremento cerrado**: wiring NestJS ejecutable. 10 archivos nuevos (tsconfig, nest-cli, prisma module+service, whatsapp/scheduling/reminders/bot modules, app.module, main). Backend arranca, worker BullMQ inicializa, `POST /webhooks/waha` responde `{ok:true}`, shutdown limpio. Ver [[notas/2026-08-08-bootstrap-nestjs-wiring]].
- Gotchas: `Queue` bullmq provisto por clase-token (no Symbol) mientras haya una sola cola. Webhook responde 201 (default `@Post` de Nest); si algún proxy exige 200, agregar `@HttpCode(200)`.
- Siguiente: Bloque 2 — extraer `SchedulingService.createAppointment()` compartido, e implementar FSM de agendamiento en el bot (`ASK_SERVICE → ASK_PROFESSIONAL → ASK_SLOT → CONFIRM`) usando `Conversation.flowStep`/`flowData`.
- Reorganización: PRD/SPEC/ARCHITECTURE movidos a `docs/`; la raíz queda con README + CLAUDE. Enlaces y wikilinks actualizados. Ver [[notas/2026-08-08-nextjs-vs-astro]] y decisión de convención en CLAUDE.md.
- Documentado el flujo de skills/agentes del proyecto en [[skills-y-flujo]].

## 2026-08-08 (noche) — Fixes post-review Bloque 1 + ajustes Bloque 2
- **A.1** `main.ts`: `worker.on('failed')` ahora usa `err?.message ?? 'unknown'` — BullMQ puede entregar `err` undefined en edges y crasheaba el logger.
- **A.2** `main.ts`: fail-fast en `NODE_ENV=production` si faltan `DATABASE_URL`, `REDIS_URL`, `WAHA_BASE_URL` o `WAHA_API_KEY`. En dev sigue con defaults.
- **A.3** `webhook.controller.ts`: `@Post('waha')` ahora fuerza `@HttpCode(200)` (default de Nest era 201). Convención de webhooks + menos reintentos raros de WAHA. Confirmado con `curl -w %{http_code}` → 200.
- **B.1 FSM**: nuevo paso `ASK_NAME` entre `ASK_SLOT` y `CONFIRM`. Se salta si `Patient.name` ya existe en DB (`clinicId_phone`). El nombre viaja como `flowData.patientName` y solo se pasa a `SchedulingService` si lo recolectamos → así el `upsert` respeta el nombre existente (nunca pisa). Mensaje de confirmación incluye el nombre.
- **B.2 FSM**: si `SchedulingService.createAppointment(...)` tira `ConflictException` en `CONFIRM`, ya NO reseteamos — re-listamos slots del mismo servicio+profesional y volvemos a `ASK_SLOT`. Si no quedan slots, ahí sí reset con mensaje amable ("no quedan horarios en los próximos 7 días"). Preservamos `serviceId`, `professionalId` y `patientName` en el `flowData`.
- **B.3**: verificado que `SchedulingService.createAppointment` NO incluye `professionalId` en el lookup de idempotencia BOT (línea 128 filtra solo por `clinicId + patientId + serviceId`). Ya estaba bien; no se tocó.
- Tests: 19/19 verdes (17 previos + 2 nuevos: skip ASK_NAME cuando el paciente ya tiene nombre, y re-listado tras conflicto vs. no-slots). Build limpio, arranque en frío OK, worker BullMQ ready, shutdown por SIGINT limpio.
- Gotcha: el mock de `patient.findUnique` en `bot.service.spec.ts` ahora determina si la FSM pasa por `ASK_NAME` — por default retorna `null` (paciente nuevo, pasa por `ASK_NAME`). Los tests que sólo validan `CONFIRM` mockean el paciente con nombre para saltar el paso.

## 2026-08-08 (noche cerrado) — Bloque 3: página pública + endpoint público
- **Backend**: nuevo módulo `apps/backend/src/public/` con `PublicController`, `RateLimit(N)` guard casero (Redis + `ioredis` reutilizado), DTO validado con class-validator + honeypot, `PublicModule` con conexión `Redis` singleton reusando `parseRedis()` de reminders.
- **Endpoints públicos** (sin JWT): `GET /api/public/clinics/:slug`, `GET /api/public/clinics/:slug/availability`, `POST /api/public/clinics/:slug/appointments`. Multi-tenant delegado a `SchedulingService`.
- **Rate-limit**: fixed window por `slug+ip` con bucket de 60s. POST 5/min, GET 30/min. Fail-open si Redis cae (loggeado a error). Cero PII en logs.
- **Frontend `apps/web/`**: scaffold Next.js 15 desde cero. App Router con `[locale]/agendar/[clinicSlug]/{page,ScheduleForm,not-found,gracias}`. Tailwind 3 + shadcn-style UI hand-rolled. next-intl v3 (es/pt). react-hook-form + zod con schema que refleja el DTO backend. Honeypot invisible con `sr-only`+`aria-hidden`+`tabIndex=-1`. Fechas formateadas con `Intl.DateTimeFormat` en TZ de la clínica.
- **Decisión no obvia**: rate-limit casero en vez de `@nestjs/throttler`. Ver [[adr/0003-rate-limit-casero-vs-throttler]].
- **Tests**: 39/39 verdes (19 previos + 20 nuevos entre DTO validation, controller y guard). Backend build limpio. Web build limpio (Next.js 15.5, 3 rutas dinámicas).
- **Smokes**: `GET /api/public/clinics/no-existe` → 404 ✓ · POST con DTO inválido → 400 ✓ · 6ta POST seguida → 429 con `Retry-After: 60` ✓.
- **Open**: falta seed de clínica demo para poder correr E2E completo desde el navegador. Ver [[notas/2026-08-08-bloque-3-pagina-publica]].

## 2026-08-08 (cierre) — Fixes code-review Bloque 2 + seed + smoke E2E Bloque 3
- **A.1 Cero `Date` naive**: 6 sitios productivos (`bot`, `scheduling`, `reminders.service`, `reminders.processor`) migrados a `DateTime.now().toJSDate()`. `rg 'new Date\(\)' apps/backend/src -g '!*.spec.ts'` limpio.
- **A.2 UX FSM del bot**:
  1. `reagendar/reprogramar` en CONFIRM ya NO cae al camino `no|cancelar` — re-lista slots con `reofferSlotsAfterConflict(...)`.
  2. Escape universal a humano: `humano|persona|operador|asesor|representante|attendant` o `"hablar con"` en cualquier paso → `NEEDS_HUMAN` + reset FSM + "Enseguida te atiende una persona del equipo. 🙏".
  3. Slot caducado en CONFIRM (`BadRequestException` con "pasado"): nuevo `reofferSlotsAfterExpired(...)` con mensaje "Ese horario ya pasó. Te muestro los que quedan libres:".
  4. `resolveChoice` requiere ≥3 chars para match por nombre — antes "a" resolvía a "Ana".
- **A.3 Tests**: 4 nuevos en `bot.service.spec.ts`. Total: **43/43 verde** (39 previos + 4 nuevos). Build limpio.
- **Bug encontrado + fixeado durante el smoke**: `RemindersService` usaba `jobId: 'reminder:<id>'` y `'risk:<id>'`. BullMQ 5.x prohíbe `:` en custom job IDs — todos los reminders quedaban con `jobId=NULL` y sin job en Redis. Fix: separador `-` en los 3 sitios.
- **Seed idempotente** (`apps/backend/prisma/seed.ts`): clínica `demo` (America/Caracas, es), servicios `Consulta general` y `Control`, profesionales `Dra. Ana Ríos` y `Dr. Luis Pérez` (ambos ↔ ambos servicios), BusinessHour mon-fri 9-18. `ts-node` agregado como devDep. Registrado en `package.json` como `prisma.seed`. Reejecutable sin duplicados.
- **Mensaje 409 orientado a paciente**: `PublicController` mapea `ConflictException` de scheduling a `"El horario elegido ya no está disponible. Elegí otro."` sin tocar `SchedulingService`.
- **Smoke E2E** (backend real + db + redis + BullMQ): C.1 GETs ✓ · C.2 POST 201 con appointment + 2 reminders SCHEDULED en DB + 3 keys BullMQ en Redis ✓ · C.4 doble reserva → 409 con mensaje user-facing ✓ · C.5 rate-limit 6ta request → 429 + `Retry-After: 60` ✓ · C.6 honeypot → 201 `{ok:true}` sin crear cita ✓.
- Documentación completa (IDs seed + comandos) en [[notas/2026-08-08-bloque-2y3-cierre-e2e]].

## 2026-08-08 (madrugada) — Blockers + nits del security-auditor Bloque 3
- **A.1** `rate-limit.guard.ts`: `extractIp()` extraído a función pura (exportable/testeable). Gate por `TRUST_PROXY === 'true'`; sin proxy confiable → `req.ip`; con proxy → primer valor del XFF, sanitizado a 45 chars, validado contra `^[0-9a-f:.]{1,45}$/i`, `'invalid'` si no matchea. 8 tests unitarios nuevos.
- **A.2** `main.ts`: CORS con whitelist explícita vía `CORS_ORIGINS` (CSV). En prod sin la env: `origin: false` (bloquea todo). Dev sin la env: `origin: true` (permite todo). `CORS_ORIGINS` sumada al fail-fast productivo. `credentials: false`, `maxAge: 600`, `methods: [GET, POST, OPTIONS]`.
- **A.3** `apps/web/package.json`: `next` bump de `^15.0.0` → `^15.4.0` (instalado 15.5.23). Build limpio, dev server renderiza `/es/agendar/demo` y `/es/agendar/demo/gracias` correctamente.
- **B.1** `helmet` agregado como dep del backend, activado en `main.ts` ANTES de `enableCors` (headers aplican también a preflight). Config default — no ajustamos CSP porque servimos JSON.
- **B.2** `apps/web/src/lib/api.ts`: `encodeURIComponent(slug)` en los 3 fetch (`fetchClinic`, `fetchAvailability`, `createAppointment`). Defensa en profundidad — el backend ya valida el slug con el nuevo pipe.
- **B.3** Nuevo `SlugValidationPipe` en `apps/backend/src/public/slug.pipe.ts` con regex `^[a-z0-9-]{1,50}$`. Aplicado con `@Param('slug', SlugValidationPipe)` en los 3 endpoints. Log SÓLO status=400 (nunca el valor). 6 tests unitarios nuevos. Smokes: `GET /demo` → 200; `GET /CON!MAYUS` → 400; `GET /CONMAYUS` → 400.
- **B.4 backend**: `PublicController.createAppointment` ya NO devuelve `patient.{name,phone}` en el response feliz. Shape confirmada por curl: `{id, startAt, endAt, status}`. Test del controller ajustado.
- **B.4 frontend**: `ScheduleForm` ya NO pone `name` en el query string del redirect a `/gracias`. Nuevo client component `ThanksName` lee `sessionStorage.getItem('agz.thanks.name')` y lo consume (`removeItem`). Guardamos sólo el primer nombre. `/gracias/page.tsx` server component ahora sólo pasa `date`/`time`.
- **ADR 0004** creado (`docs/adr/0004-pii-y-compliance.md`) — documenta los skips deliberados para MVP/piloto: `notes` sin cifrado at-rest, consent sin trazabilidad (IP+TS+versión texto), rate-limit sólo por `slug+ip` (falta capa global IP), sin Turnstile. Registrado en [[INDEX]].
- **Nuevas env vars** documentadas en la nota del Bloque 3: `TRUST_PROXY` (default false; setear a `"true"` sólo con proxy confiable delante) y `CORS_ORIGINS` (CSV, obligatorio en prod).
- **Tests**: **57/57 verdes** (43 previos + 14 nuevos: 8 de `extractIp`, 6 del pipe, ajuste del test del POST). Backend build limpio, web build limpio. `rg 'new Date\(\)' apps/backend/src -g '!*.spec.ts'` limpio.

## 2026-08-08 (bloque auth) — Bloque 5: `AuthModule` + JWT + guards + RBAC
- **AuthModule completo** en `apps/backend/src/auth/`: `AuthService` (login + `me`), `AuthController` (`POST /auth/login`, `GET /auth/me`, `GET /auth/admin-ping`), `JwtStrategy` (passport-jwt), `JwtAuthGuard` global (deny-by-default con `@Public()` opt-out), `RolesGuard` con `@Roles(...)`, `@CurrentUser()`, `LoginDto` con normalización lowercase+trim, `password.util.ts` con `hashPassword`/`verifyPassword` (bcrypt 10 rounds) y `DUMMY_HASH` para mitigación de timing attacks.
- **Deps nuevas**: `bcrypt`, `@nestjs/passport`, `passport`, `passport-jwt` (+ types dev). `@nestjs/jwt` ya estaba.
- **Guard global** registrado vía `APP_GUARD`. `@Public()` explícito en `PublicController` (a nivel controller) y `WebhookController`. Login lleva `@Public()` + `RateLimit(10)` por IP.
- **Multi-tenant**: payload JWT lleva `sub, clinicId, role`. `clinicId=null` para SUPERADMIN. `me()` incluye `clinic` snapshot (sin `wahaSession`, sin `password`).
- **Anti-enumeración + anti-timing**: mismo mensaje `"credenciales inválidas"` para email inexistente vs password mala; rama "user no existe" ejecuta `bcrypt.compare` contra `DUMMY_HASH` para consistencia de latencia.
- **Seed extendido**: `super@agendazap.dev`/`super1234` (SUPERADMIN, sin clínica) y `admin@demo.dev`/`demo1234` (CLINIC_ADMIN de `demo`). Idempotente vía `upsert` por email. Password hasheado con `hashPassword`. Warning "dev only" en docs.
- **`main.ts`**: `JWT_SECRET` agregado al fail-fast productivo. `.env` raíz con `JWT_SECRET=dev-jwt-secret` para dev.
- **Tests**: **76/76 verdes** (57 previos + 19 nuevos). Cubren: DTO validation + normalización, login happy path, email inexistente, password mala, contrato de payload JWT firmado + verificado, tampering (secret distinto), multi-tenant (2 users → 2 clinicIds), SUPERADMIN sin clínica, `me` sin password, `RolesGuard` en 4 casos, anti-timing heurístico.
- **Smoke E2E** (backend real + db + redis): login → 200 + payload correcto ✓ · `me` con token → 200 ✓ · `me` sin token → 401 ✓ · `admin-ping` CLINIC_ADMIN → 200 ✓ · `admin-ping` PROFESSIONAL → 403 ✓ · `GET /public/clinics/demo` → 200 ✓ · `POST /webhooks/waha` → 200 ✓ · 11 logins con pw mala → 429 `Retry-After: 60` ✓.
- **Deuda documentada** (post-piloto): refresh tokens, password reset, MFA, session revocation, rate-limit por email, bloqueo temporal, auditoría de auth. Detalle en [[notas/2026-08-08-bloque-auth]].

## 2026-08-08 (fixes post-audit Auth) — blockers + nits del code-reviewer y security-auditor
- **A.1 `.gitignore` en la raíz** del monorepo: cubre `node_modules/`, `dist/`, `.env*` (excepto `.env.example`), logs, IDE, OS, prisma sqlite, coverage, runtime.
- **A.2 `.env.example` en la raíz** con TODOS los nombres pero SIN valores reales. Documenta `JWT_SECRET`, `TRUST_PROXY`, `WEBHOOK_TOKEN`, `CORS_ORIGINS` y el resto del stack.
- **A.3 HS256 forzado**: `JwtStrategy` con `algorithms: ['HS256']` en el super; `JwtModule.register` con `signOptions.algorithm: 'HS256'`. Nuevo `jwt-algorithms.spec.ts` con test explícito: token firmado con HS512 usando el MISMO secret → verify con `algorithms: ['HS256']` → rechazado.
- **B.1 `WEBHOOK_TOKEN` obligatorio en prod**: `webhook.controller.ts` ahora tira 403 si `NODE_ENV=production` y no está seteado. Comentario apunta a `WHATSAPP_HOOK_HEADERS` para configurar WAHA.
- **B.2 `JWT_SECRET` fail-fast en prod**: `main.ts` valida `length >= 32` y prefijo `!= 'dev-'`. Crash al bootstrap si falla.
- **B.3 Seed guard**: `prisma/seed.ts` tira `Error('seed no debe correr en producción')` al comienzo de `main()`.
- **B.4 Trust proxy**: `main.ts` aplica `httpAdapter.getInstance().set('trust proxy', 1)` si `TRUST_PROXY === 'true'`.
- **B.5 Log de login fallido con IP**: `AuthController.login` envuelve en try/catch, extrae IP con el helper compartido y loguea `logger.warn('auth login fail ip=<ip>')`. Cero PII. Helper `extractIp` movido de `rate-limit.guard.ts` a `common/extract-ip.ts` y re-exportado por compat.
- **B.6 `admin-ping` removido** de la superficie HTTP. Comportamiento del `RolesGuard` sigue cubierto por 4 tests unitarios en `auth.controller.spec.ts`.
- **B.7 `expiresIn` duplicado eliminado**: `AuthService` ya no pasa options a `signAsync`; todo vive en `JwtModule.register` (24h + HS256). Test ajustado.
- **B.8 Test timing determinístico**: reemplazado `Date.now()` por `jest.spyOn(passwordUtil, 'verifyPassword')` — assertion directa de que la rama "no user" invoca `verifyPassword(pwd, DUMMY_HASH)`. Sin flakiness.
- **B.9 `RateLimit(N, scope?)`**: factory ahora acepta scope explícito. Key Redis usa `scope` si viene, si no cae al `slug` del path, si no cae a `'default'` (nunca `'unknown'`).
- **B.10 Rate-limit del login por email hasheado**: `AuthService.login` calcula `login_fail:sha256(email).slice(0,16)`. INCR + EXPIRE 900s en fail, DEL en ok. Si `count >= 5` → 429 `"demasiados intentos, probá en un rato"`. Redis inyectado vía `REDIS_CLIENT` (ya exportado por `PublicModule`). 3 tests nuevos: 6to fail → 429; ok limpia counter; emails distintos NO comparten counter.
- **ADR 0005** creado (`docs/adr/0005-auth-mvp-y-deuda.md`) con las decisiones + deuda para post-piloto. Nota `2026-08-08-bloque-auth.md` actualizada (nuevas env vars, `admin-ping` removido, rate-limit por email). Registrado en [[INDEX]].
- **Tests**: **81/81 verdes** (76 previos − 0 removidos + 5 nuevos: 2 del algoritmo JWT + 3 del rate-limit por email; se sumó también un cambio del test de timing y del payload signAsync). Build limpio.
- **`rg 'new Date\(\)' apps/backend/src -g '!*.spec.ts'` → limpio**.
- **Smokes ejecutables** (documentados en el reporte final): login OK/fail, forjar token HS512 → 401, webhook sin token con `WEBHOOK_TOKEN` set → 403, 6 logins fallidos al mismo email desde IPs distintas → 429.

## 2026-08-09 — Panel Backend Etapa 1: TenantContext + CRUDs
- **TenantContext helpers** (`apps/backend/src/auth/tenant-context.util.ts`): `assertClinicScope`, `isSuperadmin`, `tenantWhere`. Precondición del ADR 0005 §7 cerrada. CLINIC_ADMIN/PROFESSIONAL sin clinicId → 403; SUPERADMIN sin override → 400; override sólo se respeta para SUPERADMIN.
- **8 módulos CRUD nuevos** (`services`, `professionals`, `business-hours`, `time-off`, `appointments`, `conversations`, `dashboard`, `faq`). Todos con `@Roles(...)` explícito y todas las queries derivadas de `tenantWhere(user, override?)`.
- **FSM de citas** implementada en `appointment-status.util.ts` según SPEC §2. `PATCH /appointments/:id/status` con transiciones ilegales → 422; legales → side effects en `RemindersService` (confirm/cancel) fail-open.
- **Sanitización de replies**: `ReplyDto` elimina control chars ASCII salvo `\n`/`\t` antes de persistir + enviar por WAHA. `POST /conversations/:id/release` limpia `flowStep`/`flowData` para reiniciar FSM del bot.
- **Dashboard metrics** (30d): `noShowRate`, `byStatus`, `confirmations` (sent/confirmed/rate con guard división por cero), `trend` 14 días con daily buckets en TZ clínica.
- **PII minimizada** en responses: `GET /appointments` NO devuelve `notes`; `FaqController` NO expone `embedding`.
- **No se tocó el schema Prisma** — `FaqChunk` no tiene `title`, DTO adaptado a `content`-only (RAG llenará embeddings luego).
- **Tests**: **172/172 verdes** (81 previos + 91 nuevos). Cubre FSM completa (10 legales + 11 ilegales + same-status), leaks multi-tenant por resource (404), SUPERADMIN sin override (400), side effects reminders, sanitización XSS, dashboard shape.
- **`rg 'new Date\(\)' apps/backend/src -g '!*.spec.ts'` → limpio** (uso Luxon en `conversations` para bump de `updatedAt`).
- **Ripgrep `clinicId:` en los 8 módulos nuevos** → todo se deriva de `scope.clinicId` (via `tenantWhere`), tipos declarados en helpers, o mocks de spec files. Cero query cruda con `clinicId:` hardcodeado.
- Documentación completa en [[notas/2026-08-09-panel-backend-cruds]].
- Deuda pendiente: (1) `professionalId` en JWT para reemplazar `User.findUnique` en `/appointments/mine` (ADR 0005 §8); (2) opcional `'PANEL'` source en `AppointmentSource` para métricas por canal; (3) `FaqChunk.title` si el frontend lo requiere.

## 2026-08-09 — Bloque RAG FAQ (KnowledgeModule)
- **`KnowledgeModule` + `KnowledgeService`** (`apps/backend/src/knowledge/`): embed via OpenAI `text-embedding-3-small` (1536 dims), `ingest`/`updateChunk` con `$executeRawUnsafe` + literal `[..]::vector`, `retrieve` con operador `<=>` (cosine distance) + threshold `maxDistance=0.5`, `answer` con LLM synthesis (DeepSeek → Gemini fallback) y prompt anti-injection (delimitadores `--- FUENTE N ---` + sentinela `NULL_ANSWER`). `KnowledgeUnavailableError` cuando falta `OPENAI_API_KEY`.
- **`FaqController` con embeddings**: `POST` llama `ingest`; sin `OPENAI_API_KEY` cae a `prisma.create` sin embedding + header `X-Warning: embedding-skipped-no-openai-key`. `PATCH` re-embed cuando `content` cambia (mismo fallback silencioso).
- **Bot integration**: `Intent.PREGUNTA_FAQ` reemplaza el stub → `knowledge.answer(...)`. Si `null` → `Conversation.state = NEEDS_HUMAN` + "Déjame verificar esa información y en breve te responde una persona del equipo. 🙏". Política: prefiero handoff que alucinar.
- **Seed**: 4 FAQs de ejemplo para `demo` (horarios, dirección, formas de pago, duración). Idempotente por `(clinicId, content)`. Genera embeddings si hay `OPENAI_API_KEY`; si no, deja `embedding=NULL` + log recordando correr el reindex.
- **CLI reindex** (`prisma/reindex-faq.ts`): `pnpm --filter @agendazap/backend prisma:reindex-faq`. Procesa `WHERE embedding IS NULL`. Exit 1 si falta la key (a diferencia del create, acá no tiene sentido degradar).
- **Multi-tenant**: TODAS las queries raw pasan `clinicId` como parámetro posicional (`$1`/`$2`/`$3`) — nunca interpolado. El único literal interpolado es el vector (Prisma no lo parametriza), safe by typing (`number[]`).
- **PII en logs**: cero. Sólo `clinicId`, `contentLen`, `qLen`, contadores, `minDist`. Nunca el content de la FAQ ni la pregunta del paciente.
- **Tests**: **208/208 verdes** (185 previos + 23 nuevos). Cubre embed sin key, ingest/update raw SQL correcto, retrieve filtro por clinicId + threshold, answer con matches / sin matches / NULL_ANSWER / ambos LLM caídos / locale=pt, controller happy path y fallback sin key, bot handoff y respuesta feliz.
- **Build**: `pnpm build` limpio. `rg 'clinicId:' apps/backend/src/knowledge` → 0 apariciones fuera de tipos/docstrings (todas las raw queries usan parámetros posicionales).
- **Doc**: nota completa en [[notas/2026-08-09-rag-faq]] con decisiones (modelo, threshold, anti-injection, fallback sin key), cómo correr seed/reindex, smokes y deuda post-piloto (índice ivfflat, rate-limit ingest, cache Redis, citas en respuesta, CLI export/import).

## 2026-08-09 (post-audit Panel) — Blockers + should-fix del code-reviewer y security-auditor
- **A.1 M-N connect/set tenant-guard** (blocker B1): `ServicesController` y `ProfessionalsController` ahora tienen `assertProfessionalsInScope` / `assertServicesInScope` que hacen `findMany({ where: { id: { in: ids }, clinicId } })` y comparan `found.length === ids.length` antes de `connect`/`set`. Si falta alguno → 400. Cubre create + update de ambos controllers. Antes, Prisma linkeaba IDs cross-tenant sin verificar (Prisma no soporta `where` en `connect`).
- **A.2 `DashboardController`** (blocker B3): reemplazado `clinicId: scope.clinicId` (y el uso directo de la variable local `clinicId`) por spread `...scope`. El `reminder.count` navega por `appointment: { ...scope }`. Import cambiado de `assertClinicScope` a `tenantWhere`. Cero `clinicId:` suelto en el archivo.
- **A.3 `assertClinicScope` rechaza override divergente** (alto A1): non-SUPERADMIN con `overrideClinicId !== user.clinicId` → 403 explícito ("no podés operar sobre otra clínica"). Antes: silently ignorado, tapaba bugs y potenciales intentos hostiles. Override igual al propio sigue funcionando (compat). 4 tests nuevos.
- **A.4 Consent SIEMPRE obligatorio** (alto A2): removido el bypass `!isSuperadmin(user)` en `POST /appointments`. DTO ahora: `@IsBoolean()` + `@Equals(true, ...)` sobre `consent!: boolean` — igual al DTO público. El rol interno NO otorga consent (LGPD/GDPR datos de salud). Import de `isSuperadmin` removido. 2 tests nuevos.
- **B.1 `PatchStatusDto.reason` removido** (should-fix M4): no se persistía y el log estaba prohibido por "cero PII". Se re-integra con `AuditEvent` post-piloto (ADR 0006 §Deuda).
- **B.2 Sanitize control chars** (M5+N1): nuevo helper `apps/backend/src/common/sanitize-text.ts` con `stripControlChars` (ASCII 0x00-0x1F/0x7F + zero-width + RTL overrides). Aplicado vía `@Transform` en `CreatePanelAppointmentDto.name` y `CreateTimeOffDto.reason`.
- **B.3 `GET /appointments?professionalId=` validado** (M6): pre-check con `findFirst({ where: { id, ...scope } })` — si no matchea → 400. Antes devolvía lista vacía encubriendo cross-tenant.
- **B.4 `fetcher()` 401 handling** (Nit-A1): en client, `res.status === 401` → `clearTokenFromDocument()` + redirect a `/{locale}/login?next=...`. En SSR, no redirige.
- **B.5 `AgendaClient.tsx` UTC-anchored** (Nit-A5): nuevo helper `shiftDayISO(iso, delta)` usa `Date.UTC(y, m-1, d) + delta*86_400_000` — determinístico, sin TZ drift. Reemplaza los 3 `new Date(\`${date}T12:00:00Z\`)`. `formatWeekdayShort` también anclado a UTC (`timeZone: 'UTC'` en `Intl.DateTimeFormat`). Cero Luxon en `apps/web`.
- **B.6 Modal focus management** (Nit-A6): `previousFocusRef` guarda `document.activeElement` al abrir, foca el primer interactive del container (o el container con `tabIndex=-1`), y restaura al cerrar.
- **B.7 Toast `role="alert"` en errores** (Nit-A8): errors → `role="alert"` + `aria-live="assertive"`; success/info → `role="status"` + `aria-live="polite"`. Container ya no lleva `aria-live` (evita duplicación).
- **B.8 Test PENDIENTE → CANCELADA** (Nit-T1): agregado en `appointments.controller.spec.ts`, verifica que la respuesta trae `status=CANCELADA` + `cancelForAppointment('appt-1')` fue invocado.
- **B.9 Middleware locales dinámicos** (Nit-N4): `PANEL_REGEX`/`LOGIN_REGEX`/`LOCALE_PREFIX_REGEX` construidas desde `routing.locales.join('|')`. Agregar `en` al futuro no requiere tocar el middleware.
- **B.10 Race PATCH status → 422 refresh** (nuevo): `AgendaClient.changeStatus` maneja `res.status === 422` → toast info + `router.refresh()` + cierra modal. Otros errores (500/network) → toast error + modal queda abierto. Nueva key `panel.agenda.statusRaceRefresh` en es/pt.
- **ADR 0006 creado** (`docs/adr/0006-panel-mvp-y-deuda.md`) — consolida decisiones y documenta 9 items de deuda (idempotencia POST /appointments, race takeover, AuditEvent, cancelReason, professionalId en JWT, pt.json, JWT httpOnly + refresh + revocación, rate-limit en CRUDs, WebSocket para conversaciones). Registrado en [[INDEX]].
- Verificaciones: build backend + web limpios. `rg 'clinicId:' apps/backend/src/{dashboard,services,professionals,appointments,conversations,time-off,business-hours,faq}` sólo devuelve derivaciones de `scope.clinicId` + tipos + `select` de FAQ (campo expuesto en response). `rg 'new Date\(\)' apps/backend/src -g '!*.spec.ts'` limpio. `rg 'new Date\(\)' apps/web/src/app/[locale]/panel/agenda` solo helper UTC-anchored documentado.

## 2026-08-09 — UX audit del panel Next.js (ux-plan-auditor)
- **Audit UX completo ejecutado** siguiendo el skill `ux-plan-auditor`, 6 ejes (consistency,
  density, states, a11y, responsive, i18n). Objetivo: cerrar deuda UX documentada + destapar
  gaps invisibles antes del piloto real.
- **12 specs generadas** bajo `docs/ux/` — priorización brutal: **6 P0** (bloqueadores
  piloto/WCAG crítico), **5 P1** (importantes para escalar), **1 P2** (polish).
- **Top-3 findings críticos**:
  1. `apps/web/messages/pt.json:50-338` — todo el bloque `login.*` + `panel.*` está en
     ESPAÑOL. Blocker piloto pt-BR. Ver [[ux/2026-08-09-pt-json-panel-en-espanol]].
  2. `apps/web/src/app/[locale]/panel/faq/FaqClient.tsx` — sin banner "N FAQs sin
     embedding" → el bot es silenciosamente inútil si `OPENAI_API_KEY` no está seteada.
     Ver [[ux/2026-08-09-faq-embedding-banner]].
  3. `apps/web/src/app/[locale]/panel/conversaciones/ConversationsClient.tsx:356` — la
     Textarea de reply está disabled hasta HUMAN → el operador no puede pre-escribir
     durante el handoff. Además staleness invisible del polling 15s. Ver
     [[ux/2026-08-09-conversations-staleness-y-reply-lock]].
- **Fase A (antes de piloto)**: los 6 P0.
  Fase B (antes de escalar): los 5 P1.
  Fase C (polish): 1 P2.
- **Deuda ya documentada** confirmada durante el audit: `AgendaClient` con `new Date()`
  UTC-anchored explícito (OK per ADR 0006), modal focus management parcial sin trap del
  Tab (nuevo spec P0), design system con `stateStyle` duplicado + hex hardcodeados en el
  chart, `bg-brand-500 text-white` bubble/slot con contraste 2.83:1 → FALLA WCAG AA.
- **Sub-agent recommendations** en cada spec bajo la matriz del skill (mayoría
  `general-purpose` + `frontend-design`; el drawer mobile usa `mobile-app-ui-design`;
  el pt.json usa `copywriting`; tokens de tailwind usan `tailwind-design-system`).
- Specs registradas en [[INDEX]] bajo nueva sección "UX specs". Cada spec incluye
  file:line evidence, propuesta con criterios de aceptación, y prompt listo para el
  subagente ejecutor.
- Restricción cumplida: cero código UI escrito — sólo specs + docs.

## 2026-08-09 (cierre) — Bloque Piloto: seed histórico + docs + deploy
- **Seed enriquecido** (`apps/backend/prisma/seed.ts`): agregada la función `seedHistoricalData()`. Ahora, además de la clínica demo + servicios + profesionales + FAQs + users, genera 8 pacientes ficticios VE (+58414/+58424, E.164 válido, nombres realistas), **42 citas** en los últimos 30 días con distribución 22 ATENDIDA / 6 NO_SHOW / 6 CANCELADA / 4 CONFIRMADA / 2 PENDIENTE / 2 EN_RIESGO (para tener la alerta visible), **84 recordatorios** (2 por cita, status coherente: SENT/CONFIRMED/CANCELED/SCHEDULED), y 2 conversaciones sample (una BOT, una NEEDS_HUMAN).
- **Idempotencia**: marca appointments con `[seed:v1]` en `notes` y conversations con prefijo `seedv1-` en `chatId`. Al re-correr, `deleteMany` de esas filas primero (reminders y messages bajan en cascada por el schema). Corre 2 veces sin errores.
- **Pre-load de takenSlots**: para evitar colisiones con el `@@unique([professionalId, startAt])` cuando la DB tiene citas de smoke tests previos, pre-cargamos las citas existentes del rango [-35d, +10d] en el set antes de generar las históricas. LCG determinístico (`seedRng=1337`) para reproducibilidad.
- **Distribución por profesional**: alternamos ~50/50 entre Dra. Ríos y Dr. Pérez con contador `profIdx`. Días L-V (Luxon weekday 1..5), horas 9,10,11,12,14,15,16,17 (skipping 13 = almuerzo).
- **Dashboard vivo**: `GET /api/dashboard/metrics` con `admin@demo.dev` ahora devuelve `noShowRate=0.214`, `byStatus.ATENDIDA=22`, `byStatus.NO_SHOW=6`, `confirmations.sent=55/confirmed=21/rate=0.38`, `trend` de 14 días con daily buckets. Ya no todos ceros.
- **Docs de piloto** creados en `docs/`:
  - `onboarding-clinica.md` — playbook 14-secciones para alta de clínica nueva. Documenta la deuda de endpoints faltantes (`POST /clinics`, `GET waha/status`, config UI) con fallbacks via Prisma Studio + SQL + WAHA API directa. Matriz de troubleshooting.
  - `runbook-panel.md` — día a día operativo. FSM completa de citas con transiciones permitidas, uso de bandeja (BOT/NEEDS_HUMAN/HUMAN), CRUDs (servicios/profesionales/horarios/bloqueos/faq), convenciones operativas (cerrar el día, responder NEEDS_HUMAN en 30 min).
  - `smoke-e2e.md` — 8-secciones checklist con curl snippets ejecutables, verificaciones en DB + Redis, matriz de resultados. Cubre: login panel, bot via webhook, panel cancela, público agenda, recordatorio, handoff, FAQ RAG.
  - `deploy.md` — Hetzner CX22 + Docker Compose + Caddy. Estructura `/srv/agendazap/data/*`, `docker-compose.prod.yml` sin exponer puertos, .env.production con `openssl rand`, backup diario cron, runbook de emergencia (restart, restore, rotar secrets).
- **`docker-compose.prod.yml`** creado en la raíz: sin `platform: linux/amd64`, db+redis+waha+backend+web NO exponen puertos al host, volúmenes en `/srv/agendazap/data/*`, `restart: unless-stopped`, envs desde `.env.production`, Caddy como reverse proxy con TLS Let's Encrypt.
- **Dockerfiles multi-stage** creados:
  - `apps/backend/Dockerfile`: node:20-alpine + pnpm 9 + prisma generate + nest build; runtime con tini + openssl + usuario `app` no-root + `pnpm exec prisma migrate deploy && node dist/main.js`.
  - `apps/web/Dockerfile`: idem + `NEXT_PUBLIC_API_URL` como build-arg (Next.js baking client-side env en build-time). Runtime con tini + `pnpm start` en :3002. `output: 'standalone'` documentado como optimización post-piloto.
- **`.dockerignore`** en la raíz: excluye `node_modules`, `dist`, `.next`, `.env*`, `.git`, `docs`, `apps/mobile` (Flutter aparte), `.obsidian`.
- **README pulido**: header + problema/objetivo del PRD, tabla de bloques cerrados con checkboxes, tabla de stack, quickstart de 7 pasos con verificación, estructura del monorepo, env vars críticas, comandos comunes, links a los 4 docs nuevos, convenciones de contribución, riesgos, licencia TBD.
- **`docs/INDEX.md`** actualizado: nueva sección "Piloto (operación y deploy)" con los 4 documentos nuevos wikilinkeados.
- **Verificaciones**: `pnpm --filter @agendazap/backend prisma db seed` corre limpio (idempotente, 2ª vez purga 42 appointments + 2 conversations y regenera). `pnpm build` limpio. `pnpm test` → **208/208 verdes** (sin cambios en src). Conteos DB: `SELECT status, COUNT(*) FROM "Appointment" WHERE notes LIKE '%[seed:v1]%' GROUP BY status` → PENDIENTE=2 CONFIRMADA=4 EN_RIESGO=2 ATENDIDA=22 CANCELADA=6 NO_SHOW=6 (total 42). Reminders 84 (SCHEDULED=28 SENT=56 CANCELED=12 — split coherente con las canceladas y los offsets futuros).
- **Restricciones cumplidas**: NO se tocó el schema Prisma, NO se modificó nada en `src/` (excepto el seed vive en `prisma/`), NO se agregaron libs nuevas (Luxon ya estaba), cero secretos reales en los docs (todos placeholders), cero PII de pacientes en logs (nombres seed son ficticios, phones sí formato E.164 pero nunca loggeados).
- **Deuda documentada del piloto** (para arrancar el 2do bloque post-Flutter): endpoints admin (`POST /clinics`, `POST /clinics/:id/users`, `GET waha/status`, config UI), password reset, WebSocket para bandeja, output: 'standalone' del web Dockerfile, backups off-site automatizados, health check público, Sentry.

## 2026-09-09 — Sprint 2 · tests de reminders y follow-ups (s2-9)

- Specs nuevos (sin tocar `src/` de producción): `reminders/reminders.service.spec.ts` (22), `reminders/reminders.processor.spec.ts` (34 + 1 skip), `follow-ups/follow-ups.service.spec.ts` (22), `follow-ups/follow-ups.processor.spec.ts` (12) y 35 tests nuevos en `bot/bot.service.spec.ts` (respuestas SÍ/CANCELAR/REAGENDAR al recordatorio + sub-FSM `AWAITING_NPS_SCORE`/`AWAITING_NPS_COMMENT`).
- Convención para testear workers BullMQ sin Redis: `jest.mock('bullmq')` devolviendo `{ name, processor, opts }` desde `Worker` y ejecutar `worker.processor(job)` con jobs sintéticos `{ id, name, data, attemptsMade }`. El reloj se fija con `Settings.now` de Luxon.
- Suite: 49 suites / 721 tests (antes 45 / 596). Tabla de cobertura de [[SPEC]] actualizada.
- **Bug detectado, no corregido** (`it.skip` + `// BUG:` en `reminders.processor.spec.ts`): `send-reminder` solo excluye `CANCELADA`/`NO_SHOW`; una cita ya `ATENDIDA` recibe igualmente "te recordamos tu cita… responde SÍ".
- Hallazgos menores: `ReminderStatus.CONFIRMED` y `FAILED` no se usan en ningún camino (la confirmación vive en `Appointment.confirmedAt`; el fallo de WAHA se relanza para retry de BullMQ y el Reminder queda `SCHEDULED`); `send-follow-up` manda el prompt aunque no exista `Conversation` para ese teléfono, con lo que la respuesta "5" caería al LLM en vez de la sub-FSM.

## 2026-09-09 — Sprint 2 · smoke E2E automatizado con Playwright + job `e2e` en CI (s2-10)

- Tres casos en `apps/web/e2e/`: agendar desde `/es/agendar/demo` hasta `/gracias` (fecha + hora del slot elegido), slug inexistente → 404 "Clínica no encontrada", y doble `POST /api/public/clinics/demo/appointments` al mismo slot → 201 y 409 (vía `request`, sin navegador). Selectores por id/rol/texto i18n, sin `data-testid` nuevos ni cambios en `src/`.
- `@playwright/test` **1.63.0** pineado en `apps/web` (única versión cuyo `browsers.json` apunta a `chromium-1243`, el build ya instalado en el VPS). Sólo proyecto chromium.
- `scripts/e2e-local.sh`: infra efímera `docker-compose.e2e.yml` (proyecto `showly-e2e`, puertos 5433/6380, tmpfs, **sin WAHA**) → migrate + seed → build → backend :4102 + web :3102 → tests; `trap EXIT` limpia procesos y contenedores. Job `e2e` en `ci.yml` con Postgres/Redis como `services:` y cache del browser.
- **Decisión**: el backend arranca sin WAHA (el health-monitor sólo loguea `waha.health.error`), así que no hace falta stub: `WAHA_BASE_URL` a un puerto discard + intervalo 60 min. `NODE_ENV=test` para esquivar `validateProdEnv` y habilitar el seed. Detalle en [[smoke-e2e]] §12.
- **Bug detectado, no corregido**: el rate-limit público usa una sola clave Redis por `slug+ip+minuto` compartida entre GET (30/min) y POST (5/min), así que los GETs de página/slots consumen el presupuesto de 5 del POST → un paciente normal puede recibir 429 al confirmar. El spec de API espera al próximo bucket de minuto para no chocar. Fix sugerido: `scope`/endpoint en la clave.
- Corrida local sobre `fix/body-parser-express5` (sin ese hotfix todo POST JSON devuelve 500): **3/3 verdes** en 56 s.

## 2026-09-10 (noche) — webhook WAHA en prod: nombre de env equivocado

- **Bug**: el bot no respondía en prod. WAHA hacía el POST a `/webhooks/waha` sin `x-webhook-token`
  y el backend devolvía 403 en los 15 reintentos. Causa: los compose (`docker-compose.coolify.yml`,
  `docker-compose.prod.yml`, local) y los docs usaban `WHATSAPP_HOOK_HEADERS`, que WAHA no lee.
  El nombre real es `WHATSAPP_HOOK_CUSTOM_HEADERS` (formato `name:value;name2:value2`, `split(':')`,
  sin espacios). Ídem `WHATSAPP_HOOK_HMAC` → `WHATSAPP_HOOK_HMAC_KEY`.
- **Fix** en repo: renombradas ambas vars en los tres compose, `.env.example`, ADR 0005, nota de
  auth, onboarding y spec HMAC. Desplegado en Coolify (deploy `wgou9su…`, main `fe9c3ed`, 19:49 UTC): WAHA ya
  manda el header y el backend responde 200; sesión `demo-session` WORKING.
- **Gotcha HMAC**: WAHA firma con sha512 por defecto y `webhook-auth.util.ts` verifica sha256. Mientras
  no se alineen, `WEBHOOK_HMAC_SECRET` debe quedar vacío en prod y autenticar sólo por token.
- **Dev local**: healthcheck de WAHA colgaba `compose --wait` (ver
  [[notas/2026-09-10-waha-healthcheck-wget]]). Base local migrada y sembrada con `scripts/dev-up.sh`.

## 2026-09-10 — Tono de voz: español LATAM neutro + aviso de IA corto
- Todos los textos de paciente pasan a tuteo neutro (bot, `public.controller`, 13 claves de `es.json`). Ver [[notas/2026-09-10-tono-espanol-neutro]].
- Copy del bot rediseñado con principios de psicología (saludo con link y con contexto de cita, progreso, errores sin culpa, cierre con servicio+profesional, recordatorio como compromiso). Detalle en la nota.
- `AI_DISCLOSURE` del bot queda en una línea sin listar proveedores; el consent del form sigue nombrándolos. ADR 0004 §7.1.
- Palabra de escape unificada: `escribe *humano*`.
- RAG: umbral de distancia 0.5 → 0.65 tras calibrar con preguntas reales (la pregunta de ubicación hacía handoff). Ver [[notas/2026-09-10-rag-umbral-distancia]].

## 2026-09-11 — P0 del bot, PR A1: matching de saludo, confirmación y escape a humano
- B1: el saludo ya no se come el mensaje. `stripGreeting` recorta saludos, muletillas y el nombre
  de la clínica; si queda contenido, sigue la escalera (recordatorio → clasificador → RAG) con el
  texto recortado. `"hola, quiero agendar una cita"` arranca la FSM sin saludo previo.
- B2: `sí`/`ok`/`dale` solo confirman si el bot preguntó primero — último `OUT` con `*SÍ*`, o un
  `Reminder` SENT de las últimas 48 h para una cita próxima de ese teléfono. Si el mensaje nombra
  otra cosa ("sí, quiero agendar una cita") va al clasificador. `confirmo`/`cancelar`/`reagendar`
  siguen pasando siempre. Nuevo cierre de cortesía sin LLM para `"ok gracias"`.
- SPEC actualizado con el contrato nuevo de confirmación, saludo y escape a humano.
- B3: `persona` deja de ser palabra suelta de escape a humano; quedan `humano`, `operador`,
  `asesor`, `representante` y las frases explícitas.
- Las reglas de matching se mudaron a `apps/backend/src/bot/message-matching.ts` (funciones puras,
  spec propio) y las comparten `BotService` e `IntentService`.
- Gotcha de tests encontrado de paso: mockear `Math.random` hacía que jest reportara
  `RangeError: Maximum call stack size exceeded` en vez del fallo real. Ver
  [[notas/2026-09-11-source-map-stack-overflow]].
- Detalle: [[notas/2026-09-11-bot-matching-saludo-si-persona]]. Fuente: §4 de
  [[analisis/2026-09-11-chatbot-analisis-tecnico]]; reparto en [[plans/2026-09-11-p0-bot-reparto]]
  (ambos llegan por el PR #45).

## 2026-09-11 — El RAG del bot recibe el teléfono de la conversación
- `bot.service.ts` pasa `phone: convo.phone` a `knowledge.answer` (paso 4 de M1, que la sesión B
  dejó como parámetro opcional). Con eso el bloque de hechos de BD incluye "tu próxima cita" y el
  bot puede responder "¿cuándo es mi cita?" sin inventar.
- Va `convo.phone` y no el `phone` del mensaje: el upsert de la conversación conserva el número ya
  conocido, así que un mensaje que llegue por `@lid` no borra el contexto. Sin teléfono el bloque
  sale igual, sin la parte de la cita.
- Es el teléfono que reporta WAHA, no uno declarado en un formulario. La distinción importa: ver
  la decisión de S5 sobre no rellenar `Conversation.phone` con el número del form público.

## 2026-09-11 — P1 · M2-b: página web de gestión de cita por link
- `/[locale]/agendar/[clinicSlug]/cita?t=<token>`: el paciente ve su cita, la cancela con
  confirmación o le cambia el horario. Server component que hidrata contra el `GET manage` de M2-a;
  el resto es client con react-query.
- `/gracias` muestra el link de gestión cuando la creación devuelve `manageUrl`. **El link es un
  token bearer**, así que viaja por `sessionStorage` y no por la query string (Referer, historial y
  logs del CDN) — mismo canal y mismo motivo que el nombre del paciente en el ADR 0004 §B.4.
- Decisiones en [[notas/2026-09-11-gestion-cita-por-link-web]]: una sola pantalla para todos los
  fallos de token (el backend devuelve el mismo 404 a propósito), `canCancel` tratado como pista y
  no como garantía (409 manejado en las dos acciones, con `router.refresh()` en vez de adivinar), y
  aviso explícito cuando el reagendamiento no devuelve token nuevo.
- **Corrección al plan**: decía "reutiliza `ScheduleSelection`", pero ese archivo no es un selector
  de horarios sino un context + el resumen de la sidebar; el selector real está acoplado a
  `react-hook-form` dentro de `ScheduleForm.tsx`. Se extrajo sólo el formateo puro
  (`slot-format.ts`, que ahora usan las dos páginas) y la página de gestión tiene su propio picker.
- Pendiente: el E2E del flujo completo está tras `E2E_MANAGE=1` hasta que M2-a entre en `main`.
- Del `code-reviewer` salieron cinco blockers, todos corregidos antes del PR: (1) `router.refresh()`
  no resincronizaba el client (React conserva su state) → el copy del 409 mentía; (2) cancelar no
  actualizaba el estado de la cita en la tarjeta; (3) el `ConfirmDialog` se quedaba abierto tapando
  el resultado y permitiendo un segundo POST; (4) `new Date().toISOString()` como `from` de
  disponibilidad usaba la TZ del navegador; (5) si no se podía extraer el token nuevo del
  `manageUrl`, la página quedaba con un token muerto y sin avisar.
- También: pantalla propia para fallos transitorios (un 429 ya no dice "link inválido", que llevaba
  a citas duplicadas), confirmación al reagendar, `noindex` en la ruta, y aviso de que el rate-limit
  por IP ve la del servidor Next en SSR — pendiente de resolver en M2-a.
- Tras la revisión de M2-a: el `GET manage` pasa a limitarse **por token y no por IP** (en SSR el
  cubo veía la IP del servidor Next, compartida por toda la clínica); se descartó mandar la IP real
  en una cabecera, que es el vector que `TRUST_PROXY` existe para cerrar. Y dos cambios de contrato
  que la web ya contempla: reagendar devuelve la cita a `PENDIENTE` (limpia `confirmedAt`) y hay un
  tope de reagendamientos **del paciente**, cuyo `canReschedule` actualizado viene en la respuesta
  del POST — sin usarlo, quien gastaba su último cambio seguía viendo el botón.
## 2026-09-11 — M4: navegación de horarios en la FSM
- "0. Ver más horarios" avanza la ventana 7 días (`flowData.slotWindowCount`), con tope de 4
  ventanas y después el link tokenizado. Sin resetear la FSM en ningún caso.
- "Cualquier profesional" como última opción de `ASK_PROFESSIONAL`: mezcla los horarios de todos
  y fija el `professionalId` al elegir el slot (`offeredProfessionalIds`, paralelo a `offeredSlots`).
- Preferencia del mismo mensaje ("1, por la tarde", "el martes") filtra antes de mostrar; si queda
  vacía lo dice y muestra todo.
- Tras dos respuestas seguidas sin entender, ofrece el form web sin resetear la FSM.
- Detalle y gotchas en [[notas/2026-09-11-fsm-navegacion-horarios]].

## 2026-09-11 — M2-c: el link de gestión llega por WhatsApp
- El bot manda el link de gestión (ADR 0020) en cuatro sitios: al responder `REAGENDAR`, al
  detectar intención de cancelar, en la confirmación post-agendamiento y en el recordatorio.
- **`REAGENDAR` deja de apagar los recordatorios.** La cita sigue en pie hasta que el paciente la
  mueva, así que apagarlos la dejaba sin red justo cuando más riesgo de no-show tiene.
- `CANCELAR` explícito sigue cancelando por chat: ya es una confirmación. El link se ofrece cuando
  la intención viene del clasificador, antes de pedir la palabra.
- Todo es best-effort: si no se puede emitir el token (Redis caído), el bot y el recordatorio
  salen con las palabras de siempre. Perder el link no puede costar la respuesta ni el recordatorio.
- **S21**: la URL se construye en un solo sitio (`common/web-url.util.ts` + 
  `SchedulingSessionService.issueManageUrl`). Antes había tres lecturas de `WEB_BASE_URL` con su
  propio `replace(/\/+$/)`. Con los tokens de gestión viviendo hasta 30 días y el dominio de prod
  todavía en un `sslip.io` por IP, mover el dominio tenía que ser un env y no una cacería.
## 2026-09-11 — S5: ligar `Conversation.patientId`
- `findUpcomingAppointment` resuelve por `patientId` → `conversationId` → `phone` de la
  conversación, y liga de paso cuando encuentra al paciente por el teléfono de WAHA.
- **Desde el borde público NO se liga.** La primera versión ligaba si el `Patient` nacía en esa
  misma petición; el `security-auditor` mostró que eso prueba que nadie había reclamado el
  teléfono, no que quien rellena el form sea su dueño: un chat `@lid` podía pre-reclamar el número
  de otra persona y quedarse con todas sus citas futuras. Lo que sí se controla ahí es qué citas
  quedan atadas al chat (`conversationId`).
- Nunca se escribe `Conversation.phone` con el número del formulario.
- Efecto colateral necesario: `handleReminderReply` ya no exige teléfono antes de buscar, que era
  lo que impedía confirmar desde un `@lid` ligado — el caso que S5 venía a arreglar.
- Detalle y razonamiento en [[notas/2026-09-11-conversation-patient-link]].
## 2026-09-11 — P1 · B10: cola `bot-inbound` entre el webhook y el bot
- El webhook encola y responde 200 al instante; un worker BullMQ llama a `handleIncoming`. Antes
  esperaba al bot (LLM incluido) y WAHA reintentaba por timeout, procesando el mismo mensaje dos
  veces. Decisión y consecuencias en [[adr/0021-cola-bot-inbound]].
- **Blocker cazado en revisión, no en los tests**: BullMQ rechaza un `jobId` con `:`, y la clave de
  dedup tiene cuatro segmentos. Habría lanzado en TODOS los mensajes de texto → 500 → WAHA
  reintentando contra un fallo determinista → mensaje perdido, con el health en verde. No lo vieron
  los 86 tests porque la `Queue` está mockeada en todos. Detalle en
  [[notas/2026-09-11-cola-bot-inbound]].
- Del `security-auditor`: el rate-limit del ADR 0007 quedaba DETRÁS de la cola (cualquiera con el
  token del webhook podía llenar Redis), retención de jobs por cantidad y no por edad con datos de
  salud dentro, `parseRedis` descartando credenciales y TLS del `REDIS_URL`, y la PII colándose por
  el *mensaje* de los errores de Prisma. Todo corregido.
- El health check mira la **antigüedad** del mensaje más viejo, no sólo la profundidad: con 5-10
  mensajes/hora, un worker muerto tardaría días en llegar a 50 pendientes.
- Pendiente y anotado en el ADR: quitar el rate-limit de `handleIncoming` (mientras esté en los dos
  sitios, un reintento puede cruzar el cap y perder el mensaje en silencio), encolar sólo un id para
  sacar los datos del paciente de Redis, y un compare-and-set en la FSM porque un reintento reordena.

## 2026-09-11 — El rate-limit del bot sale de `handleIncoming` (va con la cola `bot-inbound`)
- Con la cola en medio, tener las dos capas del ADR 0007 dentro de `handleIncoming` además del
  webhook consumía presupuesto dos veces y dejaba un agujero peor: un reintento de BullMQ que
  cruzara el cap hacía `return` en silencio, el job se marcaba completado y el mensaje del paciente
  se perdía sin fallo, sin Sentry y sin bandeja.
- El bloque se quita de `handleIncoming` y queda solo en el webhook, delante del `inbound.add`.
  Queda un comentario en su sitio explicando por qué no debe volver: quien llegue desde el ADR 0007
  y lo vea ausente podría "restaurarlo" de buena fe.
- La cobertura se muda al spec del webhook, que además gana el fail-open del camino de texto.
- ADR 0007 actualizado.

## 2026-09-11 — B5: reagendar por chat
- `REAGENDAR` con cita deja la FSM en `ASK_SLOT` con el mismo servicio y profesional y
  `rescheduleOf` en `flowData`; al confirmar, `rescheduleAppointment` mueve la cita **in-place**
  (mismo id). El link de gestión queda como alternativa en el mismo mensaje.
- Crear+cancelar habría inflado `CANCELADA` y diluido el no-show rate, que es la métrica del
  producto. Ver la tabla de M2 en el plan del P1.
- Dos bugs que los tests no cubrían y salieron al escribirlos:
  - los dos re-ofrecimientos de horarios (`reofferSlotsAfterConflict` y `…AfterExpired`) perdían
    `rescheduleOf`, así que tras un choque de horario la FSM creaba una cita nueva y el paciente
    acababa con **dos**: la vieja sin mover y otra recién creada;
  - el tope de movimientos del paciente llega como `ConflictException`, **el mismo tipo** que el
    slot ocupado. Sin distinguirlos, alcanzar el tope re-ofrecía horarios en bucle infinito. Se
    distingue por el mensaje, que no es ideal: si el service expone un error tipado, cambiarlo.
- El tope por chat es el mismo que en el borde público (3): el canal no debe cambiar cuántas veces
  puede moverla.

## 2026-09-11 — P1 · M9-a: evento `bot.turn` y contadores del bot
- Una línea estructurada por turno, emitida por quien lo envuelve (processor de `bot-inbound`, o el
  webhook para adjuntos y descartes), más contadores por clínica y día en Redis que alimentarán el
  dashboard (M9-b). `BotService` anota intención/origen/RAG en un `AsyncLocalStorage`.
- **`LOG_HASH_SECRET` es nueva y obligatoria en producción**: hay que crearla en Coolify antes de
  desplegar o el backend no arranca.
- Blockers de la auditoría, corregidos: el seudónimo del `chatId` era un SHA-256 sin secreto sobre
  un teléfono (reversible en segundos; ahora HMAC con `clinicId` en el preimagen, para que además no
  correlacione al mismo paciente entre clínicas), y el campo `reason` salía como `[REDACTED]` en
  producción porque coincide con un path del redactor — renombrarlo sin más habría convertido el bug
  en una fuga, porque su valor era el mensaje de la excepción. Ahora es un conjunto cerrado.
- Los contadores sólo cuentan el primer intento (BullMQ reintenta 3 veces y el panel habría mentido
  sobre el volumen), el día va en la zona de la clínica y no en UTC, y se miran los errores de
  `pipeline.exec()`, que no rechaza por comandos sueltos. Detalle en
  [[notas/2026-09-11-evento-bot-turn]].
## 2026-09-11 — S23: una lectura de `Conversation` para las dos guardas
- La guarda de **persona** (¿este chat tiene derecho a esta cita?) se muda del
  `public.controller.ts` a `SchedulingService.createAppointment`, junto a la de **tenant**
  (¿la conversación es de esta clínica?). Una sola lectura sirve a las dos.
- No es solo ahorrar una query: dentro del service `patientCreated` ya es un hecho, así que
  desaparece la ventana de carrera que tenía comprobarlo antes de crear con un `findFirst` extra.
- Las dos quedan comentadas como distintas y no intercambiables: una falla duro, la otra descarta
  el enlace y sigue. El riesgo que motivó el ítem era que alguien viera dos lecturas iguales y
  borrara "la repetida", quedándose sin uno de los dos controles.
- Efecto lateral: la regla aplica ahora a **todos** los callers de `createAppointment`, no solo al
  endpoint público.

## 2026-09-11 — P1 · M9-b: actividad del bot en el dashboard
- Bloque nuevo en `/api/dashboard/metrics` y en el panel: turnos, atendidos, adjuntos, tasa de
  derivación y de NULL_ANSWER, desglose por intención y citas por origen.
- **La regla del bloque: un `null` no es un 0.** El revisor cazó que `handoffRate` daba 0% porque
  nadie escribe ese contador todavía — o sea, el panel habría afirmado "el bot lo resuelve todo
  solo", justo lo contrario de "no lo medimos". Ahora los contadores no cableados son `null` y el
  panel lo dice con palabras.
- Otros dos blockers corregidos: las citas por origen se agrupaban por `startAt` (o sea, "las que ya
  se celebraron", dejando fuera las que el bot agendó para la semana siguiente) y el estado vacío
  pintaba la clave i18n cruda por llamar a `t('description')` sin su parámetro — el estado que ve
  toda clínica sin bot el día del deploy.
- Criterios de agregación y el umbral de privacidad, en [[notas/2026-09-11-dashboard-actividad-bot]].
## 2026-09-11 — S26: el contexto de la FSM se conserva por defecto
- `carryFlowContext` sustituye a la reconstrucción campo a campo de `flowData` en los dos
  re-ofrecimientos de horarios y en `advanceToSlot`.
- **La polaridad es el punto**: conserva todo y descarta solo una lista explícita de campos
  atados al paso actual (`startAtISO`, `offeredSlots`, `choices`, contadores…). Al revés —
  enumerar lo que se conserva — fue lo que perdió `rescheduleOf` en B5 y dejaba al paciente con
  dos citas. Nada falló entonces: ni el compilador, porque todos los campos son opcionales, ni los
  tests, porque ninguno cubría "re-listar horarios en mitad de un reagendado".
- De paso arregla un caso latente: una lista de "cualquier profesional" dejaba `anyProfessional`
  y sus ids pegados a la lista siguiente aunque ya fuera de un profesional concreto.
- El bot pasa a distinguir los dos 409 de `rescheduleAppointment` por **tipo**
  (`RescheduleLimitExceededException`, S25) en vez de por el texto del mensaje. Los tests también:
  reescribir el copy ya no puede romper la lógica en silencio.

## 2026-09-11 — M5: memoria conversacional para el RAG
- El bot manda al RAG los últimos 3 pares IN/OUT de ESA conversación, del más viejo al más nuevo,
  con tope de 600 caracteres. Sin esto, "¿y los sábados?" tras preguntar por horarios no significa
  nada: cada mensaje se clasificaba aislado.
- Al recortar se descartan los mensajes **más antiguos**: lo último que se dijo es lo que da
  sentido a la pregunta actual.
- **El contexto es lo único del prompt que escribe el paciente**, así que va en su propio bloque
  `--- CONTEXTO ---`, saneado igual que las fuentes (`---` → U+2010), y el system prompt dice
  explícitamente que es solo para resolver referencias y que un dato que aparezca solo ahí no
  vale. Sin eso, bastaría con escribir "la limpieza es gratis" y preguntar el precio dos mensajes
  después. Hay un test con ese ataque exacto.
- Sin PII nueva: son mensajes que ya viven en `Message`, de la misma conversación.
- La otra mitad de M5 —pasar el contexto al clasificador— va en M3-b, que depende de M3-a.
## 2026-09-11 — M7: el handoff deja de mentir y ya no es un callejón sin salida
- **Expectativa real**: "Enseguida te atiende una persona" a las 22:00 de un sábado es mentira, y
  una que el paciente descubre esperando. Fuera del horario de `BusinessHour` el bot dice cuándo
  responden, con el mismo texto que el bloque de hechos del RAG. Sin horario cargado, mensaje
  genérico: no prometemos un horario que nadie configuró.
- **Retorno automático**: `NEEDS_HUMAN` silenciaba al bot hasta que alguien liberara la
  conversación desde el panel. Una derivación un viernes a las 21:00 se quedaba muda hasta el
  lunes. Nueva cola `handoff-timeout`: a las 4 h, si nadie la tomó, avisa al paciente y devuelve
  el control al bot, que al menos puede agendar.
- El worker es **no-op si el estado ya no es `NEEDS_HUMAN`**, así que liberar desde el panel no
  necesita cancelar el job: el estado en DB es la única fuente de verdad y un job tardío no puede
  pisar una conversación que ya está en manos de una persona.
- El estado va también en el `where` del update, para no pisar a quien la tomó entre la lectura y
  la escritura.
- Se devuelve el control **antes** de mandar el aviso: si el `sendText` falla, la conversación no
  puede quedarse muda para siempre por un error de red.
- El formateo del horario se extrae a `common/business-hours.util.ts`, compartido con
  `ClinicFactsService`. Dos redacciones distintas del mismo horario en la misma conversación
  serían peor que no darlo.

## 2026-09-11 — B7: el bot habla el idioma de la clínica
- Todo el copy del bot y de los dos processors sale ahora de `bot/bot.messages.ts`, un
  `Record<BotLocale, BotCopy>`. **Si falta una clave en `pt`, no compila** — la única forma de que
  no vuelva a quedar a medias.
- Antes `clinic.locale` solo cambiaba el formato de las fechas: una clínica `pt` recibía un bot en
  español con las fechas en portugués.
- **El matching es es + pt a la vez, no por idioma.** Entender de más no hace daño, y si el
  `locale` está mal configurado el bot responde en el idioma equivocado (recuperable) en vez de
  dejar de entender a sus pacientes (no recuperable).
- El acoplamiento que importa: el copy pt dice "Responda *SIM*" y el parser tiene que entender
  `sim`. Traducir el mensaje sin traducir las palabras clave haría que el paciente hiciera
  exactamente lo que le pedimos y el bot no lo entendiera. Hay un test que fija esa correspondencia.
- El override por tenant gana sobre el idioma: no traducimos lo que escribió un operador.
- Detalle en [[notas/2026-09-11-bot-copy-es-pt]].
## 2026-09-11 — P0 del bot · B4: mensajes sin texto no llegan al bot
- PR A2 del reparto [[planes/2026-09-11-p0-bot-reparto]]. Antes, una nota de voz entraba a
  `BotService.handleIncoming` con `text: ''` y terminaba en el fallback genérico (o gastando LLM).
- Ahora `WebhookController` los detecta por `payload.type` / `_data.type` / `hasMedia` / `body` vacío,
  los registra en la bandeja (`Conversation` + `Message IN` con `[audio]`, `[imagen]`, `[sticker]`,
  `[ubicación]`, `[archivo]`, `[contacto]`, `[video]`) y responde una vez cada 6 h
  "Por ahora solo puedo leer mensajes de texto…". Sin LLM.
- Decisiones no obvias en [[notas/2026-09-11-waha-mensajes-sin-texto]]: throttle fail-closed
  (al revés que el dedup), el registro se hace aunque la conversación esté en `HUMAN`, y el pie de
  foto de una imagen se conserva (truncado a 500) detrás de la etiqueta.
- **Dos blockers salidos de `code-reviewer` + `security-auditor`, corregidos antes del PR**:
  (1) el camino nuevo se saltaba las dos capas de rate-limit del [[adr/0007-rate-limit-bot]],
  porque viven dentro de `BotService.handleIncoming` — ahora `withinRateLimit` reusa las mismas
  claves de Redis para compartir presupuesto; (2) `MEDIA_LABELS[type]` con `type: "constructor"`
  devolvía algo de `Object.prototype` y provocaba 500 + reintento infinito de WAHA — ahora va con
  `Object.hasOwn`. También: se ignoran reacciones y eventos de sistema, se cortan grupos y
  estados (`@g.us`, `status@broadcast`), un `type: chat` con texto va al bot aunque marque
  `hasMedia`, y el aviso pasó a best-effort (no relanza; libera el throttle).
- Pendientes anotados en la nota, no hechos aquí: escalar a `NEEDS_HUMAN` tras varios adjuntos
  (decisión de producto), hashear el `chatId` en las claves de Redis (junto con las de `bot:msg:`)
  y una columna `kind` en `Message` para no concatenar etiqueta y contenido.
- **PR A3 (S2, decisión del owner)**: el segundo adjunto seguido sin texto en medio pasa la
  conversación a `NEEDS_HUMAN`, limpia la FSM y responde "Te paso con una persona del equipo para
  escucharte." Contador `bot:media-count:{clinicId}:{chatId}` con ventana de 24 h, que un mensaje de
  texto borra. Antes, el hilo se quedaba en `BOT` y no entraba en el filtro de triaje del panel: un
  paciente que solo mandaba notas de voz recibía un aviso cada 6 h y nadie lo atendía. La
  transcripción de audio queda en backlog como M10.

## 2026-09-11 (noche) — Recuperado el handoff por audios seguidos, que nunca llegó a main
- El PR de S2 (derivar a una persona tras dos adjuntos seguidos) figuraba MERGED pero sus commits
  se quedaron en la rama base: estaba apilado sobre el PR de B4, y B4 entró en `main` antes de que
  el apilado aterrizara en esa rama. Verificado: `mediaLabel` sí estaba en main, `MEDIA_HANDOFF` no.
- Efecto real en producción: un paciente que mandaba dos notas de voz seguidas recibía el aviso de
  "solo leo texto" y nada más; nunca acababa derivado a una persona.
- Recuperado con cherry-pick sobre `main` actual, adaptando dos conflictos: se descartó la
  reintroducción de `PER_CHAT_LIMIT`/`PER_CLINIC_HOURLY_LIMIT` en el controller (desde S1 viven en
  `bot-rate-limit.ts`) y el reset de la racha se movió antes del encolado en `bot-inbound`.
- **Añadido al recuperarlo**: el handoff ahora viaja como `handoff: true` en el evento `bot.turn`,
  así que es la primera derivación que alimenta la tasa del dashboard de M9-b — que hasta ahora
  salía en `null` porque nadie escribía ese contador.
- Es la tercera vez en el día que `main` queda en un estado que no compila o al que le falta código
  mergeado. Propuesta sobre la mesa: que CI compile el *merge result* y exigir la rama al día.
## 2026-09-11 — P1 · S4: `Feedback` admitía filas cruzadas entre clínicas
- `FollowUpsService.recordFeedback` escribía `clinicId` y `appointmentId` sin comprobar que fueran
  juntos. `Feedback` tiene FKs separadas a `Clinic` y `Appointment`, así que la base lo permite, y el
  `appointmentId` viene de `Conversation.flowData` (JSON durable), no de la request. Doble daño: el
  panel de una clínica leería el comentario en texto libre de un paciente de otra
  (`@@index([clinicId, respondedAt])`), y como `appointmentId` es `@unique`, la clínica legítima ya
  no podría registrar nunca el feedback real de esa cita.
- Ahora valida con `appointment.findFirst({ id, clinicId })` antes de escribir, y ante un cruce
  devuelve `created: false` con log de `error` en vez de lanzar (el caller es el webhook: un 500 ahí
  es un bucle de reintentos de WAHA sobre un `flowData` que no se arregla solo).
- **Segundo agujero, sin cerrar todavía**: `bot.service.ts` (`handleAwaitingNpsComment`) hace
  `feedback.update({ where: { appointmentId } })` sin `clinicId`, y ese sí *sobrescribe* texto de un
  paciente de otra clínica. No se puede arreglar en el sitio porque `update` exige un `where` único.
  Queda `FollowUpsService.recordComment` (con `updateMany`, que sí acepta `where` compuesto) listo
  para que la sesión dueña de `bot.service.ts` lo cablee en una línea. Detalle en
  [[notas/2026-09-11-feedback-cross-tenant]].
- El `security-auditor` no encontró blockers, pero sí que la justificación de `updateMany` que
  escribí era **falsa**: con `extendedWhereUnique` (GA desde Prisma 5.0) `update` sí admite el
  filtro por `clinicId`. El motivo real es que `update` lanza P2025 sin match y eso es un 500 en el
  webhook. Corregido en el comentario, en el nombre del test y en la nota.
- También salió del audit: el guard de idempotencia de `scheduleForAppointment` leía sin `clinicId`
  (una fila envenenada dejaba a la clínica legítima sin prompt), y el catch de `recordFeedback` ahora
  cubre P2003/P2025 además de P2002. Pendientes anotados: FK compuesta
  `Feedback → Appointment(clinicId, id)` con migración y ADR propio, y el `include` de
  `feedback.controller.ts`, que sigue el `appointmentId` hasta `patient.name` sin revalidar tenant.

## 2026-09-11 — El comentario del feedback también se escribe con `clinicId`
- `handleAwaitingNpsComment` hacía `prisma.feedback.update({ where: { appointmentId } })` sin
  `clinicId`: si `flowData.feedbackAppointmentId` quedaba con una cita de otra clínica, el bot
  pisaba el comentario de esa fila. Ahora usa `FollowUpsService.recordComment(clinicId, …)`, que
  filtra por las dos columnas (lo dejó listo S4, PR #50).
- Alcance real: `flowData` lo escribe el processor de follow-ups para esa conversación, no el
  paciente, así que no era explotable desde WhatsApp. Es defensa en profundidad, misma clase que
  S4 — pero el `update` por id suelto es exactamente el patrón que la convención del repo prohíbe.
- Con 0 filas afectadas el bot cierra igual y agradece: el paciente no debe enterarse de un
  problema de datos nuestro. Queda el `logger.warn` de `recordComment` para verlo en observabilidad.

## 2026-09-11 — M3-b: intenciones nuevas y contexto al clasificador
- `AGRADECER` cierra con cortesía (mismo pool que el cierre determinista), sin RAG ni handoff.
- `CONSULTA_CITA` ("¿cuándo es mi cita?") responde **desde la BD**, no desde el RAG: la respuesta
  está en `Appointment`, y mandarla al RAG era pedirle al LLM que adivinara un dato que tenemos.
  Incluye el link de gestión, para que no tenga que volver a escribir.
- El historial de la conversación va ahora **al clasificador además de al RAG**, con una sola
  lectura de `Message` para los dos. `IntentService` ya lo trata como texto no confiable (M3-a),
  igual que `knowledge.service.ts`.
- `buildConversationContext` pasa a devolver `string[]`: es lo que espera el clasificador, y el
  RAG lo une. Antes devolvía el string ya unido y habría hecho falta partirlo.

## 2026-09-11 (noche) — S28: norma de test contra el redactor real de pino
- `common/logger/testing/redaction-harness.ts` + `redaction-events.spec.ts`: todos los eventos
  estructurados del backend (`bot.turn` y los siete `waha.*`) pasan por el redactor real de pino y
  se comprueba que llegan enteros.
- Sale del blocker de M9-a: el campo `reason` de `bot.turn` salía como `[REDACTED]` en producción
  porque `nestjs-pino` vuelca el objeto en la raíz del entry, y ningún test lo veía porque espían el
  logger de Nest, que corre antes de la redacción. Verde en CI, ciego en el destino.
- El arnés trae sus propios tests negativos (un campo `name`, uno `reason`, uno anidado), porque un
  test de seguridad que no falla cuando debe es una tranquilidad falsa.
- El mensaje de fallo avisa de no renombrar a ciegas: si el campo está en `PII_REDACT_PATHS` es
  porque ahí suele haber PII, así que la redacción podía estar tapando una fuga y renombrar sin
  mirar la convierte en real. Es exactamente lo que pasó con `reason`.
- Comprobado de paso que ninguno de los `waha.*` colisiona hoy. `name` sí está en la lista, por si
  alguien lo usa como campo de evento.
## 2026-09-11 — S29: esperando a una persona, el bot se calla
- Con `Conversation.state = NEEDS_HUMAN` el bot ya no clasifica ni responde. El mensaje entrante
  **sí** se registra: es lo que verá quien atienda desde la bandeja.
- Antes seguía respondiendo mientras el paciente esperaba —pidió una persona y le seguía hablando
  un robot—, y con el retorno automático de M7 encima recibía respuestas del bot **y** un aviso a
  las 4 h diciendo que nadie le había contestado.
- Un aviso cada 4 h como mucho (`SET NX` en Redis por conversación): quien espera suele escribir
  varias veces, y repetir "ya avisé al equipo" en cada mensaje es ruido.
- **Fail-closed**: si Redis no responde, no se avisa. El coste de callar es un mensaje menos —el
  paciente ya sabe que está esperando—; el de avisar sería repetirle lo mismo en cada mensaje.
- **`CANCELAR` explícito se sigue atendiendo.** Hacerle esperar a una persona para liberar un turno
  va justo en contra de lo único que este producto existe para conseguir.
