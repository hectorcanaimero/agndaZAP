# RESUMEN-finalizacion.md — Consolidación de auditoría F1 (pre-lanzamiento 40 clínicas)

**Task:** F1.8.T1 — Consolidar findings de F1.1–F1.7, deduplicar, ordenar por severidad
(P0 → P1 → P2) y emitir juicio go/no-go para el canary de 40 clínicas.

**Fecha:** 2026-08-22
**Fuentes:** `docs/auditoria/F1.*.md` (10 reportes en disco) + resultados de las 13 tasks
cuyo reporte markdown no se persistió (recuperados de `orchestrator/state/logs/*.codex.json`
y `*.log`). Ver §6 "Cobertura de fuentes".

**Contadores deduplicados:** **3 P0 · 12 P1 · 25 P2** (40 hallazgos únicos).

---

## 1. Juicio global — GO / NO-GO

**Veredicto: NO-GO en el estado actual, con camino corto y claro a GO condicional.**

El sistema está **notablemente más sólido de lo que sugiere el número de hallazgos**: el
modelo multi-tenant es correcto (deny-by-default, `tenantWhere` único, escape-hatch
`?clinicId=` eliminado), el webhook tiene HMAC fail-closed bien testeado, el redactor de
PII y la convención "loguear sólo IDs" se cumplen, la FSM del bot es determinista antes del
LLM, y el happy path de onboarding (crear clínica → invitar → aceptar → escanear QR) está
completo y funcional. **No hay ninguna fuga de PHI cross-tenant explotable hoy** (el único
cross-tenant encontrado es un side-channel de ocupación, P2).

Lo que impide el GO son **dos P0 de código/infra que rompen el core o la observabilidad** y
un **subconjunto de P1 que toca el happy path o la seguridad**:

- **Bloqueantes reales (P0):**
  1. **Herencia de `BusinessHour` rota** (F1.2.T1) — el motor de disponibilidad devuelve la
     *unión* de horarios de profesional y clínica en vez del override. Un profesional que
     defina su propio horario recibe ofertas de slots en todo el horario de la clínica. Es
     un bug de **correctitud del core de agendamiento**: rompe el happy path de reserva.
  2. **Faltan `ARG/ENV` de Sentry en `apps/web/Dockerfile`** (F1.6.T2) — Sentry queda
     deshabilitado en el cliente y sin source maps; la observabilidad prometida en ADR 0015
     no se materializa. Fix de infra acotado pero obligatorio.

- **P1 que deben cerrarse antes del GO** (happy path o seguridad/compliance):
  3. Bug de **prefijo de teléfono** (`+` en panel/público vs sin `+` en webhook) — rompe la
     confirmación por WhatsApp de las citas creadas por panel/página pública (F1.7.T3).
  4. **Buffer de descanso** no respetado en citas ocupadas — solapamiento del tiempo de
     limpieza (F1.2.T1).
  5. **Endpoints públicos ignoran `Clinic.status`** — clínica suspendida sigue visible y
     reservable; la palanca de control del operador SaaS es inefectiva (F1.4.T1).
  6. **Sin idempotencia de eventos** en el webhook WAHA (F1.4.T2) + **secretos de webhook
     fuera del fail-fast** de prod (F1.4.T2) — quemar LLM budget / bot que muere en silencio.
  7. **Consent de IA de terceros ausente** (ADR 0004 §7) y **fuga de PHI en log de error de
     WAHA** (F1.4.T3) — compliance LGPD/GDPR y datos de salud.
  8. **JWT de impersonation no re-valida `Clinic.status`** (F1.4.T4) — ventana de 30 min.

- **P0 documental diferible:** la **app Flutter** (`apps/mobile`) es un stub (F1.6.T1). Es
  P0 frente al PRD, pero **no bloquea el canary** porque el panel web responsive cubre la
  operación; se posterga formalmente a una fase posterior.

**Camino a GO:** cerrar los 2 P0 de código/infra + los P1 3–8 de la lista anterior. Estimación
de esfuerzo baja (la mayoría son fixes acotados de 2–20 líneas o config). El resto (SPEC drift
F1.1.T3, wizard de onboarding F1.5.T4, y la deuda P2) puede ir en paralelo o post-GO.

---

## 2. Hallazgos P0 (bloquean el lanzamiento)

- [P0] Herencia de `BusinessHour` devuelve la unión en vez del override — fuga de slots
  - **Gap:** `SPEC.md` §2 exige usar el horario del profesional "o de la clínica si el
    profesional no define horario". Si el profesional define su propio horario, el motor
    devuelve la *unión* de sus horarios con los de la clínica (no descarta los `null`).
  - **Evidencia:** `apps/backend/src/scheduling/availability.service.ts:52-57` y `:103`
    (query `OR: [{ professionalId }, { professionalId: null }]` + loop que no filtra).
  - **Impacto lanzamiento:** bloqueante — un profesional que trabaja pocos días recibe
    ofertas de slots en todo el horario de la clínica.
  - **Artefacto:** `SPEC.md` §2 · `availability.service.ts`.
  - **Recomendación:** tras el `findMany`, si existe al menos un `BusinessHour` con
    `professionalId`, descartar todos los de `professionalId === null`. Fix ~10 líneas.
  - **Origen:** F1.2.T1 (también señalado como "disponibilidad multi-tenant" en F1.1.T1).

- [P0] Faltan `ARG`/`ENV` de Sentry en `apps/web/Dockerfile`
  - **Gap:** los compose definen `NEXT_PUBLIC_SENTRY_*`, `SENTRY_ORG`, `SENTRY_AUTH_TOKEN`
    en `args:`, pero el Dockerfile de Next.js solo declara `ARG NEXT_PUBLIC_API_URL` e ignora
    el resto.
  - **Evidencia:** `apps/web/Dockerfile:30` — sin `ARG`/`ENV` para Sentry antes del build.
  - **Impacto lanzamiento:** crítico — Sentry deshabilitado en el cliente (no se embeebe
    `NEXT_PUBLIC_SENTRY_DSN`) y sin upload de source maps. Observabilidad de frontend = 0.
  - **Artefacto:** ADR 0015 · `apps/web/Dockerfile` · `docker-compose.{prod,coolify}.yml`.
  - **Recomendación:** declarar los `ARG`/`ENV` correspondientes en el stage `build`.
  - **Origen:** F1.6.T2 (bloqueado en esa task por estar fuera de sus archivos permitidos).

- [P0] App Flutter (`apps/mobile`) es un stub — Fase 4 al 0% (diferible al post-piloto)
  - **Gap:** `apps/mobile` solo contiene un `README.md`; no hay `pubspec.yaml`, toolchain
    Dart/Flutter, CI ni código. La Fase 4 de `PRD.md` (app del profesional) no está.
  - **Evidencia:** `apps/mobile/README.md` (stub documentado por F1.6.T1); `docs/PRD.md` §3
    y §9 (marcados pendientes).
  - **Impacto lanzamiento:** P0 frente a PRD §3, **mitigado a P1** para el canary: el panel
    web responsive cubre agenda + confirmar/bloquear desde el móvil. Se posterga.
  - **Artefacto:** `PRD.md` §3/§9 · ADR 0001 · ADR 0011.
  - **Recomendación:** decidir proveedor de push (FCM/Expo/OneSignal) y scoped endpoint
    `PATCH` confirmar/bloquear para `PROFESSIONAL`; recién después codear la app. Fuera del
    alcance del canary.
  - **Origen:** F1.6.T1 (cross-ref F1.1.T1 "push Flutter").

---

## 3. Hallazgos P1 (deben estar antes del GO)

- [P1] Bug de prefijo de teléfono: confirmación por WhatsApp rota para citas de panel/público
  - **Gap:** el webhook guarda `phone` sin `+` (`bareId = from.replace(/@(c.us|lid|...)$/,'')`),
    mientras panel y página pública normalizan a E.164 con `+`. `findUpcomingAppointment`
    matchea por `clinicId_phone` y no encuentra al paciente → la confirmación/recordatorio
    reply no liga con la cita.
  - **Evidencia:** `apps/backend/src/whatsapp/webhook.controller.ts:142-144` (sin `+`) vs
    `apps/backend/src/bot/bot.service.ts:1449-1451` (`clinicId_phone`). Reportado en smoke
    E2E, escenario 4 falla.
  - **Impacto lanzamiento:** rompe la confirmación (core anti no-show) para las citas creadas
    fuera del bot — justamente el canal público nuevo del piloto.
  - **Artefacto:** `SPEC.md` §2 (recordatorios/confirmación) · `webhook.controller.ts` ·
    `bot.service.ts`.
  - **Recomendación:** normalizar `phone` a E.164 en un único punto (o al ingreso del webhook
    o al matchear), y test de regresión con ambos prefijos.
  - **Origen:** F1.7.T3.

- [P1] Endpoints públicos ignoran `Clinic.status` — clínica suspendida sigue visible y reservable
  - **Gap:** `getClinic`/`getAvailability`/`createAppointment` resuelven por `slug` sin filtrar
    `status`. La suspensión (ADR 0014) se enforcea en login e impersonation, no en el flujo público.
  - **Evidencia:** `apps/backend/src/public/public.controller.ts:78-99,149-155,206-212`
    (`findUnique({ where: { slug } })` sin `status`). Campo `status` en `schema.prisma:39`.
  - **Impacto lanzamiento:** una clínica suspendida por impago/abuso sigue captando citas. La
    palanca de control del operador SaaS es inefectiva.
  - **Artefacto:** ADR 0014 · `public.controller.ts`.
  - **Recomendación:** filtrar `status: 'ACTIVE'` (o 404/410 en SUSPENDED/ARCHIVED) en los 3
    endpoints. Cross-ref: revisar que la sesión WAHA de una clínica suspendida deje de responder.
  - **Origen:** F1.4.T1.

- [P1] Sin idempotencia de eventos en el webhook WAHA
  - **Gap:** el controller descarta el `id` del evento de WAHA; un redelivery (timeout entre
    procesado y `200 OK`) se procesa dos veces: `Message` IN duplicado + doble llamada de
    intención (LLM) + re-procesado de FSM.
  - **Evidencia:** `apps/backend/src/whatsapp/webhook.controller.ts:72-161` (sin chequeo de
    replay; `id` tipado pero no usado).
  - **Impacto lanzamiento:** quema LLM budget por duplicado (lo que ADR 0007 busca proteger)
    y bloat de `Message`. La creación de cita está protegida (`@@unique([professionalId,startAt])`),
    el costo de LLM no.
  - **Artefacto:** ADR 0007 · ADR 0017 · `webhook.controller.ts`.
  - **Recomendación:** dedup idempotente: `Message.wahaEventId` `@@unique` o `SETNX
    webhook:event:{id}` con TTL 24h, ANTES de `bot.handleIncoming`.
  - **Origen:** F1.4.T2 (cross-ref F1.1.T1 "idempotencia del webhook").

- [P1] Secretos del webhook fuera del fail-fast de producción
  - **Gap:** `main.ts` valida en prod `DATABASE_URL`, `REDIS_URL`, `JWT_SECRET`, `SENTRY_DSN`…
    pero no `WEBHOOK_HMAC_SECRET`/`WEBHOOK_TOKEN`. Sin ellos, el backend bootea y el webhook
    queda fail-closed (403 a todo) sin señal temprana: el bot muere en silencio.
  - **Evidencia:** `apps/backend/src/main.ts:39-48` (lista `required` sin vars de webhook).
  - **Impacto lanzamiento:** un compose/Coolify mal poblado deja el agendamiento por WhatsApp
    sin recibir mensajes, descubierto recién por pacientes sin respuesta.
  - **Artefacto:** ADR 0017 · `main.ts`.
  - **Recomendación:** fail-fast "al menos uno de `WEBHOOK_HMAC_SECRET`/`WEBHOOK_TOKEN`" (OR).
  - **Origen:** F1.4.T2.

- [P1] Consent de IA de terceros (ADR 0004 §7) ausente del copy que ve el paciente
  - **Gap:** el ADR 0004 §7 exige consent explícito para procesamiento con IA de terceros
    (OpenAI/DeepSeek/Google). El form solo dice "Autorizo el uso de mis datos para gestionar
    la cita" y el greeting del bot no menciona IA ni terceros. Sin ese consent, enviar el
    mensaje del paciente a providers externos carece de base legal LGPD/GDPR (dato sensible).
  - **Evidencia:** `apps/web/messages/es.json:31`/`pt.json:31`; `bot.service.ts:134-139`
    (`DEFAULT_BOT_MESSAGES.greeting`); `knowledge.service.ts:78,410`, `intent.service.ts:31`
    (envío crudo a 3 providers sin gate).
  - **Impacto lanzamiento:** riesgo de denuncia LGPD art.18 sin evidencia de consent
    específico. Datos de salud a terceros.
  - **Artefacto:** ADR 0004 §7 · `messages/{es,pt}.json` · `bot.service.ts`.
  - **Recomendación:** agregar el copy del ADR §7 al checkbox del form (es/pt) y al primer
    mensaje del bot. El mecanismo `ConsentEvent` es deuda post-piloto aparte.
  - **Origen:** F1.4.T3.

- [P1] PHI en logs vía `WahaService.sendText` (viola ADR 0004 §5)
  - **Gap:** ante `!res.ok`, `sendText` loggea el `body` completo de la respuesta de error de
    WAHA, que puede incluir el texto saliente (nombre del paciente, hora, motivo). El redactor
    de Pino no lo cubre porque viaja en el string del mensaje, no como campo estructurado.
  - **Evidencia:** `apps/backend/src/whatsapp/waha.service.ts:38-42`
    (`logger.error(\`WAHA sendText falló (${res.status}): ${body}\`)`).
  - **Impacto lanzamiento:** PHI de pacientes en Axiom/Sentry en path de error. Tipo de dato
    más sensible del producto.
  - **Artefacto:** ADR 0004 §5 · `waha.service.ts`.
  - **Recomendación:** loggear sólo `res.status` + error genérico. Fix de 2 líneas.
  - **Origen:** F1.4.T3 (cross-ref F1.4.T2 que lo señala como P2; acá asciende a P1).

- [P1] JWT de impersonation no se re-valida contra `Clinic.status` tras emitirse
  - **Gap:** el gate "clínica ACTIVE" se aplica solo al emitir el token y en `login()`. En cada
    request, `JwtStrategy.validate` no va a DB y `assertClinicScope` no chequea `status`. Si el
    super suspende una clínica ya impersonada, el token impersonado sigue operando ~30 min.
  - **Evidencia:** `jwt.strategy.ts:61-63` ("No vamos a DB acá"); `impersonation.service.ts:83`
    (ACTIVE solo al emitir); `tenant-context.util.ts` (sin chequeo de status).
  - **Impacto lanzamiento:** la suspensión no corta una sesión de impersonation ya activa;
    blast radius = TTL completo. Afecta el objetivo de la task: "token no usable fuera de contexto".
  - **Artefacto:** ADR 0014 · ADR 0016 · `jwt.strategy.ts`.
  - **Recomendación:** en `JwtStrategy.validate` (o guard), re-chequear `status === 'ACTIVE'`
    cuando haya `clinicId` + `impersonatedBy` (cacheable en Redis por `clinicId`).
  - **Origen:** F1.4.T4.

- [P1] Wizard de onboarding first-time (2026-08-11) implementado pero sin mergear
  - **Gap:** el plan aprobado se implementó completo (migration, `PATCH /clinics/me/onboarding`,
    middleware, 5 steps, Stepper, i18n `onboarding.*`) pero todos los commits viven en
    `feature/onboarding-wizard`, no en `main`/`staged` (HEAD desplegable).
  - **Evidencia:** `git branch --contains` → solo `feature/onboarding-wizard`; `schema.prisma`
    sin `onboardingCompletedAt`; `middleware.ts` sin regla; sin directorio `[locale]/onboarding`.
  - **Impacto lanzamiento:** el time-to-activation self-service no está disponible; el admin
    nuevo aterriza en dashboard vacío. El flujo manual (runbook) cubre el canary, así que no
    bloquea, pero es una feature terminada fuera del release.
  - **Artefacto:** `docs/notas/2026-08-11-onboarding-wizard.md` · `docs/onboarding-clinica.md`.
  - **Recomendación:** mergear `feature/onboarding-wizard` sobre `staged` (rebase + review) o
    documentar la postergación formal.
  - **Origen:** F1.5.T4.

- [P1] Buffer de limpieza/descanso no se respeta en las citas *ya ocupadas*
  - **Gap:** el motor suma `durationMin + bufferMin` al iterar slots libres (paso de iteración),
    pero ignora el `bufferMin` de las citas ya ocupadas al evaluar solapamientos. Un slot libre
    generado puede pisar el tiempo de limpieza físico de una cita anterior.
  - **Evidencia:** `apps/backend/src/scheduling/availability.service.ts:72-88` — `taken` no trae
    `service.bufferMin`; `takenIntervals` se construye solo `startAt → endAt` (`endAt` = `startAt
    + durationMin`, sin buffer).
  - **Impacto lanzamiento:** alto — si dos servicios tienen duraciones/buffers distintos, un
    paciente puede agendar pisando el tiempo de limpieza de la cita previa (demoras físicas).
  - **Artefacto:** `SPEC.md` §2 · `availability.service.ts`.
  - **Recomendación:** `include: { service: { select: { bufferMin } } }` en la query `taken` y
    extender el intervalo ocupado con `plus({ minutes: service.bufferMin })`.
  - **Origen:** F1.2.T1.

- [P1] `SPEC.md` (y en menor medida `ARCHITECTURE.md`) desactualizado — 7 gaps de contrato
  - **Gap:** SPEC no documenta (1) `Admin SaaS` + impersonation, (2) endpoints reales de
    clínicas (`/clinics/me`, `/admin/clinics`), (3) webhook HMAC-first (dice "token"), (4)
    Invitations, (5) Feedback/follow-ups, (6) Leads, (7) observabilidad/health. Código correcto
    y hardenizado; el drift es 100% documental.
  - **Evidencia:** `docs/SPEC.md:16-19,36-37` vs ADRs 0012/0014/0015/0016/0017 y
    `docs/specs/2026-08-18/19/21`. Diff concreto listo en `docs/auditoria/F1.1.T3.md` §"Diff concreto".
  - **Impacto lanzamiento:** SPEC es el contrato que consume el equipo para integrar/operar;
    describe un estado anterior a los sprints de agosto.
  - **Artefacto:** `SPEC.md` · `ARCHITECTURE.md` · ADRs 0014–0017.
  - **Recomendación:** aplicar el diff de F1.1.T3 (11 cambios en SPEC.md + 2-3 en ARCHITECTURE.md),
    ya redactado como INSERTAR/REEMPLAZAR listo para una task de edición.
  - **Origen:** F1.1.T3 (cross-ref F1.1.T1 "rutas declaradas vs reales").

- [P1] `docs/deploy-coolify.md` referenciado pero inexistente
  - **Gap:** `docker-compose.coolify.yml` instruye leer `docs/deploy-coolify.md` (mapeo de
    dominios Coolify), pero el archivo no existe.
  - **Evidencia:** `docker-compose.coolify.yml:19` (comentario); sin `docs/deploy-coolify.md`.
  - **Impacto lanzamiento:** falta runbook operativo si el piloto usa Coolify (especialmente
    cómo emular el IP Allowlist de WAHA).
  - **Artefacto:** `docker-compose.coolify.yml` · `docs/deploy.md`.
  - **Recomendación:** crear el doc o remover el compose si Coolify no es opción soportada.
  - **Origen:** F1.6.T2.

---

## 4. Hallazgos P2 (deuda post-piloto)

### Core de agendamiento
- [P2] `AvailabilityService.getSlots` no valida `serviceId`/`professionalId` contra `clinicId`
  — side-channel de ocupación cross-tenant por ID directo. `availability.service.ts:41-43,72-81`.
  *(Parcialmente mitigado en el path público por `assertBookableSelection`; el path del panel
  `GET /appointments/slots` y la defensa interna quedan abiertos.)* → `findFirst({ id, clinicId })`
  + `clinicId` en el `where` de `taken`.
- [P2] Patrón TOCTOU `findFirst(scope)` → `update/delete({ where: { id } })` inconsistente.
  No explotable con UUIDs; estandarizar a `updateMany`/`deleteMany` (como FAQ).
- [P2] Bot no implementa cancelación/reprogramación autónoma (deriva a recepción/humano).
  `bot.service.ts` — decisión conservadora; evaluar self-service post-piloto. *(F1.1.T1)*

### Seguridad / webhook
- [P2] SPEC dice 401, el código devuelve 403 (`webhook-auth.util.ts`). Inconsistencia documental.
- [P2] Token compartido comparado con `!==` (no timing-safe). `webhook-auth.util.ts:80`.
- [P2] `Buffer.from(received, 'hex')` en try/catch es código muerto. `webhook-auth.util.ts:64-68`.
- [P2] El webhook no tiene rate-limit propio; requests con `session` desconocida evaden el
  rate-limit del bot. `webhook.controller.ts:95-104`.
- [P2] Redactor de Pino solo cubre campos estructurados, no el string del mensaje.
  `pii-redactor.ts:9-15`.
- [P2] Cookies no-HttpOnly (deuda ADR 0017 §2); `SameSite=Strict`+`Secure` correctos.
- [P2] Borrado de cookie sin flag `Secure` (mismatch con la escritura). `auth.ts:164,197`.
- [P2] Consent sin trazabilidad (`ConsentEvent` ausente). Deuda ADR 0004 §2.
- [P2] `notes` sin cifrado at-rest. Deuda ADR 0004 §1.
- [P2] Sanitización PII pre-envío al LLM ausente. Deuda ADR 0004 §7.

### Admin / SUPERADMIN
- [P2] `reason` de suspensión no llega a `AdminAudit.metadata` (se pierde al reactivar).
- [P2] `ARCHIVE_CLINIC`/`ClinicStatus.ARCHIVED` declarados sin endpoint de archivado.
- [P2] El interceptor de auditoría solo registra responses exitosos, no mutaciones fallidas.
- [P2] `AdminAudit.list` no expone filtro por `impersonatedBy`.
- [P2] Sin MFA para SUPERADMIN (riesgo aceptado ADR 0014; mitigar con VPN/allowlist).

### Onboarding / admin UI
- [P2] No hay endpoint/UI de "reenviar invitación". `POST /admin/invitations/:userId/resend`.
- [P2] Detalle de clínica no expone estado de la invitación (pendiente/aceptada/expirada).
- [P2] `docs/onboarding-clinica.md` desactualizado (aún indica alta manual por SQL).
- [P2] Comentario desactualizado en `AdminClinicsClient.tsx` sobre creación de clínicas.

### Panel / público
- [P2] Panel "citas relacionadas" es placeholder. `ConversationsClient.tsx:1150-1157`.
- [P2] Ruta huérfana `/panel/leads` (dead code, 403 para CLINIC_ADMIN).
- [P2] `sendText` sin try/catch en `BotService.reply()` → chatId inválido → 500 y no persiste OUT.
  *(F1.7.T3)*

### Feedback / leads / tests
- [P2] Cero tests en `feedback`, `follow-ups`, `leads`. `FollowUpsService` + sub-FSM NPS sin red.
- [P2] Follow-up a paciente sin conversación previa: se envía el prompt pero se pierde el score.
  `follow-ups.processor.ts:90-104`.
- [P2] Funnel de leads sin endpoint de mutación (`PATCH /api/leads/:id`); solo captura + listado.
- [P2] Cobertura de tests: `availability.service.ts` sin spec propio; módulo `reminders/`
  (service + processor) sin tests; `invitations` (seguridad) sin tests; `webhook.controller`,
  `rate-limit.guard`, `slug.pipe` sin spec. *(cross-ref F1.7.T1/T2)*
- [P2] Huecos Gherkin SPEC §3 sin cobertura: `reminders`, `availability`, `NEEDS_HUMAN`. *(F1.7.T2)*

---

## 5. Áreas sin hallazgos (verificaciones positivas a preservar)

- **Multi-tenant**: `JwtAuthGuard` global deny-by-default, `RolesGuard`+`@Roles` en los 24
  controllers, `tenantWhere()`/`assertClinicScope()` como único punto de scope, impersonation
  degradada a `CLINIC_ADMIN` sin escape cross-tenant, `@@unique([clinicId,phone])`/`[clinicId,chatId]`.
- **Webhook**: HMAC `timingSafeEqual` + anti-downgrade + fail-closed + raw body, 15 tests.
- **Rate-limit bot (ADR 0007)**: dos capas, silencio total, `chatId` hasheado, fail-open documentado.
- **PII/logging**: convención "loguear sólo IDs" cumplida en controllers/services; login fallido
  loggea solo `ip`; QR booleanizado; `/auth/me` sin password; response público sin PII.
- **FSM del bot**: determinismo de confirmaciones antes del LLM, `HUMAN` silencia, `flowStep`/`flowData`
  retomable, nunca crear/cancelar sin confirmación. Tests 861 líneas.
- **Transiciones de cita**: `assertTransition` + 422, `autoConfirm`, `@@unique([professionalId,startAt])`
  + `P2002`→409. Tests 68/68.
- **Recordatorios/follow-ups**: jobId determinista, cancelación coherente con citas, wiring completo.
- **Frontend**: PRD §3 implementado de punta a punta (sin P0/P1); i18n es/pt completa (1393 claves).
- **Infra**: paridad `.env.example` vs `process.env` correcta; healthchecks + `start_period` alineados.

---

## 6. Cobertura de fuentes (para trazabilidad F2)

| Task | Reporte en disco | Findings consolidados vía |
|---|---|---|
| F1.1.T1 | ❌ (solo resumen) | `orchestrator/state/logs/F1.1.T1.codex.json` — brechas: cancel/reprogram bot, idempotencia webhook, disponibilidad multi-tenant, alertas WAHA, rutas vs SPEC, push. *(dedup hacia F1.2/F1.4/F1.6/F1.7)* |
| F1.1.T2 | ✅ `F1.1.T2.md` | 0 P0/P1, 2 P2 |
| F1.1.T3 | ✅ `F1.1.T3.md` | 7 P1 + 3 P2 (SPEC/ARCH drift) + diff concreto |
| F1.2.T1 | ✅ `F1.2.T1.md` | 1 P0 + 1 P1/P2 (buffer) |
| F1.2.T2 | ❌ | `F1.2.T2.codex.json` — sin hallazgos (verificado, 68/68 tests) |
| F1.2.T3 | ❌ | `F1.2.T3.codex.json` — sin hallazgos críticos (class-validator + clinicId reforzados) |
| F1.3.T1 | ❌ | `F1.3.T1.codex.json` — verificado; nota: alerta usa `NEEDS_HUMAN`, sin convo solo warning |
| F1.3.T2 | ❌ | `F1.3.T2.codex.json` — FSM verificada; `REAGENDAR` deriva a recepción |
| F1.3.T3 | ✅ `F1.3.T3.md` | 0 P0/P1, 3 P2 |
| F1.4.T1 | ✅ `F1.4.T1.md` | 1 P1 + 2 P2 |
| F1.4.T2 | ✅ `F1.4.T2.md` | 2 P1 + 5 P2 |
| F1.4.T3 | ✅ `F1.4.T3.md` | 2 P1 + 6 P2 |
| F1.4.T4 | ✅ `F1.4.T4.md` | 1 P1 + 4 P2 |
| F1.5.T1 | ❌ | `F1.5.T1.codex.json` — 6 P0 de docs/ux cerrados; staleness visible añadido |
| F1.5.T2 | ❌ | `F1.5.T2.codex.json` — a11y/i18n cerrados; drawer mobile admin añadido |
| F1.5.T3 | ❌ | `F1.5.T3.codex.json` — validación multi-tenant pública + rate-limit fail-open robustecidos |
| F1.5.T4 | ✅ `F1.5.T4.md` | 1 P1 + 4 P2 |
| F1.6.T1 | ❌ | `F1.6.T1.log` — P0 Flutter stub (mitigado P1); PRD §3/§9 marcados |
| F1.6.T2 | ✅ `F1.6.T2.md` | 1 P0 + 1 P1 + 1 P2 |
| F1.6.T3 | ❌ | `F1.6.T3.codex.json` — Pino/Axiom/Sentry + health OK; ADR 0015 actualizado |
| F1.7.T1 | ❌ | `F1.7.T1.log` — inventario: 39 specs/132 fuentes; gaps críticos availability + reminders |
| F1.7.T2 | ❌ | `F1.7.T2.codex.json` — matriz Gherkin + test cross-tenant reforzado; huecos reminders/availability/NEEDS_HUMAN |
| F1.7.T3 | ❌ | `F1.7.T3.log` — smoke E2E corregido; 2 bugs reportados (prefijo phone, sendText) |

**Nota de método:** 13 de 23 tasks no persistieron su reporte markdown (los sub-agentes
codex/opencode devolvieron el resumen inline y, en varios casos, aplicaron fixes de código en
lugar de solo auditar). Los hallazgos de esas tasks se recuperaron de los logs del orquestador.
El inventario y los fixes ya aplicados (class-validator, multi-tenant público, rate-limit
fail-open, staleness, drawer a11y, test cross-tenant) se reflejan en "Áreas sin hallazgos".

---

## 7. Orden de ataque recomendado para F2

1. **Fix P0**: (a) herencia `BusinessHour` (override) + test; (b) `ARG/ENV` Sentry en web Dockerfile.
2. **Fix P1 happy-path/seguridad**: prefijo `phone` E.164 unificado → buffer en citas ocupadas →
   status público → idempotencia webhook + fail-fast secretos → consent IA + fix log PHI →
   re-validación de status en impersonation.
3. **Documental en paralelo**: aplicar diff SPEC/ARCHITECTURE (F1.1.T3) y mergear/posponer wizard.
4. **Deuda P2 priorizada**: tests de `availability` + `reminders` + `follow-ups` (los gaps críticos
   de F1.7) → funnel de leads → reenvío de invitación → TOCTOU → cookies HttpOnly.

---

*Reporte generado por F1.8.T1 (DeepSeek V4 Pro) — síntesis de 23 tasks F1.1–F1.7.*
