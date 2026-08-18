# Onboarding de una clínica nueva — Playbook

Guía paso a paso para dar de alta una clínica real en Showly. Escrito
pensando en un onboarding manual (todavía **NO** hay endpoint `POST /clinics`
en la API — ver §2 para el fallback vía Prisma).

Tiempo estimado con todo pre-configurado: **~45 minutos**. Objetivo de PRD:
< 1 hora.

> Notas relacionadas: [[PRD]] §8 (criterios de éxito), [[ARCHITECTURE]]
> (multi-tenant, WAHA), [[adr/0004-pii-y-compliance]], [[adr/0005-auth-mvp-y-deuda]],
> [[adr/0006-panel-mvp-y-deuda]], [[runbook-panel]], [[smoke-e2e]].

---

## 1. Pre-requisitos

Antes de arrancar el onboarding, la clínica debe tener:

- **Un número de WhatsApp DEDICADO** para el bot. **No uses el número
  personal del dueño**. WAHA es no oficial y el riesgo de baneo, aunque bajo
  con volumen moderado, existe. Ver [[adr/0002-waha-no-oficial]].
- **Dominio** (opcional pero recomendado): `panel.tuclinica.com` para el
  panel y `agenda.tuclinica.com` (o `showly.dev/agendar/<slug>`) para
  la página pública. Si no hay dominio propio, el piloto puede correr
  contra el dominio de Showly.
- **Datos de la clínica**: nombre comercial, dirección, TZ, teléfono
  público, formas de pago aceptadas, horario de atención.
- **Catálogo inicial**: servicios (con duración y buffer entre citas) y
  profesionales.
- **Servidor** con la infra Showly arriba. Ver [[deploy]] para el setup
  productivo (Hetzner / VPS + Docker Compose + Caddy).
- **Variables de entorno productivas** ya cargadas en el servidor:
  `JWT_SECRET` (openssl rand base64 48), `WAHA_API_KEY`, `WEBHOOK_TOKEN`,
  `DEEPSEEK_API_KEY`, `GEMINI_API_KEY`, `OPENAI_API_KEY` (opcional, para
  FAQ), `CORS_ORIGINS`, `TRUST_PROXY=true` si hay proxy delante.

---

## 2. Crear el registro `Clinic`

> **Deuda documentada**: hoy no hay `POST /api/clinics`. Está en el roadmap
> post-piloto. Por ahora, tres alternativas.

### 2.a. Snippet Prisma Studio (recomendado)

```bash
cd apps/backend
pnpm prisma studio
# Abre localhost:5555 → tabla Clinic → New record
```

Campos obligatorios:

| Campo               | Valor                                        |
|---------------------|----------------------------------------------|
| `slug`              | ej. `clinica-santa-fe` (URL-safe, minúsculas, sin acentos, único) |
| `name`              | Nombre comercial (ej. `Clínica Santa Fe`)    |
| `timezone`          | ej. `America/Caracas`, `America/Sao_Paulo`   |
| `locale`            | `es` o `pt`                                  |
| `wahaSession`       | Nombre único (ej. `clinica-santa-fe`; se usa como sesión WAHA) |
| `address`           | Dirección física (aparece en confirmaciones)  |
| `reminderOffsetsH`  | `[24, 3]` por default. Ajustar si la clínica prefiere otra cadencia. |
| `confirmThresholdH` | `6` por default. Horas sin confirmar antes de marcar EN_RIESGO. |
| `autoConfirm`       | `false` por default. `true` si querés que las citas nazcan CONFIRMADA. |

### 2.b. Snippet SQL directo (fallback)

Corré esto conectado a la DB productiva (`psql`, PgAdmin, DBeaver, etc.):

```sql
INSERT INTO "Clinic" (
  id, slug, name, timezone, locale, "wahaSession",
  address, "reminderOffsetsH", "confirmThresholdH", "autoConfirm",
  "createdAt", "updatedAt"
) VALUES (
  gen_random_uuid()::text,      -- o usar el CUID del backend si tenés uno
  'clinica-santa-fe',
  'Clínica Santa Fe',
  'America/Caracas',
  'es',
  'clinica-santa-fe',           -- wahaSession
  'Av. Libertador 123, Caracas',
  ARRAY[24, 3],
  6,
  false,
  NOW(), NOW()
) RETURNING id;
```

Guardá el `id` retornado — lo vas a necesitar para crear el user
`CLINIC_ADMIN`.

### 2.c. Crear el user admin de la clínica

Después de crear el `Clinic`, creá un `User` con rol `CLINIC_ADMIN` desde
Prisma Studio (o el equivalente SQL). El password debe ir **hasheado con
bcrypt(10)**:

```bash
# Generar el hash desde una shell Node
cd apps/backend
node -e "require('bcrypt').hash('CAMBIAR_ESTE_PASSWORD', 10).then(console.log)"
```

Luego en Studio:

| Campo      | Valor                                             |
|------------|---------------------------------------------------|
| `email`    | `recepcion@clinica-santa-fe.com` (lowercase)       |
| `password` | El hash bcrypt de arriba                          |
| `name`     | `Recepción Santa Fe`                              |
| `role`     | `CLINIC_ADMIN`                                    |
| `clinicId` | El ID del `Clinic` creado en 2.a o 2.b            |

Comunicá el password inicial al equipo de la clínica por un canal seguro
(NO email, NO WhatsApp — usá signal, WhatsApp desde el número de la
persona con auto-borrado, o entregalo en persona).

> **Deuda**: no hay password reset. Si el user pierde el password, entrás
> a la DB y le seteas un hash nuevo. Ver [[adr/0005-auth-mvp-y-deuda]] §6.

---

## 3. Sesión WAHA

WAHA es el gateway a WhatsApp. Cada clínica tiene su propia **session**
(nombre igual al `wahaSession` del `Clinic`).

### 3.a. Crear la sesión (flujo primario: desde el panel)

Desde que se cerró el bloque [[adr/0008-panel-conexion-waha-y-observabilidad]],
el flujo recomendado es hacer todo desde el propio panel de la clínica —
el `CLINIC_ADMIN` no necesita acceso al dashboard nativo de WAHA.

1. Login en el panel con el user `CLINIC_ADMIN` creado en 2.c
   (`https://<panel-host>/es/login`).
2. Ir a `/panel/config/whatsapp`.
3. Presionar **Conectar**. El backend hace `POST /api/clinics/me/waha/start`
   contra la sesión derivada de `clinic.wahaSession` (nunca se acepta el
   nombre de sesión del cliente).
4. El panel entra en polling adaptativo (2s en transiente, 15s cuando ya
   está WORKING). Cuando el status pasa a `SCAN_QR_CODE`, el QR aparece
   embebido en la pantalla del panel.

Ventaja frente al dashboard de WAHA: aislamiento multi-tenant real
(cada admin ve **sólo** su sesión, no las del resto de clínicas).

### 3.a.bis. Fallback avanzado — dashboard/API de WAHA

Sólo para el equipo técnico de Showly cuando el panel no alcanza
(troubleshooting, automatizaciones, provisioning masivo):

- Dashboard: `http://<host>:3000/dashboard`, protegido por
  `WAHA_DASHBOARD_USERNAME` / `WAHA_DASHBOARD_PASSWORD`.
- API directa (necesita `WAHA_API_KEY`):

  ```bash
  curl -X POST http://<host>:3000/api/sessions \
    -H "Content-Type: application/json" \
    -H "X-Api-Key: $WAHA_API_KEY" \
    -d '{"name": "clinica-santa-fe", "start": true}'
  ```

No usar estos accesos para operar clínicas reales — todo el operativo
diario va por el panel.

### 3.b. Escanear el QR

Con el flujo del panel, el QR aparece directamente en
`/panel/config/whatsapp` cuando el status es `SCAN_QR_CODE`. Escanealo
con el WhatsApp del **número dedicado de la clínica** (no del dashboard
de WAHA — el QR es exactamente el mismo, pero servido con el aislamiento
por clínica del panel).

Confirmación: el status en el panel pasa a `WORKING` (badge verde
"Conectado"). El bot ya puede recibir y enviar mensajes.

### 3.c. Configurar el webhook

El backend recibe eventos de WAHA en `POST /webhooks/waha` (protegido por
`WEBHOOK_TOKEN` en producción). En el compose ya está seteado con la env
`WHATSAPP_HOOK_URL=http://backend:4000/webhooks/waha`.

Si estás usando WAHA aparte (no via nuestro compose), configurá también
`WHATSAPP_HOOK_HEADERS='x-webhook-token: <MISMO_TOKEN_QUE_WEBHOOK_TOKEN>'`
para que el backend valide el header custom.

---

## 4. Verificar la conexión WAHA

Verificación primaria desde el panel: entrar a `/panel/config/whatsapp`
y confirmar que el badge muestra **Conectado** (verde). Ese badge es el
proxy visual de `GET /api/clinics/me/waha/status` devolviendo
`{ status: 'WORKING' }`.

Si el badge queda en `STARTING` / `SCAN_QR_CODE` / `FAILED` / `UNKNOWN`,
seguir el flujo del panel (re-escanear el QR o presionar Conectar). Ver
[[adr/0008-panel-conexion-waha-y-observabilidad]] para el detalle de
cada estado y el polling adaptativo.

Alternativa para el equipo técnico (backend engineers con acceso a la
API de WAHA):

```bash
curl -H "X-Api-Key: $WAHA_API_KEY" \
  http://<host>:3000/api/sessions/clinica-santa-fe
```

Esperado: JSON con `"status": "WORKING"`.

Smoke funcional: mandale "hola" al número desde tu WhatsApp personal. En
el panel, en la Bandeja, tenés que ver aparecer la conversación con la
respuesta del bot.

---

## 5. Cargar el catálogo desde el panel

Login: `https://<panel-host>/es/login` con las credenciales creadas en 2.c.

Orden recomendado:

1. **Servicios** (`/panel/servicios`): crear cada servicio con nombre,
   duración en minutos, buffer entre citas (para preparar consultorio),
   precio (opcional). Marcar `active=true`.

2. **Profesionales** (`/panel/profesionales`): crear cada profesional con
   nombre y asociar los servicios que atiende (M-N). Si un profesional
   sólo hace un tipo de consulta, asocialo sólo a ese servicio.

3. **Horarios** (`/panel/horarios`): definir horario semanal por
   profesional (o por clínica si todos tienen el mismo). Formato: día de
   la semana + hora inicio + hora fin. Los slots del bot se derivan de acá.

   > Tip: para pausa del mediodía, creá **dos bloques** por día. Ej.
   > `L: 09:00-13:00` y `L: 14:00-18:00`.

4. **Bloqueos** (`/panel/bloqueos`): feriados, vacaciones, licencia. Formato:
   fecha/hora inicio + fecha/hora fin + razón (opcional). Estos bloques
   invalidan cualquier slot que caiga adentro, aunque exista BusinessHour.

---

## 6. Cargar FAQ inicial

En `/panel/faq`, crear al menos **5 preguntas frecuentes** con respuestas
completas. Ejemplos:

- Horario de atención.
- Dirección + referencias.
- Formas de pago.
- Qué llevar a la primera consulta.
- Cómo cancelar / reprogramar.

Comportamiento:

- Si `OPENAI_API_KEY` está seteada en el backend, los embeddings se
  generan automáticamente al crear la FAQ. El bot puede responder
  preguntas por RAG.
- Si NO está seteada, el chunk se guarda sin embedding y aparece el header
  `X-Warning: embedding-skipped-no-openai-key` en la response. El bot NO
  responderá con esa FAQ — hará handoff a humano.
- Después de setear la key, correr:

  ```bash
  pnpm --filter @showly/backend prisma:reindex-faq
  ```

  Procesa todas las FAQs con `embedding IS NULL` y las embed. Idempotente.

> Ver [[notas/2026-08-09-rag-faq]] para detalles del threshold, prompt
> anti-injection y fallback.

---

## 7. Configurar recordatorios

> **Deuda documentada**: no hay UI para editar `reminderOffsetsH` /
> `confirmThresholdH` / `autoConfirm`. Cambio via SQL o Prisma Studio.

Los defaults son sanos para la mayoría de las clínicas:

- `reminderOffsetsH = [24, 3]` — recordatorio 24h antes y 3h antes.
- `confirmThresholdH = 6` — si a las 6h del recordatorio no confirmó, la
  cita pasa a EN_RIESGO.
- `autoConfirm = false` — la cita nace PENDIENTE y espera confirmación
  del paciente.

Casos donde ajustar:

- **Clínicas de emergencia / walk-in**: `autoConfirm = true` +
  `reminderOffsetsH = [3]` (solo recordatorio corto).
- **Servicios largos (estudios, cirugías menores)**: `reminderOffsetsH =
  [48, 24, 3]` (mayor cadencia porque el impacto del no-show es más caro).
- **Segmento poco responsivo por WhatsApp**: `confirmThresholdH = 12` para
  darle más margen antes de marcar EN_RIESGO.

Cambio via SQL:

```sql
UPDATE "Clinic"
SET "reminderOffsetsH" = ARRAY[48, 24, 3],
    "confirmThresholdH" = 12,
    "autoConfirm" = true
WHERE slug = 'clinica-santa-fe';
```

Nota: los cambios NO afectan citas ya creadas (los jobs BullMQ ya están
programados con los offsets viejos). Sólo aplican a citas nuevas. Si
necesitás re-programar recordatorios de citas existentes, hoy no hay
comando — se hace manualmente.

---

## 8. Test smoke rápido

Con todo cargado, hacé el mini-flujo end-to-end:

### 8.a. Bot desde WhatsApp

Desde tu WhatsApp personal:

1. Escribí `hola` al número de la clínica. Esperá respuesta amable del bot.
2. Escribí `quiero una cita`. El bot pregunta por servicio.
3. Elegí el servicio por número o nombre. El bot pregunta por profesional.
4. Elegí el profesional. El bot muestra los próximos slots libres.
5. Elegí un slot por número. El bot pregunta el nombre (si es la primera vez).
6. Confirmá con `sí`. El bot crea la cita y responde con detalles.

### 8.b. Verificación en panel

Entrá al panel `/es/panel/agenda`. La cita recién creada debe aparecer con
estado PENDIENTE (o CONFIRMADA si `autoConfirm=true`), en la fecha/hora
elegida.

### 8.c. Verificación en Redis

```bash
docker exec showly-redis-1 redis-cli KEYS 'bull:reminders:*' | head
```

Esperado: keys tipo `bull:reminders:reminder-<id>` y `bull:reminders:risk-<apptId>`.
Si no aparecen: revisar que el backend logueó el schedule OK y que la cita
está a más de 3h de "ahora" (offsets pasados se omiten).

---

## 9. Test del panel

Con las credenciales de recepción entregadas a la clínica, el equipo debe:

- **Login**: `https://<panel-host>/es/login`.
- **Agenda**: vista del día actual → deben aparecer las citas de hoy.
- **Bandeja**: la conversación del smoke debe estar visible.
- **Dashboard**: números aún cero (o casi) porque recién arranca.

Ver [[runbook-panel]] para el walk-through completo.

---

## 10. Test de recordatorios

Antes de dejar la clínica operar sola, validá que los recordatorios
efectivamente llegan al paciente.

1. **Agendar una cita para dentro de ~4 horas**: desde el panel
   (`/panel/agenda` → "Nueva cita") o via el bot desde tu WhatsApp
   personal.
2. **Esperar**: a los ~1 hora (o cuando la cita esté a 3h de distancia),
   debería llegar el recordatorio al chat del paciente.
3. **Responder `sí`** desde WhatsApp → verificar que la cita en el panel
   pasa a CONFIRMADA (refresh manual, no hay WebSocket todavía).
4. **Alternativa**: cancelar la cita del paciente respondiendo `cancelar`
   → panel muestra CANCELADA.

Si el recordatorio no llega:

- Revisar `docker logs showly-backend-1 | grep -i reminder` para ver si
  el job disparó.
- Revisar el estado de la sesión WAHA. Si está en `FAILED` o
  `SCAN_QR_CODE`, hay que re-escanear.

---

## 11. Página pública

Si la clínica quiere ofrecer también agendamiento por web:

- URL: `https://<web-host>/es/agendar/clinica-santa-fe` (reemplazar por el
  slug).
- No requiere auth. El paciente completa nombre, teléfono E.164, elige
  servicio + slot y submitea. Rate-limit 5/min por IP+slug (ADR 0003).
- Redirige a `/gracias` en éxito. Sin PII en query string (nombre viaja
  por sessionStorage).

Compartir el link en la bio de Instagram / firma de email / QR en la
recepción física.

---

## 12. Troubleshooting

| Síntoma | Causa probable | Fix |
|---------|----------------|-----|
| El bot no responde a "hola" | Sesión WAHA caída, webhook mal configurado, o backend caído. | Verificar sesión en `/dashboard` de WAHA. Verificar `docker logs showly-backend-1`. Verificar `WHATSAPP_HOOK_URL` en la env de WAHA. |
| WAHA se desconecta seguido | Uso desde el celular con el mismo número en WhatsApp Web, wifi inestable en el server, o política anti-abuso de WhatsApp. | Cerrá WhatsApp Web en el celular. Reiniciá la sesión WAHA. Si persiste, número candidato a baneo — evaluá reducir volumen. |
| El bot dice "no hay slots disponibles" | Todos los slots del rango están tomados, o BusinessHour mal configurado, o TimeOff cubre el rango. | Revisar `/panel/horarios` para el profesional. Revisar `/panel/bloqueos`. Consultar `GET /api/availability?serviceId=X&professionalId=Y&from=YYYY-MM-DD&days=7` con JWT admin para ver la lista cruda. |
| Recordatorio no llegó | Cita a menos de 3h al crearla (offsets se omiten en el pasado), o la sesión WAHA se cayó entre crear y disparar, o Redis se reinició. | Revisar `SELECT status, jobId FROM "Reminder" WHERE "appointmentId"='X'`. Si `jobId IS NULL` → el schedule falló al crearse (bug — reportar). Si `status=SCHEDULED` pero pasó el `fireAt` → el worker no está corriendo, revisar `docker logs`. |
| Login rechaza credenciales correctas | Rate-limit por email (5 fails en 15 min bloquean por 15 min más). O password mal hasheado. | Esperar 15 min. Regenerar hash bcrypt y actualizar en DB. |
| Panel muestra 401 y redirige a login | JWT expiró (24h de vida, sin refresh) — [[adr/0005-auth-mvp-y-deuda]] §2. | Re-login. |
| FAQ nunca responde por RAG | `OPENAI_API_KEY` no seteada, o FAQ creada sin embedding y no se corrió `prisma:reindex-faq`. | Verificar env. Correr reindex. |
| Página pública `/agendar/<slug>` da 404 | El slug no matchea (case-sensitive), o el pipe de validación rechaza el formato. | Slug debe ser `^[a-z0-9-]{1,50}$`. Sin mayúsculas ni acentos. |

---

## 13. Post-onboarding

- **Semana 1**: monitoreo diario. Revisar dashboard, bandeja, logs. Ajustar
  `reminderOffsetsH` si hay señales de que 24h es tarde o 3h es tarde.
- **Semana 2**: reunión con la clínica para feedback. Anotar en la
  [[bitacora]] los learnings.
- **Cuando llegue la 2da clínica**: revisar la deuda de este documento y
  cerrar al menos: `POST /clinics`, `GET /clinics/:id/waha/status`, UI de
  edición de `reminderOffsetsH`, password reset.

## 14. Deuda del onboarding (endpoints faltantes)

> Actualizado 2026-08-09: items 3 y 4 (endpoints WAHA) cerrados por
> [[adr/0008-panel-conexion-waha-y-observabilidad]]. La lista se
> renumeró en consecuencia.

Documentado para post-piloto:

1. `POST /api/clinics` (SUPERADMIN) — hoy via Prisma Studio o SQL.
2. `POST /api/clinics/:id/users` (SUPERADMIN) — hoy via Studio + bcrypt CLI.
3. UI `/panel/config` para editar `reminderOffsetsH`, `confirmThresholdH`,
   `autoConfirm` — hoy via SQL/Studio.
4. Password reset flow — hoy via SQL + bcrypt CLI.

Referencias: [[SPEC]] §1 (Clínicas), [[adr/0005-auth-mvp-y-deuda]].
