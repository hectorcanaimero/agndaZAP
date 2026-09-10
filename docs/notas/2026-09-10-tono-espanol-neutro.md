# Tono de voz: español latinoamericano neutro (2026-09-10)

**Regla**: todo texto que ve un paciente o una clínica (bot de WhatsApp,
recordatorios, página pública, panel, i18n `es`) va en español
latinoamericano neutro con **tuteo**: "puedes", "escribe", "prefieres",
"aquí". Nunca voseo rioplatense ("podés", "escribí", "acá", "contame").

**Contexto**: el pool por defecto del bot (`DEFAULT_BOT_MESSAGES` en
`bot.service.ts`) y el `AI_DISCLOSURE` estaban en voseo, mientras el
`botGreeting` de la clínica piloto (Puerto Ordaz, Venezuela) estaba en tuteo.
El primer mensaje llegaba mezclado. Se corrigieron bot, `public.controller.ts`
y 13 claves de `apps/web/messages/es.json`.

**Palabra de escape**: en todos los mensajes del bot la instrucción es
`escribe *humano*`. El detector (`isHumanEscape`) sigue aceptando también
"persona", "operador", "asesor", "representante" y "hablar con".

Relacionado: [[adr/0004-pii-y-compliance]] §7.1.

## Principios de conversación del bot (aplicados 2026-09-10)

Psicología aplicada al copy de `bot.service.ts` y `reminders.processor.ts`:

1. **Una acción principal por mensaje (Hick)**: el saludo por defecto empuja
   `*agendar*` y ofrece el link público `/{locale}/agendar/{slug}` (sin token,
   para no crear `SchedulingSession` en cada "hola"). Reagendar/cancelar se
   ofrecen solo cuando aplica.
2. **Saludo con contexto**: si el número tiene cita próxima
   (`findUpcomingAppointment`, ahora con `include service+patient`), el saludo
   dice cuál es y ofrece SÍ / REAGENDAR / CANCELAR en vez del menú genérico.
3. **Progreso visible (goal-gradient)**: "Primero…", "Vamos bien…", "Ya casi
   terminamos…", "Último paso…". Sin numerar pasos porque la FSM salta pasos
   (un solo servicio, un solo profesional, paciente conocido).
4. **Errores sin culpa**: "Creo que no te entendí" + se repite la lista de
   opciones (`choiceList`, `offeredSlotList`) en vez de solo pedir un número.
5. **Cierre fuerte (peak-end)**: la confirmación dice servicio, profesional,
   fecha y anuncia el recordatorio. Termina con una sola salida (`*reagendar*`).
6. **Recordatorio como compromiso propio**: "reservaste una cita… ¿Confirmas
   que vas?" y "*CANCELAR* si no puedes ir, así liberamos el turno".
7. **Escape a humano** solo en saludo y errores, nunca en pasos que van bien.
8. Un emoji máximo, solo en saludo y confirmación. Sin humor.

Nota: el saludo NO pasa por LLM ni RAG (barato y determinista). La base de
conocimiento se consulta solo cuando `IntentService` clasifica el mensaje como
`PREGUNTA_FAQ`.
