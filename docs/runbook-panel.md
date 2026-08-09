# Runbook del panel — Día a día de recepción

Guía operativa para el equipo de la clínica (recepcionista, secretaria,
dueño) que usa el panel web todos los días. Escrito en tono práctico:
qué botón, qué esperar, qué hacer si algo se rompe.

> Setup inicial: ver [[onboarding-clinica]]. Este runbook asume la clínica
> ya está dada de alta y el bot funciona.

---

## 1. Login

- **URL**: `https://<panel-host>/es/login` (para pt: `/pt/login`).
- **Credenciales**: las que te dio el equipo de AgendaZap al onboarding.
  Email + password.
- **Después del login**: te redirige a `/panel` (dashboard).

**Deudas de UX conocidas** ([[adr/0005-auth-mvp-y-deuda]], [[adr/0006-panel-mvp-y-deuda]]):

- No hay "recuperar contraseña". Si olvidás el password, escribí a
  soporte y te generamos uno nuevo.
- El token vive 24h sin refresh. Si dejás la sesión abierta un día
  entero, al día siguiente vas a tener que re-login. Cuando eso pase, el
  panel te lleva automáticamente a `/login?next=<lo-que-estabas-mirando>`.

---

## 2. Dashboard (`/panel`)

Pantalla de inicio. Números de los últimos **30 días**. Se refresca cada
vez que entrás.

### Cards

| Card | Qué mide | Cómo interpretarlo |
|------|----------|---------------------|
| **Tasa de no-show** | `NO_SHOW / (ATENDIDA + NO_SHOW)` en 30d | La métrica norte. Objetivo interno: bajarla 30% relativo respecto a la línea base. Rangos: <10% excelente, 10-20% típico, >20% preocupante. |
| **Por estado** | Distribución de citas de 30d atrás | Chequeo rápido de balance. Muchos PENDIENTE = paciente no está confirmando; alto CANCELADA = revisar comunicación / política. |
| **Confirmaciones** | Recordatorios enviados vs confirmaciones recibidas | `rate` mide qué % de los recordatorios recibieron respuesta. Rangos: >60% saludable; <40% los pacientes no leen o el mensaje no llega. |
| **Tendencia** | Últimos 14 días con creadas / confirmadas / no_show | Detectar picos anómalos. Ej. martes con 8 no_shows y el resto de días con 0 → algo pasó ese martes. |

### Acciones desde el dashboard

Ninguna. El dashboard es sólo lectura. Para actuar, usá la **Agenda** o
la **Bandeja**.

---

## 3. Agenda (`/panel/agenda`)

### 3.1. Vistas

- **Día**: por default. Muestra todas las citas del día actual con hora,
  paciente, servicio, profesional, estado.
- **Semana**: 7 columnas, una por día. Menos detalle por celda pero mejor
  vista de carga.

Los botones `←` / `→` navegan al día/semana anterior/siguiente.

### 3.2. Filtros

Barra superior:

- **Profesional**: seleccioná uno para ver sólo sus citas.
- **Estado**: filtrar por PENDIENTE, CONFIRMADA, EN_RIESGO, ATENDIDA,
  CANCELADA, NO_SHOW.
- **Reset**: botón "todos" quita todos los filtros.

### 3.3. Cambiar el estado de una cita

Click en una cita → modal con detalles y botones de acción.

**Transiciones permitidas** (FSM del SPEC §2):

| Desde       | A          | Cuándo usarla                                             |
|-------------|------------|-----------------------------------------------------------|
| PENDIENTE   | CONFIRMADA | El paciente confirmó por otro canal (llamada, presencial). |
| PENDIENTE   | EN_RIESGO  | Manual — automáticamente lo hace el sistema tras el umbral. |
| PENDIENTE   | CANCELADA  | El paciente canceló por otro canal.                        |
| CONFIRMADA  | ATENDIDA   | El paciente vino y fue atendido. **Marcarlo al cierre del día**. |
| CONFIRMADA  | CANCELADA  | Cancelación last-minute.                                  |
| CONFIRMADA  | NO_SHOW    | El paciente no se presentó. **Registrarlo el mismo día** (impacta la métrica). |
| EN_RIESGO   | CONFIRMADA | Contactaste al paciente por fuera y confirmó.             |
| EN_RIESGO   | CANCELADA  | Contactaste y canceló.                                    |
| EN_RIESGO   | NO_SHOW    | Nunca respondió y no vino.                                |
| EN_RIESGO   | ATENDIDA   | Nunca respondió pero vino igual.                          |

Cualquier otra transición devuelve **422** con mensaje del error.

Efectos automáticos:

- **CONFIRMADA**: se cancela el job "check-risk" (no va a pasar a EN_RIESGO
  automáticamente).
- **CANCELADA**: se cancelan TODOS los recordatorios pendientes de esa
  cita. El horario vuelve a estar disponible.
- **NO_SHOW / ATENDIDA**: cierra la cita, entra en las métricas de no-show
  del dashboard.

### 3.4. Race condition

Si vos y otro operador cambian el estado de la misma cita simultáneamente,
el segundo va a recibir un toast de aviso (`la cita cambió, refrescando…`)
y la vista se actualiza. Sin data perdida.

### 3.5. Crear cita manual (mostrador)

Botón "Nueva cita" arriba de la agenda. Modal con:

- Paciente (buscar por teléfono existente o crear nuevo).
- Servicio.
- Profesional.
- Fecha + slot (el sistema calcula los slots libres).
- Consent obligatorio (el paciente autoriza el uso de sus datos —
  requerido incluso siendo SUPERADMIN, ADR 0006 §4).

Al submitear:

- Se crea la cita en PENDIENTE (o CONFIRMADA si la clínica tiene
  `autoConfirm=true`).
- Se programan los recordatorios automáticamente si el `startAt` está a
  más tiempo que el offset más chico (default 3h).
- Aparece en la agenda inmediatamente.

**Tip**: si el paciente ya llamó y confirmó verbalmente, después de crear
la cita pasala manualmente a CONFIRMADA — así no le llegan recordatorios
"redundantes".

---

## 4. Bandeja de conversaciones (`/panel/bandeja`)

Lista de conversaciones de WhatsApp, ordenadas por última actividad.

### 4.1. Estados

| Estado         | Qué significa                                                       | Acción típica                        |
|----------------|---------------------------------------------------------------------|--------------------------------------|
| **BOT**        | El bot está manejando la conversación. Todo bajo control.           | Nada. Podés leer para monitoreo.     |
| **NEEDS_HUMAN**| El bot no supo responder o el paciente pidió humano. **Requiere tu atención.** | Tomarla y responder.                 |
| **HUMAN**      | Ya la tomaste (o otro operador). El bot NO va a responder mientras esté así. | Responder, y al terminar liberar.    |

Las **NEEDS_HUMAN** aparecen resaltadas y arriba del listado. Estado
default para nuevas conversaciones sin acción del bot: BOT.

### 4.2. Tomar una conversación ("takeover")

- Click en la conversación → botón "Tomar conversación".
- El estado pasa a `HUMAN`. El bot se silencia en ese chat.
- Si otro operador la toma a la vez, gana el primero (deuda: hoy hay una
  race conocida — [[adr/0006-panel-mvp-y-deuda]] §Deuda 2. Con 1-2
  operadores esperando poco daño; con más, coordinar por Slack).

### 4.3. Responder manualmente

Con la conversación en HUMAN:

- Textarea abajo, botón "Enviar".
- El mensaje va directo por WAHA al paciente.
- Los caracteres invisibles / control chars se limpian por seguridad.
- El mensaje queda registrado en la conversación (columna OUT).

**No hay ediciones ni deletes** — todo lo que enviás queda como registro
inmutable.

### 4.4. Devolver la conversación al bot ("release")

Botón "Devolver al bot". Efectos:

- Estado pasa a `BOT`.
- Se limpian `flowStep` y `flowData` — el bot arranca "de cero" en el
  próximo mensaje del paciente. Sirve para evitar que el bot retome un
  flujo obsoleto (paciente venía en `ASK_SLOT` pero ya lo agendaste manual).

### 4.5. Anti-patrón

**No cierres el modal / tab sin liberar** si tomaste una conversación. El
bot va a quedar silenciado hasta que alguien libere manualmente. Regla:
"toma → responde → libera" siempre en el mismo turno.

---

## 5. CRUDs (catálogo)

### 5.1. Servicios (`/panel/servicios`)

- Crear: nombre, duración (min), buffer (min), precio (opcional), activo.
- Activar / desactivar: toggle. Un servicio inactivo NO aparece en el bot
  ni en la página pública. Las citas ya creadas quedan intactas.
- Editar duración: **NO afecta citas existentes**. Sólo las nuevas se
  crean con la nueva duración.
- Editar buffer: idem.
- Eliminar: soft-block si hay citas activas asociadas — desactivar en su
  lugar.

### 5.2. Profesionales (`/panel/profesionales`)

- Crear / editar: nombre, activo, servicios que atiende (M-N).
- Al asociar servicios, el sistema valida que todos pertenezcan a tu
  clínica (blindaje anti cross-tenant — [[adr/0006-panel-mvp-y-deuda]] §3).
- Desactivar: el profesional no aparece en el bot ni en la página pública.

### 5.3. Horarios (`/panel/horarios`)

Dos modelos:

- **Horario clínica**: aplica a todos los profesionales que no tengan
  horario propio. Ej. L-V 9:00-18:00.
- **Horario por profesional**: sobrescribe el de la clínica para ese
  profesional. Ej. Dr. Pérez sólo martes y jueves 14:00-19:00.

Formato: `weekday (0=domingo, 6=sábado) + startMinutes + endMinutes`
(minutos desde medianoche, ej. 540 = 09:00, 1080 = 18:00).

**Tip pausa mediodía**: crear dos bloques por día. Ej.
`weekday=1, 540-780` (L 9-13) y `weekday=1, 840-1080` (L 14-18).

### 5.4. Bloqueos (`/panel/bloqueos`)

Para feriados, vacaciones, cierre por evento, licencia.

- Crear: startAt (fecha + hora), endAt (fecha + hora), razón (opcional,
  visible sólo internamente).
- Efecto: cualquier slot que caiga en ese rango se invalida — el bot no
  lo ofrece.
- Puede ser por-profesional o de la clínica entera.
- Editar / eliminar libremente.

**Tip**: si el feriado es todo el día, `startAt=00:00`, `endAt=23:59` de
ese día.

---

## 6. FAQ (`/panel/faq`)

El bot responde preguntas del paciente usando esta base de conocimiento
via RAG (embeddings + Postgres pgvector).

- Crear FAQ: escribí una entrada completa (pregunta + respuesta en el
  mismo `content`, formato libre).
- Si el backend tiene `OPENAI_API_KEY` seteada, el embedding se genera
  automáticamente al guardar. El bot puede usarlo desde el próximo mensaje.
- Si NO tiene la key, la FAQ se guarda igual pero **sin embedding**. El
  panel muestra un warning. Contactar a soporte para correr `pnpm
  prisma:reindex-faq`.
- Editar: si cambiás el `content`, se re-genera el embedding
  automáticamente.

**Qué escribir bien**:

- **Preguntas concretas + respuesta directa**. Ej. "¿Cuánto sale la
  consulta? La consulta general sale $30 USD, pago en efectivo, Zelle o
  transferencia."
- **Una FAQ por tema**. No mezcles horarios + precios + dirección en una
  sola entrada. Separalas.
- **Actualizá cuando cambia algo**. Si suben los precios, editá la FAQ
  ese mismo día. El bot no adivina.

Si el paciente hace una pregunta que **no matchea** ninguna FAQ (distancia
coseno > 0.5), el bot NO improvisa — hace handoff a humano ([[adr]]
del RAG, [[notas/2026-08-09-rag-faq]]).

---

## 7. Salida

Botón "Cerrar sesión" arriba a la derecha. **Siempre cerrá sesión al
terminar** si el equipo comparte la máquina — el JWT vive 24h sin refresh
y no hay revocación remota (deuda [[adr/0005-auth-mvp-y-deuda]] §6).

---

## 8. Problemas comunes

| Síntoma | Diagnóstico | Solución |
|---------|-------------|----------|
| WAHA desconectada — el bot no responde a nadie | Sesión WAHA cayó (celular sin señal, restart del container, etc.). | Contactar a AgendaZap. Mientras tanto, atender por bandeja **manualmente** — cada convo requerirá takeover. |
| Cita duplicada en la agenda | Bug o creación desde 2 canales simultáneos (bot + panel). | Cancelá una desde el panel (CANCELADA). Si es un patrón que se repite, reportar. |
| Paciente no recibió recordatorio | (1) Cita creada a menos de 3h → offset omitido; (2) WAHA se desconectó entre schedule y fire; (3) el paciente bloqueó el número. | Ver [[onboarding-clinica]] §12. Regla operativa: para citas a menos de 4h, mandar recordatorio manualmente por bandeja. |
| Bandeja llena de spam / bots random | Números random escribiendo "hola" o mensajes automáticos. | Ignorar. No responder. El estado queda BOT. Podemos discutir agregar rate-limit por chatId post-piloto. |
| Un paciente reclama que "confirmó" pero la cita quedó como NO_SHOW | Confirmó fuera del formato esperado ("ok!" en vez de "sí"). El bot no lo interpretó. | Compensar: crear cita nueva sin cargo o disculpa. Reportar a AgendaZap para mejorar el matching. |
| El dashboard muestra `tasa de no-show = 0%` | O no hay ninguna cita cerrada aún (menos de 30d de historia), o todas fueron ATENDIDA. | Esperar más data. Ojo: la métrica cuenta sólo cerradas (ATENDIDA + NO_SHOW), ignora PENDIENTE / CANCELADA. |
| El sistema me dejó fuera después de 5 intentos de login | Rate-limit por email (15 min ventana, 5 fails máx). | Esperar 15 minutos. Si urgente, contactar a AgendaZap para reset. |

---

## 9. Convenciones operativas

Recomendaciones para que la clínica saque el máximo:

1. **Cerrar el día a las 19:00**: recorrer las citas de hoy y marcar
   ATENDIDA / NO_SHOW. Sin esto, la métrica se distorsiona.
2. **Responder los NEEDS_HUMAN dentro de 30 min** en horario de atención.
   Un paciente que espera 3h ya asume que no lo van a atender.
3. **Actualizar FAQ mensualmente**. Precios, horarios, políticas. El bot
   sólo sabe lo que le enseñamos.
4. **Revisar el dashboard cada lunes**. Si la no-show rate sube 3 semanas
   seguidas → algo cambió, hablar con el equipo.
5. **Guardar el password de forma segura** (gestor de contraseñas).
   Rotarlo cada 3-6 meses (por ahora manual — pedir reset a AgendaZap).

---

## 10. Contacto / escalation

- **Soporte AgendaZap**: <email de soporte>.
- **Emergencia** (bot totalmente caído, panel inaccesible): <teléfono>.
- **Feedback / feature requests**: <formulario o email>.

Referencias: [[PRD]], [[SPEC]], [[onboarding-clinica]], [[smoke-e2e]].
