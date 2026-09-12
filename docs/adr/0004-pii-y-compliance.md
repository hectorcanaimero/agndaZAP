# ADR 0004 — PII, PHI y compliance para MVP/piloto

- Fecha: 2026-08-08
- Estado: aceptado (piloto)
- Relacionados: [[0003-rate-limit-casero-vs-throttler]], [[../notas/2026-08-08-bloque-3-pagina-publica]]

## Contexto

AgendaZap opera en el rubro salud. Los datos que ingresan por el endpoint
público `/api/public/clinics/:slug/appointments` y por el bot de WhatsApp
son **PII de salud (PHI)** según los frameworks aplicables:

- **Nombre completo del paciente**: PII básico.
- **Teléfono E.164**: PII básico + identificador único fuerte.
- **`notes` (motivo de la consulta)**: PHI — puede contener "dolor en pecho",
  "consulta ginecológica", "control de VIH", etc.
- **Combinación de todo lo anterior con la clínica (`clinicId`)**: contexto
  clínico que agrava la sensibilidad.

Marcos regulatorios de referencia:
- Brasil (LGPD, ANPD): datos de salud son **dados pessoais sensíveis** (art.5, II).
  Requieren consentimiento específico + medidas técnicas adecuadas.
- UE (GDPR art.9): datos de salud son "categoría especial", requieren base legal
  explícita + evaluación de impacto (DPIA) para procesamientos a escala.
- Venezuela / otros LATAM: sin marco específico equivalente, pero el estándar
  de facto para B2B con clínicas se alinea con LGPD/GDPR.

Este ADR documenta qué medidas **NO están implementadas** al cierre del Bloque 3
(código listo para piloto) y por qué son riesgo aceptado hasta la iteración
post-piloto.

## Decisiones para MVP/piloto

### 1. `notes` sin cifrado at-rest

**Estado**: `notes` se guarda como `TEXT` en Postgres sin cifrado a nivel columna.

**Racional**:
- Para el piloto (1 clínica, ~50 pacientes/semana) el volumen no justifica el
  overhead operativo de gestionar claves con `pgcrypto` o KMS externo.
- Postgres está detrás de una VPC / firewall (docker-compose local en dev; en
  prod, Supabase Managed Postgres con transporte TLS y at-rest cifrado por default
  a nivel disco).
- No hay backups exportados sin cifrar a S3 público, etc.

**Riesgo residual**:
- Backup snapshot filtrado → PHI en claro. Mitigación operativa: backups
  cifrados en Supabase.
- Insider con acceso a DB (nosotros dev, el team de Supabase). Mitigación:
  auditoría de acceso + política de que sólo el equipo de infra tiene creds prod.

**Deuda para post-piloto**:
- Evaluar `pgcrypto` con clave por-clínica (tenant-encrypted), o cifrado
  aplicación-side con envelope encryption (KMS + DEK por clínica).
- Issue de seguimiento: `docs/notas/2026-08-08-bloque-3-pagina-publica.md`
  sección "Preguntas abiertas".

### 2. Consent sin trazabilidad completa

**Estado**: `Patient.consent: boolean` (true/false). No guardamos:
- IP desde donde se dio el consent.
- Timestamp del consent.
- Versión del texto legal aceptado.

**Racional**:
- Para el piloto, el consent se documenta contractualmente entre AgendaZap y
  la clínica (acuerdo de responsabilidad conjunta). La clínica es responsable
  de mostrar el texto adecuado en el form y a los pacientes que agenden por
  WhatsApp.
- El botón "consent" del formulario público sí muestra el texto ("Autorizo el
  uso de mis datos para gestionar la cita.") — el paciente ve y acepta antes
  de submitir.

**Riesgo residual**:
- Si un paciente disputa el consent, sólo tenemos el `boolean` en DB. No
  podemos probar "cuándo y desde dónde lo dio". En jurisdicciones LGPD/GDPR
  la carga de la prueba está en el operador (AgendaZap + clínica).

**Deuda para post-piloto**:
- Modelo `ConsentEvent`: `(patientId, ip, userAgentHash, textVersion, acceptedAt)`.
- Versionar los textos legales (ES/PT) con `consent-v1.md`, `consent-v2.md`
  en `docs/legal/`.

### 3. Rate-limit sólo por `slug+ip`

**Estado**: `RateLimit(N)` guard con clave `ratelimit:{slug}:{ip}:{bucket}`.
No hay una **segunda capa global por IP** que corra antes.

**Racional**:
- El attacker vector "yo controlo N slugs" es bajo — los slugs no son públicos
  fuera del contexto de cada clínica.
- El honeypot cubre bots ingenuos que no ejecutan JS.
- Fixed window es barato (1 INCR + 1 EXPIRE).

**Riesgo residual**:
- Un atacante que enumere slugs (`clinica-a`, `dr-perez`, etc.) puede quemar
  cupo IP contra cada uno independientemente. Con 100 slugs y 5/min por
  combinación, tendría 500 req/min por IP.
- No hay rate-limit por IP-only (sin slug), lo cual permitiría DoS liviano
  contra el endpoint 404-slug si un atacante spamea slugs random.

**Deuda para post-piloto**:
- Capa 1: `ratelimit:ip:{ip}:{bucket}` → 60/min global por IP.
- Capa 2: la existente `slug+ip`.
- Alerta operativa a Slack cuando alguna IP supera N req/min sostenido.

### 4. Sin CAPTCHA (Turnstile)

**Estado**: honeypot invisible + rate-limit. Sin Cloudflare Turnstile ni
similar.

**Racional**:
- Cero fricción para el usuario legítimo — Turnstile es passive pero agrega
  latencia y un widget más.
- El honeypot descarta ~95% de bots ingenuos.
- Los bots sofisticados que ejecutan JS y evaden honeypot ya no son el 80%
  del volumen malicioso hoy.

**Deuda para post-piloto**:
- Turnstile como opt-in por clínica (`clinic.turnstileSiteKey`, `.secretKey`
  cifrado). Config del panel admin.
- Fallback a hCaptcha si Turnstile no está disponible.

### 5. Zero PII en logs (implementado)

**Estado**: **implementado y verificado**. Logs sólo tienen:
- IP + slug + status del rate-limit.
- `apptId + status` en éxito del POST.
- Nunca `phone`, `name`, `notes`.

Esto NO es deuda, se documenta para trazabilidad.

### 6. Response del POST sin PII (implementado)

**Estado**: `POST /appointments` devuelve `{ id, startAt, endAt, status }`. No
incluye `patient.{name,phone}` (removido en el Bloque 3 post-review).

El frontend usa su propio state para el mensaje de "gracias" — el nombre viaja
por sessionStorage (NO por query string, para evitar quedar en Referer +
historial + logs de CDN).

Esto NO es deuda, se documenta para trazabilidad.

### §7. Consent para procesamiento con IA de terceros (agregado 2026-08-09)

**Contexto**: el flujo `Intent.PREGUNTA_FAQ` del bot envía la pregunta del
paciente CRUDA a servicios externos:

1. **OpenAI** — embedding (`text-embedding-3-small`) para RAG search.
2. **DeepSeek** — LLM synthesis primaria (respuesta final al paciente).
3. **Gemini** — LLM synthesis fallback si DeepSeek falla.

Además, `IntentService` (en `handleIncoming`) detecta la intención del
mensaje también via DeepSeek + fallback Gemini. En total, un mensaje
`PREGUNTA_FAQ` puede ir a **3 proveedores externos distintos**.

**Decisión (MVP)**: el `Patient.consent boolean` debe cubrir esto EXPLÍCITAMENTE
en el texto que el paciente acepta. Sin este consent explícito, no podemos
enviar el mensaje a los proveedores externos → el bot debe hacer handoff a
humano sin invocar al LLM.

**Copy actualizado (agregar al form público y al primer mensaje del bot en
clínica nueva)**:

> "Al usar este canal, autorizás que tus mensajes se procesen con servicios
> de IA (OpenAI, DeepSeek, Google) para responder consultas y agendar citas.
> No se comparten con terceros para publicidad."

**Deuda para post-piloto**:
- Registrar en tabla `ConsentEvent (id, patientId, ip, userAgent, version,
  createdAt)` cada evento de aceptación, incluyendo la versión del texto legal
  vigente (para poder demostrar QUÉ aceptó el paciente en cada momento).
- Opt-out por clínica: `clinic.aiConsentEnabled: boolean` — algunas clínicas
  (ginecología, psiquiatría, otras verticales sensibles) pueden preferir NO
  usar IA para evitar la exposición del contenido a terceros. Sin AI, el bot
  cae a un flujo determinista + handoff a humano en toda pregunta libre.
- Sanitización PII pre-envío al LLM: regex para reemplazar teléfonos, cédulas
  y direcciones antes de llamar a OpenAI/DeepSeek/Gemini. Alternativa fuerte:
  LLM self-hosted (Llama 3 o similar) sobre GPU en el server → cero PII sale
  del perímetro. Costoso pero necesario para GDPR estricto post-piloto.

**Riesgo residual (MVP)**:
- Si un paciente no leyó el consent y descubre después que su pregunta
  ("tengo hemorroides, ¿tienen proctólogo?") fue procesada por OpenAI +
  DeepSeek, puede pedir borrado bajo LGPD art.18. No tenemos mecanismo
  técnico para pedir borrado a esos proveedores (sí tenemos DPA firmado con
  OpenAI, pero el paciente no).
- Mitigación operativa: la clínica-piloto firma el acuerdo de responsabilidad
  conjunta declarando este flujo; el consent del form incluye el texto de
  arriba; y en caso de solicitud, escalamos manualmente a OpenAI/DeepSeek
  (proceso de <30 días).

Fecha decisión: 2026-08-09.

## Consecuencias

- **Para el piloto (1 clínica)**: firmamos con la clínica un acuerdo de
  responsabilidad conjunta que explicita las brechas técnicas anteriores y
  compromete a AgendaZap a cerrar las deudas antes de escalar a >5 clínicas.
- **Para producción escalada (≥10 clínicas)**: este ADR se actualiza con las
  medidas ejecutadas (probablemente supersedido por `0005-…` cuando se cierre
  la mayor parte).
- **Para auditorías externas**: este documento es el punto de partida — resume
  el estado real, no el estado deseado.

## Alternativas descartadas

- **Cifrado app-side con AES-GCM y clave hardcodeada**: seguridad teatral.
  Peor que no tener nada porque da falsa confianza.
- **Bloquear el go-live hasta cerrar TODA la deuda**: mata el piloto. Sin
  producto en el mundo no aprendemos qué medidas realmente importan a la
  primera clínica.
- **Log everything y filtrar en post-proceso**: contradice zero-trust y multiplica
  el blast radius de un incidente.

## Seguimiento

Cada item de deuda debe:
1. Tener issue abierta en el tracker (Plane / Notion).
2. Al cerrar, actualizar la sección correspondiente de este ADR con
   `**Estado (YYYY-MM-DD)**: cerrado — ver commit / PR / migración`.

### §7.1 Copy del aviso en el bot (actualizado 2026-09-10)

El saludo del bot de WhatsApp ya **no** lista los proveedores de IA. El
`AI_DISCLOSURE` que se concatena a todo greeting quedó en una línea:

> "Soy un asistente automático. Si prefieres hablar con una persona, escribe *humano*."

Motivo: el consentimiento explícito con la lista de proveedores (DeepSeek,
Google, OpenAI) ya se recoge en el form público (`publicSchedule.consent`) y en
la política de privacidad; repetirlo en el primer mensaje del bot pesaba tanto
como el saludo y generaba desconfianza sin aportar garantía legal adicional.
El texto legal completo sigue siendo el de §7.

Además, todos los textos que ven pacientes van en **español latinoamericano
neutro (tuteo)**, nunca voseo. Ver [[notas/2026-09-10-tono-espanol-neutro]].

### §7.2 Notas de voz: transcripción con IA y no retención del audio (agregado 2026-09-12)

**Contexto**: [[notas/2026-09-11-exploracion-stt-notas-de-voz]] evalúa transcribir
las notas de voz que llegan por WhatsApp (hoy reciben *"Por ahora solo puedo leer
mensajes de texto"*) y recomienda un plan de 3 PRs:

1. **PR 1** (#98, `feat/waha-media-storage`, **ya en `main`, pendiente de
   desplegar en Coolify**): que WAHA descargue el audio. Fija
   `WHATSAPP_FILES_LIFETIME=900` (15 min) explícito en
   los tres compose — ni el default de WAHA (180 s, muy corto para la cola de
   transcripción) ni `0` (retención indefinida de audio de pacientes, PHI sin
   política ni cifrado at-rest, ver §1). A los 15 minutos WAHA borra el fichero
   por su cuenta, sin intervención del backend.
2. **PR 2** (#99, `feat/stt-notas-de-voz`, **ya en `main`**): `SttService`
   transcribe con `gpt-4o-mini-transcribe` de OpenAI y descarta el fichero
   apenas obtiene el texto — no espera a que WAHA lo borre, lo hace de
   inmediato. **Todavía sin cablear a `bot.service.ts`/`webhook.controller.ts`**:
   el servicio y sus tests existen, pero nadie lo invoca aún desde el flujo del
   bot (ver `docs/notas/2026-09-12-stt-descarga-segura.md`).
3. **PR 3** (esta sección; rama `feat/consent-notas-de-voz-ia`): el copy que
   describe lo anterior.

**Orden de encendido, no solo de merge**: el propio PR 2 marca esto como
bloqueante — el texto vigente antes de esta sección decía que "tus mensajes"
se procesan con IA, y mandar **grabaciones** es un salto que ese texto no
cubría; cablear PR 2 antes de que este PR 3 esté en `main` abriría una ventana
real (no solo teórica) en la que se envían notas de voz de pacientes a OpenAI
bajo un consent que solo habla de texto. Por eso PR 3 se mergea **antes** de
cablear PR 2 al bot, no simplemente "después de que PR 2 exista": el orden que
importa es el de qué corre en producción, no el de qué PR se abrió primero.
Si el cableado necesita salir antes de que este PR llegue a producción (deploy
en Coolify), debe ir detrás de un flag por clínica apagado por defecto —
recomendación del propio PR 2, decisión del owner.

4. **PR 4** (`feat/stt-cableado`): el cableado. Ver
   [[notas/2026-09-12-stt-cableado-notas-de-voz]].

**Cómo se cumple este consent en el código** (PR 4):

- `STT_ENABLED` apagado por defecto. Se comprueba al encolar **y** al procesar:
  apagarlo tiene que parar también los jobs ya encolados y cualquier `retry`
  desde el panel de BullMQ, o no sirve para responder a un incidente.
- El aviso `voiceNoteFirstTime` se envía **antes** de que el audio salga hacia
  OpenAI, y si no se puede enviar **no se transcribe**: se deriva a una persona.
- La prueba de que se avisó es `Conversation.voiceConsentAt` +
  `voiceConsentVersion`, columnas propias. No vale un `Message OUT` con el texto
  del aviso: `BotService.reply` persiste la respuesta del LLM verbatim y el copy
  es público, así que una inyección de prompt puede plantar una fila idéntica
  sin que el aviso se haya mandado nunca — y desde la bandeja del panel se puede
  escribir a mano. Una prueba que el sistema puede fabricar no se puede enseñar.
  La versión se guarda para que un cambio sustantivo del texto vuelva a avisar.
- Con la conversación en `HUMAN` no se transcribe: la grabación no sale hacia un
  tercero para que la lea alguien que ya está leyendo el hilo.

**Dónde vive el PHI de una nota de voz** (completa el inventario de §1): el
fichero, en WAHA, hasta 900 s; el **texto** transcrito, en `Message.body` como
cualquier mensaje; y, mientras el job está en cola, la URL del media y la
transcripción viajan en `job.data` **en Redis** (sin cifrado at-rest), acotadas
por `removeOnComplete: 900 s` / `removeOnFail: 900 s` para los jobs de audio.
Esa retención corta es deliberada y es la razón de que las opciones de audio no
reusen las de texto. El audio **nunca** se guarda en nuestra base de datos.

**Por qué no Deepgram** (evaluado y descartado en la nota de exploración): mejor
tecnología de audio de las tres comparadas, pero exigiría sumar un cuarto
proveedor a la lista que el paciente ya aceptó (`OpenAI, DeepSeek, Google`) sin
que su ventaja — latencia de streaming — aplique a un audio que llega entero.
OpenAI ya está en el consent (lo usamos para embeddings del RAG): cero
superficie legal nueva.

**Decisión**: transcribir y no guardar el audio, con redundancia en dos capas —
WAHA lo borra solo a los 15 minutos (PR 1) y el backend lo descarta apenas
transcribe (PR 2). No es solo intención de diseño: el texto de consent puede
afirmarlo con precisión ("el archivo se elimina en minutos") porque está
forzado por configuración en ambas capas, no solo por costumbre del código.

**Copy actualizado — versión 2 del texto de §7** (agregado a `form.labels.consent`,
`legal.privacy.sections.data.items.voice`, `legal.privacy.sections.sharing.items.ai`
y `legal.privacy.sections.changes.body` en `apps/web/messages/{es,pt}.json`, y a
`BotCopy.voiceNoteFirstTime` en `apps/backend/src/bot/bot.messages.ts` — mensaje
que el bot manda la primera vez que un paciente envía una nota de voz):

> "Las notas de voz se transcriben automáticamente con inteligencia artificial
> (OpenAI). No guardamos el audio: el archivo se elimina en minutos: lo hace el
> propio proveedor de WhatsApp automáticamente, y el backend lo descarta apenas
> obtiene el texto."

La versión 1 (2026-08-09, §7 arriba) sigue vigente para el resto del texto: esta
versión 2 la extiende, no la reemplaza.

**Deuda que esto NO cierra** (sigue igual que §7): `ConsentEvent` con versión e
IP no existe todavía, así que seguimos sin poder demostrar qué versión del texto
aceptó cada paciente — solo el `boolean`. Cuando esa tabla exista, esta sección
es la referencia de qué dice "versión 2".

**Riesgo residual**: hasta que #98 (PR 1) se despliegue en Coolify, `WAHA_MEDIA_STORAGE`
no está configurado y WAHA sigue sin descargar el audio (`media: null`); y hasta
que alguien cablee `SttService` (PR 2, ya en `main` pero sin invocar) a
`bot.service.ts`/`webhook.controller.ts`, el aviso al paciente sigue siendo
*"Por ahora solo puedo leer mensajes de texto"* y el copy de esta sección no
cambia de comportamiento real. Ese cableado es intencionalmente **otro PR**, no
parte de este: PR 3 solo deja el texto listo para cuando ese cableado exista.
