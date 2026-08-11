# Bitácora de sesiones — AgendaZap

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
