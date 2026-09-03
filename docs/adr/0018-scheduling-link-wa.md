---
status: accepted
date: 2026-09-02
tags: [bot, scheduling, whatsapp, multi-tenant, seguridad]
---

# ADR 0018 — Link de agendamiento por WhatsApp (escalado bot → web)

## Contexto

Hasta hoy había dos caminos separados para que un paciente reserve una cita:

1. **Bot puro (WhatsApp)** — FSM lineal en `BotService`: servicio → profesional → slot → confirmación. Requiere que el bot conozca el `phone` del paciente (E.164). Cuando la conversación llega por `@lid` (privacidad nueva de WhatsApp, ver [[0010-whatsapp-lid-y-contact-info]]) el `phone` es `null` y **no podemos crear el `Patient`** — el flujo se aborta y le pedimos al paciente que "escriba desde el número directo", lo cual la mayoría no hace.
2. **Web pública** — `/agendar/[clinicSlug]`: form completo, sirve para links compartidos / QR / redes. No sabe nada del paciente aunque venga de una conversación WA existente.

Casos que caían fuera de los dos flujos:

- **LID sin phone**: el bot no puede agendar → rebote → cita perdida.
- **Paciente prefiere el form gráfico** (elegir día visualmente, ver precios): hoy no podemos escalar sin perder el contexto de la conversación.
- **FSM bloqueada** (paciente responde algo raro varias veces): sin válvula de escape, el bot cicla.

Necesitamos **un puente** entre los dos mundos: que el bot mande un link web atado a la conversación, y que la cita creada por ese link quede atada al chat WA original.

## Decisión

Introducir un **token de sesión de agendamiento** efímero que ata una `Conversation` de WhatsApp con una sesión web pública.

### Componentes

1. `SchedulingSessionService` (backend) — encapsula el ciclo de vida del token.
   - Storage: **Redis** (mismo singleton global via `RedisModule`). TTL 30 min. Efímero por diseño — no queremos historial ni queries.
   - Token: `crypto.randomBytes(24).toString('base64url')` — 32 chars URL-safe, ~192 bits de entropía. Cero deps.
   - Métodos: `create()` / `resolve()` (lookup pasivo, permite recargas del form) / `consume()` (get + del atómico via pipeline — "un token, una cita").
2. `Appointment.source: AppointmentSource enum` — nuevos valores: `BOT | PUBLIC | BOT_WEB`. Default `PUBLIC` para migrar cero-riesgo las citas legacy.
3. `Appointment.conversationId` — FK opcional a `Conversation`. `ON DELETE SET NULL`.
4. `GET /public/scheduling/session/:token` — endpoint público que hidrata el form desde el token. Devuelve `{ clinicSlug, name, phone, phoneEditable }`. **No consume** — el consume pasa en el POST siguiente.
5. `POST /public/:slug/appointments` acepta `token?` opcional. Cuando viene: `consume()` el token, valida `clinicSlug` == URL slug (defensa cross-tenant), setea `source=BOT_WEB`, ata `conversationId`.
6. `BotService.buildSchedulingLink(convo, clinic)` — arma la URL `${WEB_BASE_URL}/${locale}/agendar/${slug}?t=${token}`.
7. Frontend `agendar/[slug]/page.tsx` (server component) — lee `?t=`, hidrata en el server (evita flash), pasa `prefill` al `ScheduleForm`.
8. `ScheduleForm` — pre-llena `name` + `phone` desde el prefill. `phone` va **readonly** cuando `phoneEditable === false` (bot ya conoce el número — no queremos que lo cambien y rompan el linkeo).

### Trigger inicial en el bot

Se cablea el `buildSchedulingLink()` en el caso LID sin phone (`bot.service.ts`). En vez de rebotar al paciente, el bot manda:

> "Para terminar de agendar necesito tu número de teléfono. Completá tu cita acá — el link vence en 30 minutos: {URL}"

y resetea la FSM. Cuando el paciente completa el form, la cita se crea con `source=BOT_WEB` y `conversationId` — el bot puede detectarlo en interacciones futuras.

## Alternativas consideradas

### 1. Link genérico sin token

`{WEB_BASE_URL}/agendar/${slug}` — cero backend, cero storage. Pero pierde el contexto: el paciente tiene que re-tipear name/phone que ya conocemos. Fricción tonta, se pierde el punto de haber tenido la conversa.

**Rechazado**: el ROI del token es alto y la deuda técnica evitada (form vacío desde WA) es grande.

### 2. Querystring con PII (`?name=Juan&phone=549...`)

Fácil de implementar (~2h). Pero el link tiene datos personales visibles: si el paciente lo reenvía, queda en historial del navegador de otro, se cachea en CDN, aparece en logs de red. En vertical clínicas es un **NO** — legal/compliance no lo pasa.

**Rechazado**: viola el principio de minimizar PII en URLs (ADR 0017 sobre webhook hardening ya establece esta postura).

### 3. Tabla Postgres en vez de Redis

Ventaja teórica: consultable, auditable. Pero es sobre-ingeniería para un dato efímero de 30 min. Una tabla más, una migración más, queries más, y la ventaja "auditable" ya la tenemos vía `Appointment.source=BOT_WEB` + `conversationId` — cuando la cita se crea, la evidencia queda ahí. El token en sí no es interesante después de consumido.

**Rechazado**: Redis es la herramienta correcta para TTL nativo + operaciones atómicas + zero-migration.

### 4. JWT firmado en vez de nanoid + storage

Ventaja: stateless, no hace falta Redis. Pero el JWT tendría que llevar `conversationId + clinicId + phone + name` — o firmamos un token opaco y volvemos a necesitar storage. Además revocar un JWT requiere una blacklist (más storage). Con nanoid+Redis, revocar es `DEL key`.

**Rechazado**: la simplicidad de "un ID opaco + un TTL" gana a la complejidad de JWT + revocation list.

### 5. Estado FSM `AWAITING_WEB_BOOKING`

Considerado inicialmente en el plan. La idea era que el bot esperara activamente al webhook de "cita creada por token X" y confirmara al paciente por WA "listo, ya vi tu cita". No implementado en este PR porque:

- La cita creada trae `conversationId` — el bot puede detectarla vía query cuando el paciente vuelva a escribir.
- El TTL de 30 min ya limita el "estado colgado" sin necesidad de un timer bot-side.
- Agregar el estado obliga a manejar "timeout expira sin webhook" — más complejidad para una ganancia marginal.

**Deferido**: se puede agregar más adelante si medimos que muchos pacientes escriben "listo" al bot después de completar el form y necesitan feedback inmediato.

## Consecuencias

### Positivas

- **Zero fricción para LID**: caso antes irrecuperable ahora convierte.
- **Multi-tenant safe**: token guarda `clinicSlug`, el endpoint valida contra el `:slug` de la URL. Cero fuga entre tenants aunque el link se filtre.
- **Trazabilidad**: `Appointment.source=BOT_WEB` + `conversationId` permite reportar en dashboard "cuántas citas venían del bot vs. link público vs. bot escalado".
- **Fail-safe**: si Redis está caído, el bot NO manda link (el `create` tira) y cae al mensaje de error genérico — mejor que mandar un link que ya está roto.
- **Un token, una cita**: `consume()` atómico via pipeline previene doble-uso por doble-click.
- **PII fuera de URL**: name/phone viven en Redis, no en el query string.

### Negativas

- **Nueva dependencia soft**: el bot ahora depende del web frontend estando disponible. Si `WEB_BASE_URL` está mal configurado, los links son inútiles. Mitigación: monitorear tasa de conversión de `source=BOT_WEB` en el dashboard.
- **UX degradada si Redis está caído**: sin Redis no hay tokens, así que el bot cae al mensaje genérico. Vale — Redis ya es dependencia dura del proyecto (BullMQ, rate-limit).
- **`WEB_BASE_URL` es un nuevo env var más a mantener**: agregado a `.env.example` con default sano.

### Neutrales

- **Refactor global de `REDIS_CLIENT`**: se extrajo a un `RedisModule` global. Sin cambios de comportamiento para consumidores existentes (rate-limit sigue funcionando idéntico). Deja la casa mejor de lo que la encontramos.

## Notas de implementación

- El endpoint público `/public/scheduling/session/:token` NO tiene `slug` en la ruta — el token es su propio identificador y ya trae el `clinicSlug` embebido. El rate-limit usa scope explícito `'sched-sess'` en vez del slug del path.
- El caso `@lid` sigue trayendo `phone: null` al form (se pide como required editable). El caso `@c.us` trae `phone` readonly. La distinción se hace via `phoneEditable: boolean` en el response del hydrate — así el frontend no tiene que conocer el mecanismo LID.
- El token expira en 30 min. Es un balance: suficiente para completar el flujo con distracciones normales (llamada entrante, cambio de app), no tanto como para que el paciente vuelva "el próximo día" y espere que funcione.

## Enlaces

- [[0010-whatsapp-lid-y-contact-info]] — el caso `@lid` que motivó parte de esta feature.
- [[0017-webhook-hmac-cookie-hardening]] — postura general del proyecto sobre minimizar PII en URLs.
- `apps/backend/src/scheduling/scheduling-session.service.ts` — implementación.
- `apps/backend/src/public/scheduling-session.controller.ts` — endpoint de hidratación.
- `apps/backend/src/bot/bot.service.ts` — trigger inicial en el caso LID.
