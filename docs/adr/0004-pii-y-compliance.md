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
