# Inventario de cobertura de tests backend — F1.7.T1

- **Task**: F1.7.T1 — Generar inventario de tests `.spec.ts` por módulo (qué hay, qué falta)
  y cruzar contra las reglas de negocio críticas de `SPEC.md` §2 (disponibilidad, transiciones,
  recordatorios, bot, tenant isolation). Listar módulos sin tests.
- **Alcance**: `apps/backend/src` (39 `.spec.ts` sobre 132 archivos fuente `.ts`).
- **Fuente**: `specs/f1-auditoria-finalizacion.md#F1.7.T1`, `tasks.json` F1.7.T1.

## 1. Inventario por módulo

Leyenda: `src` = `.ts` no spec (top-level + subdirs del módulo); `spec` = `.spec.ts`.
Módulos con cobertura total de lógica están marcados ✅; los sin tests ❌.

| Módulo | src | spec | Spec files | Estado |
|---|---|---|---|---|
| admin | 11 | 9 | admin-audit.{controller,interceptor,service}, admin-clinics.{controller,service}, admin-metrics.{controller,service}, impersonation.{controller,service} | ✅ (falta: decorator, module, dto) |
| appointments | 3 | 2 | appointment-status.util, appointments.controller | ✅ transiciones |
| auth | 11 | 4 | auth.controller, auth.service, jwt-algorithms, tenant-context.util | ⚠️ guards/strategy/password.util sin spec |
| bot | 3 | 2 | bot.service (861 ln), intent.service | ✅ FSM completo |
| business-hours | 2 | 1 | business-hours.controller | ✅ |
| clinics | 2 | 1 | clinics.controller | ✅ |
| common | 10 | 4 | llm-router.service, pii-redactor, request-context.interceptor, sentry.filter | ⚠️ extract-ip, sanitize-text, logger.config, sentry.config sin spec |
| conversations | 2 | 1 | conversations.controller | ✅ |
| dashboard | 2 | 1 | dashboard.controller | ✅ |
| faq | 2 | 1 | faq.controller | ✅ |
| feedback | 2 | 0 | — | ❌ |
| follow-ups | 3 | 0 | — | ❌ |
| health | 2 | 1 | health.controller | ✅ |
| invitations | 3 | 0 | — | ❌ |
| knowledge | 2 | 1 | knowledge.service | ✅ |
| leads | 4 | 0 | — | ❌ |
| mail | 2 | 0 | — | ❌ (infra) |
| patients | 2 | 1 | patients.controller | ✅ |
| prisma | 2 | 0 | — | ❌ (infra) |
| professionals | 4 | 2 | ical.service, professionals.controller | ⚠️ professionals-ical.controller sin spec |
| public | 4 | 1 | public.controller | ⚠️ rate-limit.guard, slug.pipe sin spec |
| reminders | 3 | 0 | — | ❌ |
| scheduling | 3 | 1 | scheduling.service (436 ln) | ⚠️ availability.service SIN spec propio |
| services | 2 | 1 | services.controller | ✅ |
| time-off | 2 | 1 | time-off.controller | ✅ |
| whatsapp | 7 | 4 | health-monitor.service, waha.service, webhook-auth.util, whatsapp-panel.controller | ⚠️ webhook.controller, health-monitor.processor sin spec |

## 2. Cruce contra reglas de negocio críticas (SPEC.md §2)

| Regla §2 | Archivo(s) | Cobertura | Veredicto |
|---|---|---|---|
| Disponibilidad (slot válido: BusinessHour, sin solape con citas activas, TimeOff, futuro en TZ, paso `durationMin + bufferMin`) | `scheduling/availability.service.ts` | **NINGUNA**. El único `spec` del módulo (`scheduling.service.spec.ts`) mockea `availability.getSlots` (líneas 102, 303) y solo lo usa para éxito/conflicto. La lógica de slots NO se testea directamente. | 🔴 **GAP CRÍTICO** |
| Transiciones de estado (PENDIENTE→CONFIRMADA/EN_RIESGO/CANCELADA, etc., 422) | `appointments/appointment-status.util.ts` | `appointment-status.util.spec.ts` → `describe('assertTransition')` | ✅ cubierto (calidad en F1.7.T2) |
| Recordatorios (offsets futuros, omitir pasados, cancelar jobs, idempotencia por `jobId`) | `reminders/reminders.service.ts`, `reminders/reminders.processor.ts` | **NINGUNA**. El módulo `reminders/` no tiene spec. Los specs de scheduling solo verifican que se "programan recordatorios" vía mock de la dependencia. | 🔴 **GAP CRÍTICO** |
| Bot (regla determinista antes de LLM, nunca crear/cancelar sin confirmación explícita, si `state=HUMAN` no responde) | `bot/bot.service.ts`, `bot/intent.service.ts` | `bot.service.spec.ts` (861 líneas): testea confirmación explícita (ln 395), `state=HUMAN` no responde (ln 536), handoff NEEDS_HUMAN (ln 601). `intent.service.spec.ts` cubre el resolve determinista. | ✅ bien cubierto |
| Tenant isolation (cero fuga cross-tenant) | `auth/tenant-context.util.ts` + guards | `tenant-context.util.spec.ts` (179 ln): `assertClinicScope`, `isSuperadmin`, `tenantWhere` (22 `describe`+`it`). Además `scheduling.service.spec.ts:194` testea rechazo de `serviceId` de otra clínica. | ✅ presente (falta test de fuga en guards/roles: F1.7.T2 los revisa) |

### Gaps críticos resumidos
1. **Disponibilidad**: `availability.service.ts` no tiene test propio — es el corazón de la regla
   más densa de §2 (BusinessHour, TimeOff, TZ, paso de slots) y solo se ejercita como mock.
2. **Recordatorios**: módulo `reminders/` completo (service + processor) sin tests — cancelar
   jobs, omitir offsets pasados e idempotencia por `jobId` no tienen verificación.

## 3. Módulos sin tests (ningún `.spec.ts`)

- ❌ `feedback/` — `feedback.controller.ts`
- ❌ `follow-ups/` — `follow-ups.service.ts`, `follow-ups.processor.ts` (lógica de negocio post-atencion)
- ❌ `invitations/` — `invitations.controller.ts`, `invitations.service.ts` (flujo de auth/seguridad)
- ❌ `leads/` — `leads.controller.ts`, `admin-leads.controller.ts`, `leads.service.ts`
- ❌ `mail/` — `mail.service.ts` (infra; baja prioridad)
- ❌ `prisma/` — `prisma.service.ts` (infra; baja prioridad)
- ❌ `reminders/` — **crítico**, ver §2

## 4. Gaps parciales (lógica presente sin spec)

- `auth/guards/jwt-auth.guard.ts`, `auth/guards/roles.guard.ts`, `auth/strategies/jwt.strategy.ts`,
  `auth/password.util.ts` — no tienen spec propio (hay `jwt-algorithms.spec.ts` y `tenant-context.util.spec.ts`).
- `whatsapp/webhook.controller.ts` — entrypoint público de eventos WAHA, sin spec.
- `whatsapp/health-monitor.processor.ts` — sin spec.
- `public/rate-limit.guard.ts`, `public/slug.pipe.ts` — anti-spam + validación de entrada pública sin spec.
- `professionals/professionals-ical.controller.ts` — sin spec (el service `ical.service` sí tiene).
- `common/sanitize-text.ts`, `common/extract-ip.ts` — utilidades sin spec.

## 5. Resumen numérico

- 132 archivos fuente `.ts`, 39 `.spec.ts` → **29.5%** de archivos fuente con spec hermano.
- 7 módulos con **cero** tests (2 críticos: `reminders`, `follow-ups`; 1 de seguridad: `invitations`).
- 2 reglas críticas de §2 sin cobertura directa (disponibilidad, recordatorios).
