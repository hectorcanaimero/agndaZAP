# Bitácora de sesiones — AgendaZap

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
