# Smoke E2E — Checklist antes de mostrar a la clínica

Validación integral del sistema. Correr **completo** antes de:

- La primera demo a la clínica piloto.
- Cada deploy productivo mayor.
- Cambios grandes en `SchedulingService`, `RemindersService`, `BotModule`
  o `PublicController`.

Tiempo estimado: **~30 minutos** con todo pre-configurado.

Convención: cada paso tiene un checkbox. Al final hay una matriz de
resultados observados vs esperados.

---

## 0. Pre-check

- [ ] `docker compose ps` muestra `db`, `redis`, `waha` (y `backend` si lo
      levantás dentro del compose) como `Up`. Si corrés el backend en el host
      (`pnpm dev:backend`), no va a aparecer acá — es normal, validá con
      `curl -s http://localhost:4000/api/health` que responda.
- [ ] `curl -s http://localhost:4000/api/dashboard/metrics -o /dev/null -w "%{http_code}"` → **401** (sin token, ok).
- [ ] `curl -s http://localhost:3002/es/agendar/demo -o /dev/null -w "%{http_code}"` → **200** (web arriba, ruta pública responde).
- [ ] Seed refrescado en los últimos 24h. Correr si no:
      ```bash
      pnpm --filter @showly/backend prisma db seed
      ```
- [ ] Verificar credenciales dev disponibles: `admin@demo.dev / demo1234`,
      `super@showly.dev / super1234`.
- [ ] **LLM del bot**: los pasos que dependen de intención (`quiero una cita`,
      `¿cuáles son los horarios?`, handoff por intención) requieren al menos una
      key LLM en la env del backend (`DEEPSEEK_API_KEY`, `GEMINI_API_KEY` u
      `OPENCODE_API_KEY`+`OPENCODE_BASE_URL`+`OPENCODE_PLAN`). Sin ninguna key,
      `intent.detect` degrada a `otro` y la FSM nunca arranca. Verificar:
      ```bash
      # sin key → "todos los LLM fallaron" al primer POST de intención
      grep -E "DEEPSEEK_API_KEY|GEMINI_API_KEY|OPENCODE_API_KEY" .env
      ```
- [ ] Webhook: si `WEBHOOK_HMAC_SECRET` está seteada en la env, **gana HMAC** y
      el header `x-webhook-token` ya no alcanza (403). Para el smoke dejar
      `WEBHOOK_HMAC_SECRET` vacía (default de `.env.example`) o computar el HMAC.
      `ALLOW_WEBHOOK_WITHOUT_TOKEN=true` es otra opción solo en dev.
- [ ] (Opcional, acelera el smoke) `BOT_TYPING_ENABLED=false` elimina el delay de
      "escribiendo…" por mensaje del bot (ahorra ~1-4s por respuesta).
- [ ] Sesión WAHA `demo-session` en estado `WORKING`:
      ```bash
      curl -s -H "X-Api-Key: $WAHA_API_KEY" \
        http://localhost:3000/api/sessions/demo-session | \
        python3 -c "import json,sys; print(json.load(sys.stdin)['status'])"
      ```

---

## 1. Login del panel

- [ ] Navegar a `http://localhost:3002/es/login`.
- [ ] Login con `admin@demo.dev` / `demo1234`.
- [ ] Redirect a `/es/panel/dashboard` (el índice `/es/panel` redirige ahí).
- [ ] Cards visibles:
  - Tasa de no-show (esperado ~20%, del seed).
  - Distribución por estado (ATENDIDA=22, CANCELADA=6, NO_SHOW=6).
  - KPI "Confirmación" (tasa de confirmación — el dashboard NO muestra un
    conteo de "confirmaciones enviadas"; si querés ver pendientes de
    confirmación, mirá el panel `pendingConfirmation`).
  - Trend con 14 barras (últimos 14 días).

- [ ] Navegar a `/es/panel/agenda` — deben aparecer citas del seed.
- [ ] Navegar a `/es/panel/conversaciones` — deben aparecer 2 conversaciones
      seed (una BOT, una NEEDS_HUMAN).

---

## 2. Escenario 1 — Bot agenda por WhatsApp (simulado por webhook)

Simulamos los mensajes entrantes del paciente vía POST directo al
webhook. Necesitamos el `WEBHOOK_TOKEN` en la env (dev vale
`dev-webhook-token`).

Variables:

> **IMPORTANTE**: el bot responde a `$CHAT_ID` vía `sendText` de WAHA real.
> Si `from` no es un número WhatsApp válido (registrado), `sendText` falla y el
> POST al webhook devuelve **500**. Por eso `PHONE` tiene que ser un E.164 real
> de prueba (el mismo que usás en los Escenarios 4/5), no un ID inventado.

```bash
export PHONE="+584141234567"          # ← tu número E.164 de prueba (real)
export CHAT_ID="${PHONE#+}@c.us"
export TOKEN=$(curl -s -X POST http://localhost:4000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@demo.dev","password":"demo1234"}' | \
  python3 -c "import json,sys; print(json.load(sys.stdin)['accessToken'])")
```

(El `TOKEN` hoy no se usa en los comandos del smoke — quedó de una versión
anterior 100% por API. Se puede ignorar.)

Helper para postear un mensaje entrante:

```bash
send_msg() {
  curl -s -X POST http://localhost:4000/webhooks/waha \
    -H "Content-Type: application/json" \
    -H "x-webhook-token: dev-webhook-token" \
    -d "{
      \"event\": \"message\",
      \"session\": \"demo-session\",
      \"payload\": {
        \"id\": \"msg-$(date +%s%N)\",
        \"from\": \"$CHAT_ID\",
        \"body\": \"$1\",
        \"fromMe\": false
      }
    }"
}
```

Flujo:

- [ ] `send_msg "hola"` → **200** con `{"ok":true}`.
- [ ] `send_msg "quiero una cita"` → bot pregunta servicio.
- [ ] `send_msg "consulta general"` → bot pregunta profesional (o pasa a slots si sólo hay uno).
- [ ] `send_msg "1"` → bot lista slots.
- [ ] `send_msg "1"` → bot pregunta nombre (paciente nuevo).
- [ ] `send_msg "María Test"` → bot pide confirmación.
- [ ] `send_msg "sí"` → bot confirma la cita creada.

Verificación:

- [ ] En el panel `/es/panel/agenda`, la cita aparece con estado
      `PENDIENTE` y hora seleccionada.
- [ ] Verificar en DB:
      ```bash
      # Resolvés el id de la clínica demo por su slug — evita hardcodear el
      # cuid del seed (cambia si re-seedeás desde cero).
      DEMO_CID=$(docker compose exec -T db psql -U showly -tAc \
        "SELECT id FROM \"Clinic\" WHERE slug='demo'")
      echo "Demo clinic ID: $DEMO_CID"

      docker exec showly-db-1 psql -U showly -d showly -c \
        "SELECT id, status, \"startAt\", notes FROM \"Appointment\"
         WHERE \"clinicId\"='$DEMO_CID'
           AND \"createdAt\" > NOW() - INTERVAL '5 minutes'
         ORDER BY \"createdAt\" DESC LIMIT 3;"
      ```
- [ ] Verificar recordatorios programados en Redis:
      ```bash
      docker exec showly-redis-1 redis-cli --scan --pattern 'bull:reminders:*' | head -20
      ```
      Esperado (depende de cuánto falta para el slot elegido):
      - Jobs `reminder-*`: **2** si el slot está a **>24h** (offsets 24h + 3h),
        **1** (sólo el de 3h) si está a ≤24h — los recordatorios en el pasado no
        se programan.
      - Job `risk-<apptId>`: **1 sólo si** el slot está a **>6h** (umbral
        `confirmThresholdH`, default 6). Si el slot elegido es hoy/menos de 6h,
        no hay job de riesgo.

---

## 3. Escenario 2 — Panel cancela una cita

- [ ] Desde `/es/panel/agenda`, hacer click en la cita creada en
      Escenario 1.
- [ ] En el modal, cambiar el estado a `CANCELADA`.
- [ ] Toast de éxito.
- [ ] Verificar en DB:
      ```bash
      docker exec showly-db-1 psql -U showly -d showly -c \
        "SELECT status, \"canceledAt\" FROM \"Appointment\" WHERE id='<APPT_ID>';"
      ```
      Esperado: `status=CANCELADA`, `canceledAt` con timestamp reciente.
- [ ] Verificar Redis limpio:
      ```bash
      docker exec showly-redis-1 redis-cli --scan --pattern 'bull:reminders:*reminder-*' | wc -l
      ```
      Los jobs del appointment cancelado deben haberse eliminado.
- [ ] Verificar reminders en DB:
      ```bash
      docker exec showly-db-1 psql -U showly -d showly -c \
        "SELECT status FROM \"Reminder\" WHERE \"appointmentId\"='<APPT_ID>';"
      ```
      Esperado: todos `CANCELED`.

---

## 4. Escenario 3 — Público agenda desde la web

> Este escenario (más el 404 de slug inexistente y el doble booking → 409)
> está **automatizado** con Playwright: `scripts/e2e-local.sh` en local y el
> job `e2e` en CI. Ver §12. El checklist manual sigue valiendo para la demo.

- [ ] Nueva ventana / incógnito: `http://localhost:3002/es/agendar/demo`.
- [ ] Página muestra formulario con:
  - Info de la clínica (nombre, dirección).
  - Select de servicios.
  - Select de profesional.
  - Fecha + slots.
  - Campos paciente (nombre, teléfono).
  - Checkbox consent.
  - Honeypot invisible.

- [ ] Elegir servicio → luego **elegir profesional** (los slots recién se cargan
      con servicio Y profesional seleccionados).
- [ ] Elegir profesional — **obligatorio** (el form no tiene opción
      "cualquiera": `professionalId` es requerido por zod y el backend).
- [ ] Elegir slot → los slots se listan agrupados por día.
- [ ] Completar nombre + teléfono E.164 válido (ej. `+584141234567`).
- [ ] Marcar consent.
- [ ] Submit.
- [ ] Redirect a `/es/agendar/demo/gracias`.
- [ ] Página de gracias muestra fecha + hora + nombre (del sessionStorage).
- [ ] Verificar en el panel `/es/panel/agenda` que la cita aparece.

Bonus checks:

- [ ] Intentar submitear el form con teléfono inválido (ej. `123`) →
      validación de zod bloquea.
- [ ] Intentar submitear con nombre vacío → validación bloquea.
- [ ] Enviar 6 requests rápidas al POST **dentro de la misma ventana de 60s**
      (contando el submit exitoso de arriba si fue hace <1 min) →
      la que supera el límite devuelve **429** con header `Retry-After: 60`
      (el límite es 5/min por IP+slug).

---

## 5. Escenario 4 — Recordatorio anti no-show

**Requisito**: WAHA conectada al número de tu WhatsApp personal (podés
usarlo como paciente de test).

- [ ] Desde el panel, crear cita para dentro de **~4 horas** para tu
      teléfono. Estado inicial: PENDIENTE.
- [ ] Verificar en Redis: **1 job `reminder-*`** (sólo el offset de 3h — el de
      24h cae en el pasado y no se programa) y **ningún job `risk-*`** (el job
      de riesgo se programa sólo si la cita está a **>6h**, umbral
      `confirmThresholdH`). Si querés ver 2 `reminder-*` + 1 `risk-*`, creá la
      cita a **~25h** y saltá el paso del mensaje (o forzá el job, ver abajo).
- [ ] Esperar hasta que la cita esté a 3h (o menos). Job dispara el
      recordatorio.
- [ ] Recibir mensaje en tu WhatsApp: "Recordatorio de tu cita..."
- [ ] Responder `sí` desde WhatsApp.

> **OJO — prefijo del teléfono**: el webhook deriva el `phone` del chatId sin
> `+` (`584141234567`) mientras que el panel guarda el paciente con `+`
> (`+584141234567`). Si la cita del panel se creó con `+`, el bot NO encuentra
> el paciente al responder `sí` y no confirma. Workaround para el smoke: crear
> la cita del Escenario 1 con el mismo `PHONE` (el bot guarda el paciente sin
> `+`, que es lo que matchea la respuesta) o pedir por API con el número sin
> `+`. **Corrección de código pendiente** (rompe el flujo real
> página-pública + recordatorio + confirmación): normalizar el `phone` en un
> solo punto — recomendado en `BotService.findUpcomingAppointment` y en el
> upsert de `SchedulingService.createAppointment` (o derivar `+` en
> `webhook.controller.ts`).

- [ ] Verificar que la cita en el panel pasa a `CONFIRMADA` (refresh
      manual).
- [ ] Verificar en DB:
      ```sql
      SELECT status, "confirmedAt" FROM "Appointment" WHERE id='<APPT_ID>';
      ```
      Esperado: `status=CONFIRMADA`, `confirmedAt` con timestamp reciente.
- [ ] Verificar que el `risk-*` fue eliminado de Redis.

**Alternativa sin esperar** (editar `reminder.fireAt` en la DB **NO alcanza**:
el delay ya quedó fijo en la ZSET `bull:reminders:delayed` de BullMQ). Para
disparar el job `send-reminder` antes, mové el job de delayed al pasado y el
scheduler lo promueve en el próximo tick (~500ms):

```bash
RID=$(docker exec showly-db-1 psql -U showly -d showly -tAc \
  "SELECT id FROM \"Reminder\" WHERE \"appointmentId\"='<APPT_ID>' AND status='SCHEDULED' LIMIT 1")
docker exec showly-redis-1 redis-cli ZADD "bull:reminders:delayed" 1 "reminder-$RID"
```

---

## 6. Escenario 5 — Handoff a humano

- [ ] `send_msg "quiero hablar con una persona"` → bot responde
      "Enseguida te atiende una persona del equipo. 🙏".
- [ ] Verificar en DB:
      ```sql
      SELECT state FROM "Conversation" WHERE "chatId"='<CHAT_ID>';
      ```
      Esperado: `NEEDS_HUMAN`.
- [ ] En el panel `/es/panel/conversaciones`, la conversación aparece resaltada
      arriba.
- [ ] Click en la conversación → botón "Tomar conversación".
- [ ] Estado pasa a `HUMAN`. Chat input habilitado.
- [ ] Escribir "Hola, ¿en qué te ayudo?" → Enviar.
- [ ] Verificar en DB que el mensaje quedó registrado:
      ```sql
      SELECT direction, body FROM "Message"
      WHERE "conversationId"='<CONV_ID>' ORDER BY "createdAt" DESC LIMIT 3;
      ```
- [ ] `send_msg "gracias"` (otro mensaje del paciente) → **bot NO
      responde** (silenciado por HUMAN).
- [ ] Click en "Devolver al bot" → estado `BOT`, `flowStep`/`flowData`
      limpios.
- [ ] `send_msg "hola"` → bot responde normal.

---

## 7. Escenario 6 — FAQ RAG (opcional, requiere `OPENAI_API_KEY`)

**Si `OPENAI_API_KEY` está seteada**:

- [ ] `send_msg "¿cuáles son los horarios?"` → bot responde con la FAQ
      apropiada del seed (horarios L-V 9-18).
- [ ] `send_msg "¿dónde están ubicados?"` → bot responde con la FAQ de
      dirección.
- [ ] `send_msg "¿aceptan tarjeta de crédito?"` → bot responde según la
      FAQ de formas de pago (que dice explícitamente "no aceptamos tarjetas").
- [ ] `send_msg "¿pueden hacerme una radiografía de tórax?"` (fuera del
      dominio de las FAQs) → bot NO improvisa, hace handoff:
      "Déjame verificar esa información..." + `state=NEEDS_HUMAN`.

**Si `OPENAI_API_KEY` NO está seteada**:

- [ ] `send_msg "¿cuáles son los horarios?"` → bot NO responde con la
      FAQ (embeddings no calculados). Handoff.
- [ ] En logs del backend debería aparecer: `faq answer: OPENAI_API_KEY no configurada, handoff clinicId=...`
- [ ] Después de setear la key, correr:
      ```bash
      pnpm --filter @showly/backend prisma:reindex-faq
      ```
      y repetir el test.

---

## 8. Matriz de resultados

| # | Escenario | Esperado | Observado | Pass/Fail |
|---|-----------|----------|-----------|-----------|
| 0 | Pre-check infra + web | Todo Up, seed OK | ⬜ | ⬜ |
| 1 | Login panel | Dashboard con datos del seed | ⬜ | ⬜ |
| 2 | Bot agenda por WA (webhook) | Cita PENDIENTE + jobs `reminder-*`/`risk-*` según distancia del slot (ver §2) | ⬜ | ⬜ |
| 3 | Panel cancela cita | CANCELADA + jobs eliminados + reminders CANCELED | ⬜ | ⬜ |
| 4 | Público agenda desde /agendar/demo | Cita creada, aparece en panel, rate-limit ok | ⬜ | ⬜ |
| 5 | Recordatorio 3h + confirmación | Mensaje llega, `sí` → CONFIRMADA | ⬜ | ⬜ |
| 6 | Handoff a humano | NEEDS_HUMAN → takeover → reply → release → BOT | ⬜ | ⬜ |
| 7 | FAQ RAG (si hay OPENAI_API_KEY) | Bot responde con FAQ + handoff en preguntas fuera-de-dominio | ⬜ | ⬜ |

---

## 9. Cleanup post-smoke

Después del smoke, si vas a mostrar a la clínica en poco tiempo:

- [ ] Cancelar / eliminar las citas de test creadas (para no ensuciar el
      panel). Resolvés el id de la clínica demo por slug (evita hardcode del cuid):
      ```bash
      DEMO_CID=$(docker compose exec -T db psql -U showly -tAc \
        "SELECT id FROM \"Clinic\" WHERE slug='demo'")
      docker compose exec -T db psql -U showly -c "
      DELETE FROM \"Appointment\"
      WHERE notes LIKE '%[seed:v1]%' IS NOT TRUE
        AND \"createdAt\" > NOW() - INTERVAL '2 hours'
        AND \"clinicId\" = '$DEMO_CID';
      "
      ```
      (los reminders bajan en cascada).
- [ ] Cerrar las conversaciones de test (reemplazar `<TU_CHAT_ID>` por el
      `$CHAT_ID` usado en los Escenarios 1/5/6):
      ```sql
      DELETE FROM "Conversation"
      WHERE "chatId" LIKE 'smoke-%'
         OR "chatId" LIKE 'seedv1-%'
         OR "chatId" = '<TU_CHAT_ID>';
      ```
      (los messages bajan en cascada).
- [ ] Re-correr el seed para dejar el dashboard con la data histórica
      estable:
      ```bash
      pnpm --filter @showly/backend prisma db seed
      ```

---

## 10. Bloqueadores conocidos (no reportar como bug)

Estos comportamientos son "esperados" para el MVP y están documentados en
ADRs:

- La FSM del bot puede fallar el matching de "reagendar" si el paciente
  usa sinónimos raros. Handoff a humano funciona como escape universal.
- El panel NO tiene actualización en tiempo real (WebSocket). Refrescar
  manualmente. Ver [[adr/0006-panel-mvp-y-deuda]] §Deuda 9.
- La `race` en takeover puede dejar una conversación tomada por 2
  operadores si simultanean. Con 1-2 operadores es raro. Ver §Deuda 2.
- Cambios en `reminderOffsetsH` NO afectan citas ya creadas (los jobs
  están programados con los offsets viejos). Sólo aplica a citas futuras.
- Página de "gracias" pierde el nombre del paciente si el usuario abre en
  ventana nueva antes del redirect (sessionStorage es por-tab).
- El bot necesita al menos una LLM key (`DEEPSEEK_API_KEY`, `GEMINI_API_KEY`
  u `OPENCODE_*`) para detectar intención. Sin key, `intent.detect` degrada a
  `otro` y "quiero una cita" responde el fallback genérico (la FSM nunca
  arranca). No es un bug — es una dependencia de config.

---

## 11. Bugs detectados (SÍ reportar)

- **Inconsistencia de prefijo en `phone`** — rompe la confirmación por
  WhatsApp de citas creadas desde el panel/página pública. El webhook deriva
  `phone` del chatId SIN `+` (`webhook.controller.ts:142-145`) mientras que
  panel y página pública normalizan CON `+`. Consecuencia: el bot no encuentra
  al paciente en `BotService.findUpcomingAppointment` y "sí" no confirma la
  cita. Fix recomendado: normalizar en un solo punto (ej. en
  `SchedulingService.createAppointment` o derivando `+` en el webhook).
  Impacto: **Escenario 4 (Recordatorio + confirmación) falla tal como está
  documentado** si la cita se crea desde el panel.
- **Webhook simulado con `from` falso** (Escenario 1/6): si el `chatId` no es
  un número WhatsApp real, `WahaService.sendText` falla y el POST devuelve
  500 (el `reply()` del bot no trapea el error). El smoke ahora usa un número
  real, pero el backend no debería reventar el webhook por un fallo de envío
  — el mensaje OUT debería persistirse igual. Evaluar en la fase de
  finalización.

---

## 12. Automatizado — Playwright (sprint 2, s2-10)

El **Escenario 3** (público agenda desde la web) y su caso negativo (slug
inexistente → 404) están automatizados con Playwright. Corren en local y en
CI; el resto del checklist sigue siendo manual (depende de WAHA/LLM reales).

Qué cubre (`apps/web/e2e/*.spec.ts`):

| Spec | Caso | Verifica |
|---|---|---|
| `agendar.spec.ts` | `/es/agendar/demo`: servicio → profesional → primer slot → nombre/teléfono/consentimiento → submit | redirect a `/gracias?date=&time=`, `time` = hora del slot elegido, copy `thanks.subtitle` y `¡Listo, Paciente!` |
| `agendar.spec.ts` | `/es/agendar/no-existe-e2e` | HTTP 404 + heading "Clínica no encontrada" |
| `appointments-api.spec.ts` | `POST /api/public/clinics/demo/appointments` ×2 mismo slot (vía `request`, sin navegador) | 201 y luego 409 |

Selectores: ids del form (`#serviceId`, `#professionalId`, `#name`, `#phone`,
`#consent`), `button[data-slot]` y textos de `messages/es.json`. No hay
`data-testid` nuevos. Los tests usan el seed tal cual (`Consulta general`,
`Dra. Ana Ríos` en UI, `Dr. Luis Pérez` en API para no pelear por el mismo
slot) y un teléfono E.164 único por corrida.

### Local

```bash
scripts/e2e-local.sh                 # todo: infra + migrate + seed + build + start + tests
E2E_SKIP_BUILD=1 scripts/e2e-local.sh   # reutiliza dist/ y .next/ (iteración rápida)
scripts/e2e-local.sh --headed        # args extra van a `playwright test`
```

Qué hace: `docker compose -f docker-compose.e2e.yml up -d db redis`
(proyecto **`showly-e2e`**, puertos **5433/6380**, DB en tmpfs, **sin WAHA**)
→ `prisma migrate deploy` + `prisma db seed` → build de backend y web →
backend `node dist/main.js` en **:4102** y web `next build` + `next start`
en **:3102** (`NEXT_PUBLIC_API_URL=http://localhost:4102`) → `pnpm --filter
@showly/web e2e`. El `trap EXIT` mata backend/web y baja los contenedores
siempre, incluso con Ctrl+C o fallo. Logs en `.e2e-logs/` (gitignored).
Si existe `devsrv`, los procesos arrancan con tope de 3 GB.

Requisitos: Docker, y el chromium de Playwright en `~/.cache/ms-playwright`
(`chromium-1243` ↔ `@playwright/test` **1.63.0**, pineado sin `^` en
`apps/web/package.json` para que un bump accidental no pida otro browser).
Si falta, `pnpm --filter @showly/web exec playwright install chromium`.

### CI

Job `e2e` en `.github/workflows/ci.yml` (`needs: [backend, web]`): Postgres
(`pgvector/pgvector:pg15`) y Redis como `services:`, browser cacheado en
`~/.cache/ms-playwright` con key por versión de `@playwright/test`,
`playwright install chromium --with-deps` **sólo en CI**, migrate + seed,
backend y web en background con `nohup`, espera a `/api/health/live` y a
`/es/agendar/demo`, y corre los specs. Si falla, sube `playwright-report/` +
`test-results/` (trazas y screenshots) como artifact y vuelca los logs de
backend/web al job.

### Decisiones

- **Backend sin WAHA**: `main.ts` no llama a WAHA en el bootstrap; sólo
  programa el health-monitor como job repetible y `WahaHealthMonitor.checkAll`
  captura el error de cada sesión (`waha.health.error`) sin tumbar nada. Por
  eso NO hace falta stub: `WAHA_BASE_URL=http://127.0.0.1:9` (puerto discard,
  falla rápido) y `WAHA_HEALTH_INTERVAL_MIN=60` para que ni siquiera tickee
  durante la corrida. `/api/health` completo reporta `waha:false` — la espera
  usa `/api/health/live`.
- **`NODE_ENV=test`**: evita el fail-fast de prod (`validateProdEnv`) y es
  uno de los dos valores que acepta el seed. `JWT_SECRET` ≥ 32 chars igual,
  por si alguien sube el gate.
- **Infra separada** (`docker-compose.e2e.yml`, proyecto `showly-e2e`, puertos
  5433/6380): el compose principal usa proyecto `showly` con volúmenes
  persistentes; un `down -v` del smoke sobre esos contenedores borraría la DB
  de desarrollo de otra sesión.
- **Serial** (`workers: 1`): los tests crean citas reales contra el mismo
  seed; el rate-limit público es 5/min por IP+slug y una corrida consume 3.
- **Espera de bucket en el spec de API** (`waitForFreshRateLimitBucket`,
  hasta 60 s): ver hallazgo abajo.

### Hallazgo (producción, no corregido acá)

`RateLimit(n)` cuenta en Redis con clave `ratelimit:<slug>:<ip>:<minuto>` —
**una sola clave por slug+IP compartida** entre `GET :slug` (30/min),
`GET availability` (30/min) y `POST appointments` (5/min). En la práctica el
presupuesto del POST es "5 requests de cualquier tipo por minuto": un
paciente que carga la página (SSR = 1 GET), cambia dos veces de profesional
(2-3 GETs de slots) y confirma, ya puede recibir **429** en su primer POST.
El smoke lo reprodujo (`e2e-run2`: primer POST → 429 con los GETs previos
del mismo minuto). Candidato a fix: incluir el nombre del endpoint (o
`scope`) en la clave. Registrado en [[bitacora]] s2-10.

- **`webServer` de Playwright deshabilitado**: el web necesita
  `NEXT_PUBLIC_API_URL` horneado en `next build`; orquestarlo desde
  `playwright.config.ts` duplicaría el script y el job de CI.

Referencias: [[onboarding-clinica]], [[runbook-panel]], [[PRD]] §8,
[[SPEC]] §3.
