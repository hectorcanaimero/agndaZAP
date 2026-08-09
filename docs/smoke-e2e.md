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

- [ ] `docker compose ps` muestra `db`, `redis`, `waha`, `backend` como `Up`.
- [ ] `curl -s http://localhost:4000/api/dashboard/metrics -o /dev/null -w "%{http_code}"` → **401** (sin token, ok).
- [ ] `curl -s http://localhost:3002/es/agendar/demo -o /dev/null -w "%{http_code}"` → **200** (web arriba, ruta pública responde).
- [ ] Seed refrescado en los últimos 24h. Correr si no:
      ```bash
      pnpm --filter @agendazap/backend prisma db seed
      ```
- [ ] Verificar credenciales dev disponibles: `admin@demo.dev / demo1234`,
      `super@agendazap.dev / super1234`.
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
- [ ] Redirect a `/es/panel` (dashboard).
- [ ] Cards visibles:
  - Tasa de no-show (esperado ~20%, del seed).
  - Distribución por estado (ATENDIDA=22, CANCELADA=6, NO_SHOW=6).
  - Confirmaciones enviadas > 0.
  - Trend con 14 barras (últimos 14 días).

- [ ] Navegar a `/es/panel/agenda` — deben aparecer citas del seed.
- [ ] Navegar a `/es/panel/bandeja` — deben aparecer 2 conversaciones
      seed (una BOT, una NEEDS_HUMAN).

---

## 2. Escenario 1 — Bot agenda por WhatsApp (simulado por webhook)

Simulamos los mensajes entrantes del paciente vía POST directo al
webhook. Necesitamos el `WEBHOOK_TOKEN` en la env (dev vale
`dev-webhook-token`).

Variables:

```bash
export CHAT_ID="smoke-$(date +%s)@c.us"
export PHONE="+58414${RANDOM}${RANDOM}"
export TOKEN=$(curl -s -X POST http://localhost:4000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@demo.dev","password":"demo1234"}' | \
  python3 -c "import json,sys; print(json.load(sys.stdin)['accessToken'])")
```

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
      DEMO_CID=$(docker compose exec -T db psql -U agendazap -tAc \
        "SELECT id FROM \"Clinic\" WHERE slug='demo'")
      echo "Demo clinic ID: $DEMO_CID"

      docker exec agendazap-db-1 psql -U agendazap -d agendazap -c \
        "SELECT id, status, \"startAt\", notes FROM \"Appointment\"
         WHERE \"clinicId\"='$DEMO_CID'
           AND \"createdAt\" > NOW() - INTERVAL '5 minutes'
         ORDER BY \"createdAt\" DESC LIMIT 3;"
      ```
- [ ] Verificar recordatorios programados en Redis:
      ```bash
      docker exec agendazap-redis-1 redis-cli --scan --pattern 'bull:reminders:*' | head -20
      ```
      Esperado: al menos 2 keys `reminder-<id>` + 1 `risk-<apptId>` (si
      la cita está a >6h).

---

## 3. Escenario 2 — Panel cancela una cita

- [ ] Desde `/es/panel/agenda`, hacer click en la cita creada en
      Escenario 1.
- [ ] En el modal, cambiar el estado a `CANCELADA`.
- [ ] Toast de éxito.
- [ ] Verificar en DB:
      ```bash
      docker exec agendazap-db-1 psql -U agendazap -d agendazap -c \
        "SELECT status, \"canceledAt\" FROM \"Appointment\" WHERE id='<APPT_ID>';"
      ```
      Esperado: `status=CANCELADA`, `canceledAt` con timestamp reciente.
- [ ] Verificar Redis limpio:
      ```bash
      docker exec agendazap-redis-1 redis-cli --scan --pattern 'bull:reminders:*reminder-*' | wc -l
      ```
      Los jobs del appointment cancelado deben haberse eliminado.
- [ ] Verificar reminders en DB:
      ```bash
      docker exec agendazap-db-1 psql -U agendazap -d agendazap -c \
        "SELECT status FROM \"Reminder\" WHERE \"appointmentId\"='<APPT_ID>';"
      ```
      Esperado: todos `CANCELED`.

---

## 4. Escenario 3 — Público agenda desde la web

- [ ] Nueva ventana / incógnito: `http://localhost:3002/es/agendar/demo`.
- [ ] Página muestra formulario con:
  - Info de la clínica (nombre, dirección).
  - Select de servicios.
  - Select de profesional.
  - Fecha + slots.
  - Campos paciente (nombre, teléfono).
  - Checkbox consent.
  - Honeypot invisible.

- [ ] Elegir servicio → los slots se actualizan.
- [ ] Elegir profesional (o dejarlo en "cualquiera").
- [ ] Elegir fecha → slots del día se listan.
- [ ] Elegir slot.
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
- [ ] Enviar 6 requests seguidas rápidas al POST →
      la 6ta devuelve **429** con header `Retry-After: 60`.

---

## 5. Escenario 4 — Recordatorio anti no-show

**Requisito**: WAHA conectada al número de tu WhatsApp personal (podés
usarlo como paciente de test).

- [ ] Desde el panel, crear cita para dentro de **~4 horas** para tu
      teléfono. Estado inicial: PENDIENTE.
- [ ] Verificar en Redis que hay 2 jobs (`reminder-*`) y 1 job
      (`risk-*`).
- [ ] Esperar hasta que la cita esté a 3h (o menos). Job dispara el
      recordatorio.
- [ ] Recibir mensaje en tu WhatsApp: "Recordatorio de tu cita..."
- [ ] Responder `sí` desde WhatsApp.
- [ ] Verificar que la cita en el panel pasa a `CONFIRMADA` (refresh
      manual).
- [ ] Verificar en DB:
      ```sql
      SELECT status, "confirmedAt" FROM "Appointment" WHERE id='<APPT_ID>';
      ```
      Esperado: `status=CONFIRMADA`, `confirmedAt` con timestamp reciente.
- [ ] Verificar que el `risk-*` fue eliminado de Redis.

**Alternativa sin esperar**: forzar el job `check-risk` a correr
adelantando el tiempo. Editar el `reminder.fireAt` a ahora en la DB y
esperar el próximo tick del worker BullMQ.

---

## 6. Escenario 5 — Handoff a humano

- [ ] `send_msg "quiero hablar con una persona"` → bot responde
      "Enseguida te atiende una persona del equipo. 🙏".
- [ ] Verificar en DB:
      ```sql
      SELECT state FROM "Conversation" WHERE "chatId"='<CHAT_ID>';
      ```
      Esperado: `NEEDS_HUMAN`.
- [ ] En el panel `/es/panel/bandeja`, la conversación aparece resaltada
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
- [ ] En logs del backend debería aparecer: `KnowledgeService: OPENAI_API_KEY faltante`.
- [ ] Después de setear la key, correr:
      ```bash
      pnpm --filter @agendazap/backend prisma:reindex-faq
      ```
      y repetir el test.

---

## 8. Matriz de resultados

| # | Escenario | Esperado | Observado | Pass/Fail |
|---|-----------|----------|-----------|-----------|
| 0 | Pre-check infra + web | Todo Up, seed OK | ⬜ | ⬜ |
| 1 | Login panel | Dashboard con datos del seed | ⬜ | ⬜ |
| 2 | Bot agenda por WA (webhook) | Cita PENDIENTE + 2 reminders + 1 risk en Redis | ⬜ | ⬜ |
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
      DEMO_CID=$(docker compose exec -T db psql -U agendazap -tAc \
        "SELECT id FROM \"Clinic\" WHERE slug='demo'")
      docker compose exec -T db psql -U agendazap -c "
      DELETE FROM \"Appointment\"
      WHERE notes LIKE '%[seed:v1]%' IS NOT TRUE
        AND \"createdAt\" > NOW() - INTERVAL '2 hours'
        AND \"clinicId\" = '$DEMO_CID';
      "
      ```
      (los reminders bajan en cascada).
- [ ] Cerrar las conversaciones de test:
      ```sql
      DELETE FROM "Conversation"
      WHERE "chatId" LIKE 'smoke-%' OR "chatId" LIKE 'seedv1-%';
      ```
      (los messages bajan en cascada).
- [ ] Re-correr el seed para dejar el dashboard con la data histórica
      estable:
      ```bash
      pnpm --filter @agendazap/backend prisma db seed
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

Referencias: [[onboarding-clinica]], [[runbook-panel]], [[PRD]] §8,
[[SPEC]] §3.
