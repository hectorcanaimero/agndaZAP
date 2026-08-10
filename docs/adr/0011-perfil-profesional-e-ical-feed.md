# ADR 0011 — Perfil de Profesional e iCal feed para sincronización con calendar

- Fecha: 2026-08-10
- Estado: aceptado
- Relacionados: [[0002-waha-no-oficial]], [[0004-pii-y-compliance]], [[0006-panel-mvp-y-deuda]], [[0010-lid-y-contacto-whatsapp]]

## Contexto

El modelo `Professional` estaba minimalista: solo `name + active`. Insuficiente
para:

1. **App mobile del profesional** (Flutter, prevista en el roadmap): necesita
   `email` como identificador de login, `phone` para contacto directo/OTP,
   `avatar` para el perfil visible.
2. **Página pública `/agendar/[slug]`**: sin `specialty` + `bio` + `avatarUrl`,
   los pacientes ven "Dra. Ríos" sin contexto — mal para conversión.
3. **Regulatorio (AR/BR)**: clínicas médicas necesitan mostrar la matrícula
   (`licenseNumber`) en la ficha del profesional y en constancias.
4. **Agenda con múltiples profesionales**: sin `color`, los eventos aparecen
   todos iguales y es difícil discriminar de un vistazo.

Aparte, el operador pidió una forma para que el profesional vea sus turnos
desde el calendario de su teléfono sin instalar app aún — patrón "iCal feed".

### Investigación sobre sincronización con calendar externo

Se evaluaron tres opciones:

- **A) iCal feed (RFC 5545)** — el backend genera un `.ics` con las citas
  futuras. El profesional suscribe la URL desde iOS/Android/Google Calendar.
  Zero-setup. **Read-only**, **no real-time** (los clientes refrescan cada
  15min–1h). Funciona en TODO (iOS/Android/Outlook/Google).
- **B) Google Calendar OAuth** — real-time bi-direccional. Bloquear slots en
  Google refleja como TimeOff acá y viceversa. Mucho más trabajo: OAuth flow,
  refresh tokens, sync jobs, edge cases de conflicts. Solo cubre usuarios
  Google.
- **C) Nada, "solo app"** — implica esperar a que la app mobile esté lista
  antes de que el profesional pueda ver sus turnos fuera del panel web.

## Decisión

### 1. Extender `Professional` con 7 campos opcionales

Migration `20260810115333_professional_profile_fields` agrega:

| Campo | Tipo | Uso |
|---|---|---|
| `email` | `String?` | Login app + contacto (unique por clínica) |
| `phone` | `String?` (E.164) | Contacto directo + OTP futuro |
| `specialty` | `String?` | Perfil visible al paciente |
| `bio` | `String?` (max 1000) | Perfil visible al paciente |
| `avatarUrl` | `String?` (URL) | Foto — hoy URL manual; upload propio en follow-up |
| `licenseNumber` | `String?` | Matrícula profesional |
| `color` | `String?` (hex) | Visual en calendar |
| `updatedAt` | `DateTime @updatedAt` | Auditoría (default `now()` para backfill) |

Todos NULL para profesionales existentes — se completan on demand desde el
detalle. `@@unique([clinicId, email])` para prevenir doble alta y para poder
usar `email` como identificador natural del profesional dentro de la clínica.

### 2. iCal feed (opción A) — HMAC token en query string

Endpoint: `GET /ical/professionals/:id?token=X` (fuera del prefijo `/api`,
`@Public()` — opt-out del JWT guard global, como el webhook de WAHA).

Token: `HMAC-SHA256(professionalId, ICAL_SECRET)` truncado a 32 chars hex.
Comparado con `timingSafeEqual` para evitar timing attacks. Determinístico —
mismo id + mismo secret = mismo token. **Revocable** rotando `ICAL_SECRET`
(rota TODAS las suscripciones de golpe — usar solo en incidents).

`ICAL_SECRET` fail-fast en producción si no está seteado. Dev-only default
para trabajar sin config explícita.

Contenido del feed:
- Ventana: 30 días atrás + 90 hacia adelante (histórico corto para no engordar).
- Excluye `CANCELADA` y `NO_SHOW` — no ensuciar el calendar con turnos que
  ya no aplican. `ATENDIDA` sí queda por historial.
- `SUMMARY: {patient.name} · {service.name}`
- `DESCRIPTION`: paciente, teléfono, servicio, estado, notas.
- Escape RFC 5545 correcto (`,`, `;`, `\`, `\n`).
- `STATUS`: `TENTATIVE` (PENDIENTE/EN_RIESGO) o `CONFIRMED` (CONFIRMADA/ATENDIDA).
- CRLF entre líneas (RFC 5545).

Se descartó **Google Calendar OAuth** para este PR — requiere:
- OAuth 2.0 flow con almacenamiento de refresh tokens (cifrados idealmente).
- Watch channels o polling jobs para real-time.
- Reconciliación bi-direccional con manejo de conflicts.
- Solo cubre usuarios Google (deja fuera a Apple/Outlook/iCloud).

iCal feed cubre el 90% del valor con el 10% del trabajo. Google OAuth queda
como follow-up cuando aparezca la demanda concreta.

### 3. UI: master-detail (mismo patrón que servicios)

Rewrite completo de `ProfessionalsClient.tsx` con layout split 2-col (lista
izq + form/empty der) y form con 5 secciones agrupadas semánticamente:
Identidad, Perfil profesional, Servicios, Visual, Calendar (solo edit).

El botón "Copiar URL de calendar" en la sección Calendar hace un fetch del
detail (que expone `icalUrl` pre-firmada) y copia la URL absoluta al
portapapeles. Instrucciones inline sobre cómo suscribir en iOS/Android.

## Consecuencias

**Positivas**
- Foundation sólida para la app mobile del profesional (PR siguiente puede
  agregar botón "Invitar a la app" que crea el `User` linkeado usando `email`
  como identificador).
- Página pública puede mostrar perfiles más ricos (specialty + bio + avatar).
- Los profesionales pueden ver sus turnos desde el calendar del teléfono
  desde el día 1, sin esperar la app.
- Regulatorio cubierto con `licenseNumber`.
- Agenda con múltiples profesionales se lee mejor con `color`.

**Negativas / deuda técnica**
- iCal feed es **read-only** — no permite al profesional bloquear tiempo
  desde su calendar. Para eso: Google Calendar OAuth (follow-up).
- `avatarUrl` es URL manual — el operador tiene que hostear la imagen
  aparte. Follow-up: endpoint de upload a R2/S3.
- El `ICAL_SECRET` rotado invalida TODAS las suscripciones activas — no hay
  revocación por profesional individual. Aceptable para el MVP; si escalamos
  a "un profesional pierde su URL", se agrega un `icalRevokedAt` por
  profesional que se mezcla al hash.
- Sesiones WAHA usadas con estos profesionales no se ven afectadas —
  este cambio es ortogonal.

**Neutrales**
- El campo `updatedAt` se agregó ahora — se usará para versionado optimistic
  concurrency si en el futuro dos operadores editan el mismo profesional.
