# F2 — Finalización (cierre de findings F1)

Fase de implementación derivada de la auditoría F1. El objetivo es cerrar los
hallazgos consolidados en `docs/auditoria/RESUMEN-finalizacion.md` para pasar de
**NO-GO** a **GO condicional** en el canary de 40 clínicas (2026-08-25).

**Contrato de herencia (todas las tasks).** Cada task hereda del finding origen:
`Severidad` (P0/P1/P2), `Artefacto` (SPEC §, ADR NNNN, archivo) y `paths`
(archivos concretos a tocar). `Origen` referencia la task de auditoría que
emitió el finding para trazabilidad. NO se inventan hallazgos: solo se
convierten los de `RESUMEN-finalizacion.md` en tareas ejecutables.

**Alcance:** cerrar los **2 P0 de código/infra** que bloquean el GO, los **11 P1**
que tocan happy path / seguridad / compliance, y la **deuda P2 priorizada** (§7
del resumen) más el resto de P2 agrupado por área. La app Flutter (P0 documental
mitigado) se posterga formalmente a Fase 4 (`F2.6`).

---

## F2.1 — P0 bloqueantes (core de agendamiento + observabilidad)

Los dos bloqueantes reales del GO. Cerrar antes que cualquier otra task.

### F2.1.T1 — Fix herencia de `BusinessHour` (override, no unión)

**Severidad**: P0 · **Origen**: F1.2.T1 · **Artefacto**: `SPEC.md` §2

El motor de disponibilidad devuelve la *unión* del horario del profesional con
el de la clínica en vez del override. Tras el `findMany`, si existe al menos un
`BusinessHour` con `professionalId`, descartar todos los de `professionalId ===
null`. Añadir test de regresión: un profesional con horario propio NO recibe
slots fuera de su horario (no hereda los de la clínica).

- **Modelo**: opencode/deepseek-v4-pro
- **Estimación**: 2h
- **Razón**: Correctitud del core de agendamiento; edge cases de override/herencia.
- **Files**:
  - `apps/backend/src/scheduling/availability.service.ts`
  - `apps/backend/src/scheduling/availability.service.spec.ts`

### F2.1.T2 — Declarar `ARG`/`ENV` de Sentry en `apps/web/Dockerfile`

**Severidad**: P0 · **Origen**: F1.6.T2 · **Artefacto**: ADR 0015

Los compose definen `NEXT_PUBLIC_SENTRY_*`, `SENTRY_ORG`, `SENTRY_AUTH_TOKEN` en
`args:`, pero el Dockerfile de Next.js solo declara `ARG NEXT_PUBLIC_API_URL` e
ignora el resto → Sentry deshabilitado en cliente y sin upload de source maps.
Declarar los `ARG`/`ENV` correspondientes en el stage `build` para que el DSN se
embeeba y los source maps se suban.

- **Modelo**: opencode/gpt-5.5-codex
- **Estimación**: 1h
- **Razón**: Fix de config de build acotado; no requiere juicio de negocio.
- **Files**:
  - `apps/web/Dockerfile`
  - `docker-compose.prod.yml`
  - `docker-compose.coolify.yml`

---

## F2.2 — P1 happy-path y seguridad

Fixes que deben estar antes del GO: rompen el core anti no-show, el canal
público nuevo, o la compliance de datos de salud.

### F2.2.T1 — Normalizar teléfono a E.164 en un único punto

**Severidad**: P1 · **Origen**: F1.7.T3 · **Artefacto**: `SPEC.md` §2

El webhook guarda `phone` sin `+` (`bareId`) mientras panel/página pública
normalizan a E.164 con `+`; `findUpcomingAppointment` matchea por
`clinicId_phone` y no encuentra al paciente → confirmación/recordatorio no liga
con la cita. Normalizar a E.164 en un único punto (ingreso del webhook o al
matchear) y test de regresión con ambos prefijos.

- **Modelo**: opencode/deepseek-v4-pro
- **Estimación**: 2h
- **Razón**: Integridad del vínculo paciente-cita; afecta dos flujos de entrada.
- **Dependencies**: F2.2.T4
- **Files**:
  - `apps/backend/src/whatsapp/webhook.controller.ts`
  - `apps/backend/src/bot/bot.service.ts`
  - `apps/backend/src/whatsapp/webhook.controller.spec.ts`

### F2.2.T2 — Respetar `bufferMin` en las citas ya ocupadas

**Severidad**: P1 · **Origen**: F1.2.T1 · **Artefacto**: `SPEC.md` §2

El motor suma `durationMin + bufferMin` al iterar slots libres, pero ignora el
`bufferMin` de las citas ocupadas al evaluar solapamientos. Añadir `include: {
service: { select: { bufferMin } } }` en la query `taken` y extender el intervalo
ocupado con `plus({ minutes: service.bufferMin })`.

- **Modelo**: opencode/deepseek-v4-pro
- **Estimación**: 2h
- **Razón**: Solapamiento del tiempo de limpieza físico; lógica de negocio densa.
- **Dependencies**: F2.1.T1
- **Files**:
  - `apps/backend/src/scheduling/availability.service.ts`
  - `apps/backend/src/scheduling/availability.service.spec.ts`

### F2.2.T3 — Filtrar `Clinic.status` en los endpoints públicos

**Severidad**: P1 · **Origen**: F1.4.T1 · **Artefacto**: ADR 0014

`getClinic`/`getAvailability`/`createAppointment` resuelven por `slug` con
`findUnique({ where: { slug } })` sin filtrar `status` → clínica suspendida
sigue visible y reservable. Filtrar `status: 'ACTIVE'` (404/410 en
SUSPENDED/ARCHIVED) en los 3 endpoints. Cross-ref: verificar que la sesión WAHA
de una clínica suspendida deje de responder.

- **Modelo**: opencode/gpt-5.5-codex
- **Estimación**: 1.5h
- **Razón**: Filtro de 3 endpoints + verificación de palanca del operador SaaS.
- **Files**:
  - `apps/backend/src/public/public.controller.ts`
  - `apps/backend/prisma/schema.prisma`

### F2.2.T4 — Idempotencia de eventos en el webhook WAHA

**Severidad**: P1 · **Origen**: F1.4.T2 · **Artefacto**: ADR 0007 · ADR 0017

El controller descarta el `id` del evento de WAHA; un redelivery se procesa dos
veces (doble LLM + re-procesado FSM). Dedup idempotente ANTES de
`bot.handleIncoming`: `Message.wahaEventId @@unique` o `SETNX
webhook:event:{id}` con TTL 24h.

- **Modelo**: opencode/deepseek-v4-pro
- **Estimación**: 2h
- **Razón**: Protege el presupuesto de LLM (ADR 0007) y el bloat de `Message`.
- **Files**:
  - `apps/backend/src/whatsapp/webhook.controller.ts`
  - `apps/backend/src/whatsapp/webhook.controller.spec.ts`
  - `apps/backend/prisma/schema.prisma`

### F2.2.T5 — Fail-fast de secretos de webhook en `main.ts`

**Severidad**: P1 · **Origen**: F1.4.T2 · **Artefacto**: ADR 0017

`main.ts` valida en prod `DATABASE_URL`, `REDIS_URL`, `JWT_SECRET`, `SENTRY_DSN`…
pero no `WEBHOOK_HMAC_SECRET`/`WEBHOOK_TOKEN` → el webhook queda fail-closed
(403) sin señal temprana. Agregar fail-fast "al menos uno de
`WEBHOOK_HMAC_SECRET`/`WEBHOOK_TOKEN`" (OR).

- **Modelo**: opencode/gpt-5.5-codex
- **Estimación**: 0.5h
- **Razón**: Validación de arranque acotada; sin lógica de negocio.
- **Files**:
  - `apps/backend/src/main.ts`

### F2.2.T6 — Consent de IA de terceros en el copy del paciente (es/pt)

**Severidad**: P1 · **Origen**: F1.4.T3 · **Artefacto**: ADR 0004 §7

ADR 0004 §7 exige consent explícito para IA de terceros (OpenAI/DeepSeek/Google);
el form solo dice "Autorizo el uso de mis datos para gestionar la cita" y el
greeting del bot no menciona IA/terceros. Agregar el copy del ADR §7 al checkbox
del form (es/pt) y al primer mensaje del bot. El mecanismo `ConsentEvent` es
deuda P2 aparte (ver F2.5.T5).

- **Modelo**: opencode/gpt-5.5-codex
- **Estimación**: 1h
- **Razón**: Copy de compliance + i18n es/pt; sin lógica compleja.
- **Files**:
  - `apps/web/messages/es.json`
  - `apps/web/messages/pt.json`
  - `apps/backend/src/bot/bot.service.ts`

### F2.2.T7 — No loggear PHI en `WahaService.sendText`

**Severidad**: P1 · **Origen**: F1.4.T3 · **Artefacto**: ADR 0004 §5

Ante `!res.ok`, `sendText` loggea el `body` completo de la respuesta de error de
WAHA, que puede incluir el texto saliente (nombre, hora, motivo). Loggear solo
`res.status` + error genérico. Fix de 2 líneas.

- **Modelo**: opencode/gpt-5.5-codex
- **Estimación**: 0.5h
- **Razón**: Fix puntual de compliance; el redactor no cubre el string del mensaje.
- **Files**:
  - `apps/backend/src/whatsapp/waha.service.ts`

### F2.2.T8 — Re-validar `Clinic.status` en el JWT de impersonation

**Severidad**: P1 · **Origen**: F1.4.T4 · **Artefacto**: ADR 0014 · ADR 0016

El gate "clínica ACTIVE" se aplica solo al emitir el token y en `login()`. Si el
super suspende una clínica ya impersonada, el token sigue operando ~30 min. En
`JwtStrategy.validate` (o guard), re-chequear `status === 'ACTIVE'` cuando haya
`clinicId` + `impersonatedBy` (cacheable en Redis por `clinicId`).

- **Modelo**: opencode/deepseek-v4-pro
- **Estimación**: 1.5h
- **Razón**: Corta una sesión de impersonation ya activa; seguridad del operador.
- **Files**:
  - `apps/backend/src/auth/jwt.strategy.ts`
  - `apps/backend/src/admin/impersonation.service.ts`
  - `apps/backend/src/common/tenant-context.util.ts`

---

## F2.3 — P1 documental + feature terminada fuera del release

Van en paralelo con F2.2. No bloquean por sí mismas el happy path, pero cierran
P1 de contrato/operación.

### F2.3.T1 — Aplicar el diff de `SPEC.md` + `ARCHITECTURE.md` (F1.1.T3)

**Severidad**: P1 · **Origen**: F1.1.T3 · **Artefacto**: ADRs 0014–0017

SPEC no documenta Admin SaaS/impersonation, endpoints reales de clínicas,
webhook HMAC-first, Invitations, Feedback/follow-ups, Leads ni
observabilidad/health. Aplicar el diff concreto ya redactado en
`docs/auditoria/F1.1.T3.md` §"Diff concreto" (11 cambios en SPEC.md + 2-3 en
ARCHITECTURE.md) como INSERTAR/REEMPLAZAR.

- **Modelo**: opencode/deepseek-v4-pro
- **Estimación**: 3h
- **Razón**: Contrato consumido por el equipo; requiere juicio de edición.
- **Files**:
  - `docs/SPEC.md`
  - `docs/ARCHITECTURE.md`
  - `docs/auditoria/F1.1.T3.md`

### F2.3.T2 — Mergear o posponer formalmente el wizard de onboarding

**Severidad**: P1 · **Origen**: F1.5.T4 · **Artefacto**: `docs/notas/2026-08-11-onboarding-wizard.md`

El wizard first-time está implementado completo (migration, `PATCH
/clinics/me/onboarding`, middleware, 5 steps, Stepper, i18n `onboarding.*`) pero
todo vive en `feature/onboarding-wizard`, no en `main`/`staged`. Mergear la rama
sobre `staged` (rebase + review) o documentar la postergación formal con
decisión de producto.

- **Modelo**: opencode/gpt-5.5-codex
- **Estimación**: 2h
- **Razón**: Rebase + review de una feature terminada; sin codear desde cero.
- **Files**:
  - `apps/backend/prisma/schema.prisma`
  - `apps/web/src/middleware.ts`
  - `docs/notas/2026-08-11-onboarding-wizard.md`
  - `docs/onboarding-clinica.md`

### F2.3.T3 — Crear `docs/deploy-coolify.md`

**Severidad**: P1 · **Origen**: F1.6.T2 · **Artefacto**: `docker-compose.coolify.yml`

`docker-compose.coolify.yml:19` instruye leer `docs/deploy-coolify.md` (mapeo de
dominios Coolify), pero el archivo no existe. Crear el runbook operativo
(incluido cómo emular el IP Allowlist de WAHA) o remover el compose si Coolify
no es opción soportada.

- **Modelo**: opencode-go/deepseek-v4-flash
- **Estimación**: 1h
- **Razón**: Documentación operativa; sin lógica de negocio.
- **Files**:
  - `docs/deploy-coolify.md`
  - `docker-compose.coolify.yml`
  - `docs/deploy.md`

---

## F2.4 — Deuda P2 priorizada (orden de ataque §7)

Los P2 que la síntesis marca como críticos para el canary: gaps de tests,
funnel de leads, reenvío de invitación, TOCTOU y cookies.

### F2.4.T1 — Tests de `availability` + `reminders` + `follow-ups` (huecos Gherkin)

**Severidad**: P2 · **Origen**: F1.7.T1 · F1.7.T2 · **Artefacto**: `SPEC.md` §2/§3

`availability.service.ts` sin spec propio; módulo `reminders/` (service +
processor) sin tests; `follow-ups`/`feedback`/`leads` sin tests. Cubrir los
huecos Gherkin de `SPEC.md` §3 (`reminders`, `availability`, `NEEDS_HUMAN`) y
añadir un test que falle ante fuga cross-tenant.

- **Modelo**: opencode/gpt-5.5-codex
- **Estimación**: 4h
- **Razón**: Gaps críticos de cobertura sobre lógica de negocio; volumen alto.
- **Files**:
  - `apps/backend/src/scheduling/availability.service.spec.ts`
  - `apps/backend/src/reminders`
  - `apps/backend/src/follow-ups`
  - `docs/SPEC.md`

### F2.4.T2 — Endpoint de mutación de leads (`PATCH /api/leads/:id`)

**Severidad**: P2 · **Origen**: F1.3.T3 · **Artefacto**: `docs/adr/0012-feedback-post-atencion.md`

El funnel de leads solo captura y lista; no hay endpoint de mutación. Añadir
`PATCH /api/leads/:id` con validación class-validator y tenant scoping por
`clinicId`.

- **Modelo**: opencode/gpt-5.5-codex
- **Estimación**: 2h
- **Razón**: Cierra el funnel de leads; CRUD + DTOs estándar.
- **Files**:
  - `apps/backend/src/leads`

### F2.4.T3 — Reenviar invitación (`POST /admin/invitations/:userId/resend`)

**Severidad**: P2 · **Origen**: F1.5.T4 · **Artefacto**: ADR 0014

No hay endpoint/UI de "reenviar invitación" para admins que pierden el correo.
Añadir `POST /admin/invitations/:userId/resend` (re-emisión de token + envío) y
su disparador en la UI.

- **Modelo**: opencode/gpt-5.5-codex
- **Estimación**: 1.5h
- **Razón**: Flujo de invitación incompleto; endpoint + UI acotados.
- **Files**:
  - `apps/backend/src/admin`
  - `apps/web/src/app/[locale]/admin`

### F2.4.T4 — Estandarizar TOCTOU a `updateMany`/`deleteMany`

**Severidad**: P2 · **Origen**: F1.2.T3 · **Artefacto**: `apps/backend/src`

Patrón `findFirst(scope)` → `update/delete({ where: { id } })` inconsistente.
No explotable con UUIDs, pero estandarizar a `updateMany`/`deleteMany` (como
FAQ) para que el scope viaje en la misma query.

- **Modelo**: opencode/gpt-5.5-codex
- **Estimación**: 2h
- **Razón**: Refactor de consistencia multi-tenant; sin cambio de comportamiento.
- **Files**:
  - `apps/backend/src`

### F2.4.T5 — Cookies `HttpOnly` + `Secure` (escritura y borrado)

**Severidad**: P2 · **Origen**: F1.4.T3 · **Artefacto**: ADR 0017 §2

Cookies no-HttpOnly (deuda ADR 0017 §2) y borrado de cookie sin flag `Secure`
(mismatch con la escritura). Añadir `HttpOnly` en la escritura y `Secure` en el
borrado para mantener `SameSite=Strict` + `Secure` coherentes.

- **Modelo**: opencode-go/deepseek-v4-flash
- **Estimación**: 1h
- **Razón**: Config de cookies acotada; hardening de sesión.
- **Files**:
  - `apps/backend/src/auth/auth.ts`

---

## F2.5 — Deuda P2 restante (agrupada por área)

Deuda post-piloto; no bloquea el canary. Ejecutar tras el GO.

### F2.5.T1 — Validar `serviceId`/`professionalId` contra `clinicId` en `getSlots`

**Severidad**: P2 · **Origen**: F1.2.T1 · **Artefacto**: `availability.service.ts`

Side-channel de ocupación cross-tenant por ID directo. `findFirst({ id,
clinicId })` + `clinicId` en el `where` de `taken` (mitiga el path del panel
`GET /appointments/slots` y la defensa interna).

- **Modelo**: opencode/gpt-5.5-codex
- **Estimación**: 1.5h
- **Razón**: Cierra el side-channel cross-tenant restante.
- **Files**:
  - `apps/backend/src/scheduling/availability.service.ts`

### F2.5.T2 — Hardening de `webhook-auth.util.ts`

**Severidad**: P2 · **Origen**: F1.4.T2 · **Artefacto**: ADR 0017

Tres hallazgos en un archivo: (a) SPEC dice 401, el código devuelve 403
(inconsistencia documental); (b) token compartido comparado con `!==` (no
timing-safe → usar `timingSafeEqual`); (c) `Buffer.from(received, 'hex')` en
try/catch es código muerto.

- **Modelo**: opencode/gpt-5.5-codex
- **Estimación**: 1.5h
- **Razón**: Tres fixes acotados sobre el mismo util de auth.
- **Files**:
  - `apps/backend/src/whatsapp/webhook-auth.util.ts`
  - `docs/SPEC.md`

### F2.5.T3 — Rate-limit propio del webhook

**Severidad**: P2 · **Origen**: F1.4.T2 · **Artefacto**: ADR 0007

Requests con `session` desconocida evaden el rate-limit del bot. Añadir
rate-limit propio al webhook (independiente del rate-limit por `chatId`).

- **Modelo**: opencode/gpt-5.5-codex
- **Estimación**: 1h
- **Razón**: Cierra el bypass del presupuesto de LLM.
- **Files**:
  - `apps/backend/src/whatsapp/webhook.controller.ts`

### F2.5.T4 — Redactor de Pino: cubrir el string del mensaje

**Severidad**: P2 · **Origen**: F1.4.T3 · **Artefacto**: ADR 0004 §5

El redactor de Pino solo cubre campos estructurados, no el string del mensaje.
Extender la cobertura al mensaje interpolado (complementa F2.2.T7).

- **Modelo**: opencode/gpt-5.5-codex
- **Estimación**: 2h
- **Razón**: Defensa en profundidad del redactor de PHI.
- **Files**:
  - `apps/backend/src/common/logger/pii-redactor.ts`

### F2.5.T5 — Deuda ADR 0004: `ConsentEvent` + cifrado at-rest + sanitización PII LLM

**Severidad**: P2 · **Origen**: F1.4.T3 · **Artefacto**: ADR 0004 §1/§2/§7

Tres deudas de compliance: (a) `ConsentEvent` ausente (sin trazabilidad del
consent); (b) `notes` sin cifrado at-rest (§1); (c) sanitización de PII
pre-envío al LLM ausente (§7, complementa F2.2.T6 con el gate técnico).

- **Modelo**: opencode/deepseek-v4-pro
- **Estimación**: 4h
- **Razón**: Compliance de datos de salud; toca storage, consent y pipeline LLM.
- **Files**:
  - `apps/backend/src/feedback`
  - `apps/backend/src/patients`
  - `apps/backend/src/bot/knowledge.service.ts`
  - `apps/backend/src/bot/intent.service.ts`

### F2.5.T6 — Robustez de `AdminAudit`

**Severidad**: P2 · **Origen**: F1.4.T4 · **Artefacto**: ADR 0016

(a) `reason` de suspensión no llega a `AdminAudit.metadata` (se pierde al
reactivar); (b) el interceptor solo registra responses exitosos, no mutaciones
fallidas; (c) `AdminAudit.list` no expone filtro por `impersonatedBy`.

- **Modelo**: opencode/gpt-5.5-codex
- **Estimación**: 2h
- **Razón**: Trail de auditoría incompleto para el operador SaaS.
- **Files**:
  - `apps/backend/src/admin`

### F2.5.T7 — Endpoint `ARCHIVE_CLINIC`

**Severidad**: P2 · **Origen**: F1.4.T4 · **Artefacto**: ADR 0014

`ARCHIVE_CLINIC`/`ClinicStatus.ARCHIVED` declarados sin endpoint de archivado.
Implementar el endpoint que complete el ciclo de vida del estado.

- **Modelo**: opencode-go/deepseek-v4-flash
- **Estimación**: 1h
- **Razón**: Endpoint faltante que cierra un estado ya declarado.
- **Files**:
  - `apps/backend/src/admin`

### F2.5.T8 — Onboarding UI/docs: estado de invitación + docs

**Severidad**: P2 · **Origen**: F1.5.T4 · **Artefacto**: `docs/onboarding-clinica.md`

(a) detalle de clínica no expone estado de la invitación
(pendiente/aceptada/expirada); (b) `docs/onboarding-clinica.md` desactualizado
(aún indica alta manual por SQL); (c) comentario desactualizado en
`AdminClinicsClient.tsx`.

- **Modelo**: opencode-go/deepseek-v4-flash
- **Estimación**: 1.5h
- **Razón**: UI + docs de onboarding; sin lógica densa.
- **Files**:
  - `apps/web/src/components/AdminClinicsClient.tsx`
  - `apps/web/src/app/[locale]/admin`
  - `docs/onboarding-clinica.md`

### F2.5.T9 — Panel: citas relacionadas + ruta huérfana `/panel/leads`

**Severidad**: P2 · **Origen**: F1.5.T1 · F1.5.T2 · **Artefacto**: `ConversationsClient.tsx`

(a) panel "citas relacionadas" es placeholder; (b) ruta huérfana `/panel/leads`
(dead code, 403 para CLINIC_ADMIN). Implementar el placeholder o retirarlo, y
eliminar/ocultar la ruta muerta.

- **Modelo**: opencode/gpt-5.5-codex
- **Estimación**: 2.5h
- **Razón**: UI panel con componente placeholder y limpieza de dead code.
- **Files**:
  - `apps/web/src/components/ConversationsClient.tsx`
  - `apps/web/src/app/[locale]/panel`

### F2.5.T10 — `sendText` sin try/catch en `BotService.reply()`

**Severidad**: P2 · **Origen**: F1.7.T3 · **Artefacto**: `bot.service.ts`

`chatId` inválido → 500 y no persiste el mensaje OUT. Envolver `sendText` en
try/catch y persistir el estado OUT de forma coherente ante fallo.

- **Modelo**: opencode/gpt-5.5-codex
- **Estimación**: 1h
- **Razón**: Robustez del reply del bot; fix acotado.
- **Files**:
  - `apps/backend/src/bot/bot.service.ts`

### F2.5.T11 — Follow-up sin conversación previa: persistir el score

**Severidad**: P2 · **Origen**: F1.3.T3 · **Artefacto**: `follow-ups.processor.ts`

Follow-up a paciente sin conversación previa: se envía el prompt pero se pierde
el score. Persistir la respuesta del NPS aunque no exista conversación previa.

- **Modelo**: opencode/gpt-5.5-codex
- **Estimación**: 1.5h
- **Razón**: Pérdida de datos del NPS; fix de persistencia.
- **Files**:
  - `apps/backend/src/follow-ups/follow-ups.processor.ts`

### F2.5.T12 — Cancelación/reprogramación autónoma del bot (evaluación)

**Severidad**: P2 · **Origen**: F1.1.T1 · **Artefacto**: `bot.service.ts`

El bot deriva cancelación/reprogramación a recepción/humano (decisión
conservadora). Evaluar self-service post-piloto: FSM de cancel/reprogram con
confirmación explícita, o documentar la decisión de mantener el handoff.

- **Modelo**: opencode/deepseek-v4-pro
- **Estimación**: 3h
- **Razón**: Cambio de FSM con interacción LLM; decisión de producto + diseño.
- **Files**:
  - `apps/backend/src/bot/bot.service.ts`
  - `apps/backend/src/bot/intent.service.ts`

### F2.5.T13 — MFA para SUPERADMIN (documentar riesgo aceptado / mitigar)

**Severidad**: P2 · **Origen**: F1.4.T4 · **Artefacto**: ADR 0014

Sin MFA para SUPERADMIN (riesgo aceptado en ADR 0014). Documentar la mitigación
operativa (VPN/IP allowlist) como ADR o nota, o planificar MFA si el piloto lo
requiere.

- **Modelo**: opencode-go/deepseek-v4-flash
- **Estimación**: 1h
- **Razón**: Documentación de riesgo aceptado; sin código salvo decisión contraria.
- **Files**:
  - `docs/adr`
  - `docs/notas`

---

## F2.6 — Post-piloto (Fase 4)

Diferido formalmente; no participa del GO del canary.

### F2.6.T1 — App Flutter del profesional (scoped endpoint + push + app)

**Severidad**: P0 (mitigado a P1 para el canary) · **Origen**: F1.6.T1 · **Artefacto**: `PRD.md` §3/§9

`apps/mobile` es un stub (`README.md`). Antes de codear: decidir proveedor de
push (FCM/Expo/OneSignal) y exponer un scoped endpoint `PATCH` confirmar/bloquear
para `PROFESSIONAL`. Recién después implementar login, agenda del profesional,
confirmar/bloquear y push. El panel web responsive cubre la operación hasta
entonces.

- **Modelo**: opencode/deepseek-v4-pro
- **Estimación**: 8h
- **Razón**: Fase 4 completa; requiere diseño de contrato + app Flutter.
- **Files**:
  - `apps/mobile`
  - `apps/backend/src/appointments`
  - `docs/PRD.md`
