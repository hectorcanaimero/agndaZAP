---
fecha: 2026-09-13
tags: [landing, demo, waha, deploy]
---

# Demo pública en la landing ("Pruébalo ahora")

El owner aprobó (2026-09-13) exponer en la landing una clínica demo como prueba del producto,
en lugar de testimonios que no existen. Ver [[adr/0025-landing-navy-teal-geist]].

## Cómo se enciende

Dos variables **build-time** del web (se hornean en el bundle, hay que rebuild):

- `NEXT_PUBLIC_DEMO_WHATSAPP`: número del bot de la clínica demo, sólo dígitos con código de país.
  Muestra "Escríbele al bot" con un mensaje prellenado.
- `NEXT_PUBLIC_DEMO_CLINIC_SLUG`: slug de la clínica demo. Muestra "Agenda desde la web" →
  `/<locale>/agendar/<slug>`.

Cada vía aparece sólo si su variable está. Sin ninguna, la sección no se renderiza y el CTA
secundario del hero pasa de "Probar el bot" a "Ver cómo funciona". Código: `apps/web/src/lib/demo-clinic.ts`.
Están cableadas en `apps/web/Dockerfile`, `docker-compose.coolify.yml` y `docker-compose.prod.yml`.

## Bloqueantes antes de encenderlas en producción

Encontrados en la revisión de código del rediseño; **ninguno está resuelto en la rama de la landing**
(las dos vías vienen apagadas por defecto):

1. **Spam a terceros por la página de reserva.** `POST /public/:slug/appointments` tiene
   `RateLimit(5, 'public-book')` por minuto, por IP y slug, y no verifica el teléfono. Un bot puede
   meter números ajenos y Showly les manda los recordatorios de 24 h y 3 h desde el número demo
   (~7.200 citas/día por IP, ban probable de WAHA) y además agota los horarios de la demo. Hace falta,
   para la clínica demo: tope diario por IP y por teléfono, y citas sin jobs de recordatorio (o un
   solo aviso inmediato), más un tope global de envíos por día de esa sesión WAHA. Pasar por
   `security-auditor`.
2. **Retención de datos de visitantes.** Re-ejecutar `seed-demo-dental.js` **no** limpia: sólo borra
   citas con `[demo-dental:v1]` en `notes` y conversaciones `demodental-*`. Las citas, pacientes
   (nombre y teléfono reales) y conversaciones de visitantes quedan para siempre y además ocupan
   horarios. Hace falta un job/script que borre en la clínica `demo` lo no etiquetado con más de N
   días, y declarar esa retención en `/privacidad`.

## Gotchas

- **Número propio para la demo.** Nunca el de ventas (`NEXT_PUBLIC_WHATSAPP_SALES`) ni el de una
  clínica real: WAHA es no oficial y un número expuesto en una landing recibe tráfico raro. Si lo
  bloquean, que caiga sólo la demo.
- **La demo manda WhatsApp de verdad** al teléfono que escribe el visitante; la landing lo avisa.
- **Idioma.** La clínica del seed tiene `locale: 'es'` y el bot no detecta el idioma del paciente: a
  un visitante de `/pt` le responde en español (la nota en pt lo dice).
- **Datos ficticios.** La clínica sale de `apps/backend/prisma/seed-demo-dental.js` (slug `demo`,
  "Clínica Dental Sonrisa Guayana").
- **Costo LLM.** Cada conversación con el bot demo consume tokens como una real (<$0.01, pero sin
  techo por visitante). Si aparece abuso, apagar `NEXT_PUBLIC_DEMO_WHATSAPP` y rebuild.
