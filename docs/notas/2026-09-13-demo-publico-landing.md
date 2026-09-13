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

## Antes de encenderlas (gotchas)

- **Número propio para la demo.** Nunca el de ventas (`NEXT_PUBLIC_WHATSAPP_SALES`) ni el de una
  clínica real: WAHA es no oficial y un número expuesto en una landing recibe tráfico raro. Si lo
  bloquean, que caiga sólo la demo.
- **La demo manda WhatsApp de verdad.** Una cita creada desde `/agendar/<slug>` agenda recordatorios
  al teléfono que escribió el visitante. El endpoint de reserva ya tiene `RateLimit(5, 'public-book')`
  por IP, pero la demo lo hace visible: vigilar volumen de envíos de esa sesión WAHA la primera semana.
- **Datos ficticios.** La clínica sale de `apps/backend/prisma/seed-demo-dental.js` (slug `demo`,
  "Clínica Dental Sonrisa Guayana"). La landing avisa "Clínica ficticia"; las citas de visitantes
  quedan en esa clínica y conviene limpiarlas periódicamente re-ejecutando el seed.
- **Costo LLM.** Cada conversación con el bot demo consume tokens como una real (<$0.01, pero sin
  techo por visitante). Si aparece abuso, apagar `NEXT_PUBLIC_DEMO_WHATSAPP` y rebuild.
