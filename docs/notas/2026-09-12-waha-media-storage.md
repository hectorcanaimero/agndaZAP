---
titulo: WAHA no descarga los adjuntos si no se lo pides
fecha: 2026-09-12
tags: [waha, whatsapp, media, audio, privacidad, gotcha]
---

# `WAHA_MEDIA_STORAGE` y la vida del fichero

Primer PR de M10 ([[notas/2026-09-11-exploracion-stt-notas-de-voz]]). Infra y
contrato: deja el audio accesible, sin transcribir todavía.

## El gotcha

**NOWEB entrega `hasMedia: true` con `media: null`** si el contenedor de WAHA no
tiene almacenamiento de media configurado. Detecta que llegó un adjunto pero no
lo descarga, así que no hay nada que transcribir ni nada que escuchar.

Se arregla con dos variables **en el servicio `waha`**, no en el backend:

```yaml
WAHA_MEDIA_STORAGE: POSTGRESQL
WAHA_MEDIA_POSTGRESQL_URL: postgresql://…@db:5432/…
```

Es el tipo de cosa que parece un bug del código durante un rato largo: el
webhook recibe el evento, la rama de adjuntos funciona, y sin embargo no hay
fichero por ninguna parte.

## La vida del fichero, que es donde está la decisión

`WHATSAPP_FILES_LIFETIME` controla cuántos segundos vive el adjunto antes de que
WAHA lo borre solo. **El default de WAHA son 180 s**, y `0` desactiva la limpieza.

Los dos extremos son malos por razones distintas:

- **180 s** deja sin audio a cualquier reintento de la cola de transcripción. Si
  el worker falla y BullMQ reintenta a los cinco minutos, el fichero ya no está
  y el paciente se queda sin respuesta, en silencio.
- **`0`** convierte la base de WAHA en un **archivo permanente de grabaciones de
  pacientes**. Eso es PHI acumulándose sin política de retención, sin cifrado
  at-rest ([[adr/0004-pii-y-compliance]] §1) y sin que nadie lo haya decidido.

Elegimos **900 s (15 min)**: margen de sobra para transcribir y reintentar, y el
audio desaparece solo poco después. Va explícito en los tres compose, no como
default implícito, precisamente porque es una decisión de privacidad y no un
detalle de configuración.

Esto es lo que hace realmente aplicable el *"transcribir y no guardar el audio"*
de la nota de exploración: no basta con que el backend no lo persista, hay que
configurar que WAHA tampoco.

## Qué queda en el `Message IN`

Antes: `[audio]`. Ahora: `[audio] (17s · https://waha…/api/files/abc.oga)`.

La URL **caduca** con `WHATSAPP_FILES_LIFETIME`, así que quien la consuma tiene
que asumir que puede estar muerta — incluido el `SttService` del PR 2.

Dos detalles del parseo:

- **La duración viene anidada y cambia de sitio.** NOWEB la mete bajo el tipo
  concreto (`_data.message.audioMessage.seconds`, `videoMessage.seconds`) y el
  nombre varía entre versiones, así que se prueban varias rutas y se acepta que
  no venga. Es información para quien atiende, no algo de lo que dependa nada.
- **La URL se valida antes de guardarla.** El campo viene de un tercero y acaba
  en la bandeja del panel, así que solo se acepta `http(s)`: un `javascript:` o
  un `data:` ahí sería un problema de otra clase.

## Para el deploy

Las variables van **al servicio `waha` de Coolify**, no al backend. Mientras no
estén, todo sigue funcionando exactamente igual que hasta ahora: `media` llega
`null` y el `Message IN` queda como antes. El PR no rompe nada por no
desplegarse, solo no hace nada.

## Relacionado
[[notas/2026-09-11-exploracion-stt-notas-de-voz]] · [[adr/0002-waha-no-oficial]] ·
[[adr/0004-pii-y-compliance]]

## Fuentes
- [WAHA — Storages](https://waha.devlike.pro/docs/how-to/storages/)
- [WAHA 2025.1 — PostgreSQL support](https://waha.devlike.pro/blog/waha-2025-1/)
