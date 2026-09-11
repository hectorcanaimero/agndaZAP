---
titulo: Notas de voz — comparativa de STT y plan (exploración, sin código)
fecha: 2026-09-11
tags: [bot, whatsapp, stt, audio, privacidad, exploracion]
---

# Transcribir las notas de voz (M10) — exploración

Nota de exploración: **no hay código asociado**. Compara opciones, fija precios
verificados en septiembre de 2026, y termina con una recomendación y un plan.

## Por qué importa

Un paciente que manda una nota de voz hoy recibe *"Por ahora solo puedo leer
mensajes de texto"*. Es correcto y es una puerta cerrada: en WhatsApp la nota de
voz no es una rareza, es cómo mucha gente prefiere escribir — sobre todo mayores,
y sobre todo cuando les duele algo y escribir cuesta.

## Tres premisas del encargo que NO se sostienen

Antes de comparar nada, tres cosas que se daban por hechas y no lo están. Las
verifiqué porque cambian la comparativa.

**1. "Gemini 2.0 Flash multimodal ya está en el router" — no está usable.**
`llm-router.service.ts:164` llama a `models/gemini-2.0-flash`, y ese modelo
**ya no figura entre los vigentes** en la documentación de precios de Google
([ai.google.dev](https://ai.google.dev/gemini-api/docs/pricing)); las fuentes lo
dan por retirado desde junio de 2026. Además **`GEMINI_API_KEY` no está definida
en Coolify**, y el router se salta en silencio a los providers sin key. O sea que
hoy el fallback de Gemini no existe ni para texto: la cadena real es
`deepseek → opencode` y se acabó.

Esto es un hallazgo aparte del de STT y merece su propio arreglo: el tercer
eslabón de la cadena de fallback es decorativo.

**2. WAHA no está descargando media.** No hay ninguna env `WAHA_MEDIA_*` en la
configuración de producción. Sin `WAHA_MEDIA_STORAGE` y
`WAHA_MEDIA_POSTGRESQL_URL`, NOWEB entrega `hasMedia: true` con `media: null` —
detecta el audio pero no lo descarga. **Eso es prerrequisito de todo lo demás**,
y es un cambio de infraestructura, no de código.

**3. El handoff tras dos adjuntos seguidos no está en producción.** Es de #46,
que quedó huérfano (se mergeó sobre la rama de #43 después de que #43 ya
estuviera en main). Hoy el paciente que manda audios solo recibe el aviso de
texto con su throttle de 6 h; nadie lo deriva a una persona.

## Comparativa

Precios verificados en septiembre de 2026. Los de Gemini van **derivados** del
precio por token, así que conviene recalcularlos antes de decidir.

| | coste / min | latencia típica | es / pt | ¿tercero nuevo? |
|---|---|---|---|---|
| **OpenAI `gpt-4o-mini-transcribe`** | ~$0.003 | segundos, batch | sí, ambos | **no** — ya usamos OpenAI para embeddings |
| **Google Gemini Flash (actual)** | ~$0.0011–0.0015 (derivado: 25 tok/s ⇒ 1500 tok/min, a $0.75–1.00/1M) | segundos | sí, ambos | **no** — Google ya está en el consent |
| **Deepgram Nova-3** | $0.0043 batch · $0.0077 streaming · $0.0092 multilingüe streaming | la más baja, diseñada para streaming | sí, con code-switching es↔pt | **sí** |

Orden de magnitud del gasto: una nota de voz de WhatsApp dura ~20 s. Con 500
notas al mes por clínica son ~167 minutos, o sea **entre 0,20 y 0,70 USD al mes
por clínica**. El coste no decide nada aquí — cualquiera de las tres es
irrelevante frente al resto de la factura.

Lo que sí decide es la privacidad.

## Lo que exige el ADR 0004, y por qué descarta a Deepgram

[[adr/0004-pii-y-compliance|§7]] dice que el `Patient.consent` tiene que cubrir
**explícitamente** el procesamiento con IA de terceros, y fija el texto que el
paciente acepta:

> "…autorizás que tus mensajes se procesen con servicios de IA (OpenAI,
> DeepSeek, Google) para responder consultas y agendar citas."

Ese texto **nombra a los proveedores**. Añadir Deepgram significa que todo
paciente que ya aceptó lo hizo sobre una lista que no lo incluye: habría que
reescribir el texto, versionarlo y, en rigor, volver a pedir el consent. El ADR
ya deja anotada esa deuda (`ConsentEvent` con versión del texto) precisamente
porque hoy no podemos demostrar qué aceptó cada paciente.

**Deepgram es la mejor tecnología de las tres para audio y aun así es la peor
opción aquí**, porque su ventaja —latencia de streaming— no nos sirve: una nota
de voz llega entera, no en streaming. Pagaríamos un coste legal real por una
ventaja que nuestro caso de uso no usa.

Hay además una diferencia de fondo que conviene no pasar por alto: **una nota de
voz es mucho más sensible que el texto equivalente**. Lleva la voz misma, el
ruido de fondo, quién más está en la habitación, y la gente cuenta más cuando
habla que cuando escribe. El ADR contempla enviar *preguntas* a terceros; enviar
*grabaciones* es un salto cualitativo que el consent actual no explica.

De ahí una regla que propongo dejar fijada: **transcribir y no guardar el
audio**. Se persiste solo la transcripción, marcada como generada por el bot, y
el fichero se descarta. Almacenar audio de pacientes es PHI en un formato que el
ADR 0004 §1 ni siquiera cifra at-rest para las `notes`.

## Recomendación

**OpenAI `gpt-4o-mini-transcribe`.**

- Es el único proveedor que **ya está en el perímetro** y en el consent: lo
  usamos para los embeddings del RAG. Cero superficie legal nueva.
- ~$0.003/min es irrelevante al volumen del piloto.
- Reusa el patrón de `fetch` nativo sin SDK que ya sigue el repo.

Gemini saldría más barato en papel, pero elegirlo hoy significa además arreglar
el router (modelo retirado, key ausente), y mezclar dos problemas en un mismo
cambio. Si más adelante se arregla el router y se quiere consolidar en Google,
la migración es un cambio de endpoint.

**Deepgram, no** — salvo que en el futuro haya un caso de streaming real (una
llamada en vivo, por ejemplo), que es donde su ventaja sí pagaría el coste de
sumar un tercero al consent.

## Plan de 3 PRs

**PR 1 — que WAHA descargue el audio.** Infra y contrato, sin transcripción.
Añadir `WAHA_MEDIA_STORAGE` y `WAHA_MEDIA_POSTGRESQL_URL` al compose y a Coolify,
y que el webhook registre `media.url` en el `Message IN` en vez de solo `[audio]`.
Con esto se puede verificar en producción que el audio llega antes de gastar un
euro en transcribirlo. Criterio de aceptación: un audio real deja una URL
descargable y el aviso al paciente no cambia.

**PR 2 — transcribir.** `SttService` con `gpt-4o-mini-transcribe`, descarga del
media por la URL de WAHA, tope de duración (rechazar audios de más de ~2 min con
un mensaje amable: son monólogos, no consultas), y **el fichero se descarta tras
transcribir**. El texto entra al pipeline del bot como si el paciente lo hubiera
escrito. Tests con un fixture de audio corto y el proveedor mockeado.
`security-auditor` obligatorio.

**PR 3 — consent y copy.** Actualizar el texto del consent para decir que las
notas de voz se transcriben con IA y que el audio no se conserva, versionarlo, y
que el bot lo diga la primera vez que un paciente manda una nota de voz. Va
después y no antes porque el texto tiene que describir lo que el sistema hace de
verdad, no lo que planeamos que haga.

**Prerrequisito de los tres**: recuperar #46, porque el handoff tras dos adjuntos
es el fallback cuando la transcripción falla o el audio es demasiado largo.

## Relacionado
[[adr/0004-pii-y-compliance]] · [[adr/0002-waha-no-oficial]] ·
[[notas/2026-09-10-rag-umbral-distancia]] · [[analisis/2026-09-11-chatbot-analisis-tecnico]]

## Fuentes de precios (septiembre 2026)
- [Gemini Developer API pricing](https://ai.google.dev/gemini-api/docs/pricing)
- [OpenAI Transcribe & Whisper API Pricing (Sep 2026)](https://costgoat.com/pricing/openai-transcription)
- [Deepgram Nova-3 Pricing 2026](https://convertaudiototext.com/blog/deepgram-nova-3-explained)
- [WAHA — Receive messages](https://waha.devlike.pro/docs/how-to/receive-messages/)
- [WAHA — Engines](https://waha.devlike.pro/docs/how-to/engines/)
