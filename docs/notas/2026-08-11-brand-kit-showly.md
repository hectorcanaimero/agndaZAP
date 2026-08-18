# 2026-08-11 — Brand kit de Showly (logo, paleta, favicon)

Cierre del proceso de identidad visual arrancado en [[2026-08-10-nombre-gochat-y-logo|la nota del 10]] y
oficializado por el rebrand del [[../adr/0013-rename-a-showly|ADR 0013]].

## Contexto

Con `showly.tech` ya elegido como dominio y el rebrand mergeado (PR #18), quedaba pendiente
definir la identidad visual final. Se sustituye por completo el logo `gochat` (píldora verde
con checkmark) que había sido diseñado para la landing anterior.

## Proceso

1. **Marketing psychology aplicado al brief** (skill `marketing-psychology`):
   - Barbell strategy: 3 modelos con niveles de riesgo distintos, no variaciones del mismo.
   - Framework: Jobs to Be Done + Authority Bias (sector salud) + Mere Exposure Effect
     (formas simples, memorable a 32px) + Peak-End Rule (primer/último punto visual).
2. **3 propuestas generadas** con Da Vinci (`fal/recraft-v3-svg`), Diseñá.08 c/u:
   - **Modelo 1** — wordmark seguro (Calendly/Linear/Notion vibe).
   - **Modelo 2** — símbolo + wordmark (Cal.com/Stripe/Vercel vibe).
   - **Modelo 3** — mark abstracto audaz (Slack/Airbnb/Linear icon vibe).
3. **Elección**: modelo 1 (wordmark). El trazo curvo bajo `Sh` que Recraft agregó como
   "detalle diferenciador" quedó aprobado como parte del diseño luego de ver que sin él
   los glifos de `S` y `h` quedaban cortados (habían sido dibujados asumiendo el trazo).
4. **Iteración descartada**: se regeneró una v3 sin decoración (Diseñá.08 extra), pero se
   prefirió la v1 original con el trazo por su carácter distintivo.

## Sistema visual

### Paleta

| Token         | Hex        | RGB                | Uso                                             |
|---------------|------------|--------------------|-------------------------------------------------|
| navy          | `#0F2A4A`  | `rgb(32,44,83)`    | Letras del wordmark, fondo del favicon          |
| teal          | `#28D9B9`  | `rgb(40,217,185)`  | Punto sobre la `y`, círculo del favicon         |
| off-white     | `#F8FAFC`  | —                  | Letras del wordmark en modo oscuro              |
| dark-bg       | `#0F172A`  | —                  | Fondo modo oscuro (panel, hero dark)            |

> Nota: los `rgb(...)` triples son los que emite Recraft. Al integrar en la web/panel,
> usar los hex — son visualmente equivalentes.

### Logo

- **Wordmark horizontal** — `showly` en tipografía custom sans-serif geométrica minúscula,
  con un pequeño círculo teal actuando como punto sobre la `y` (indicador de "activo").
- **Trazo curvo característico** bajo `Sh` — parte del diseño, no decoración removible.
- **Aspect ratio** — canvas cuadrado 2048×2048 con el wordmark centrado horizontalmente.

### Favicon (companion mark)

El wordmark horizontal no lee a 32px, así que existe un **mark cuadrado independiente**
como companion. Diseño ultra-minimalista:

- Cuadrado navy `#0F2A4A` con esquinas redondeadas (rx 112 en viewBox 512, equivale a
  ~22% del lado — corner radius tipo iOS).
- Círculo teal `#28D9B9` centrado (r 96, ~19% del lado).

## Archivos en `assets/generated/`

### SVG

| Archivo                                        | Uso                                             |
|------------------------------------------------|-------------------------------------------------|
| `showly-logo-01-wordmark.svg`                  | Fuente producción (con trazo, 16 paths)         |
| `showly-logo-01-wordmark.original.svg`         | Backup gemelo                                    |
| `showly-logo-01-wordmark.clean.svg`            | Igual pero sin metadata C2PA · **7 KB**         |
| `showly-logo-01-wordmark.transparent.svg`      | Sin fondo blanco (para navbars)                 |
| `showly-logo-01-wordmark.dark.svg`             | Letras off-white sobre fondo `#0F172A`          |
| `showly-logo-01-wordmark.mono-black.svg`       | Monocromo `#000000` transparente                |
| `showly-logo-01-wordmark.mono-white.svg`       | Monocromo `#FFFFFF` transparente                |
| `showly-favicon.svg`                           | Mark cuadrado (32b) — favicon principal         |

### PNG (rasterizados con `rsvg-convert`)

- Wordmark: `-256/-512/-1024-color.png` + `-1024-{dark,mono-black,mono-white}.png`
- Favicon: `showly-favicon-{32,64,512}.png` + `showly-apple-touch-icon-180.png`
- Bundle: `showly-favicon.ico` (16/32/64/512 multi-tamaño, generado con ImageMagick)

### Preview

- `showly-brand-kit.html` — vista completa con aplicaciones simuladas (navbar, tab,
  avatar WhatsApp, tarjeta PDF).
- `showly-logo-01-compare.html` — comparativa v1 / v2 / v3.
- `showly-logo-01-debug.html` — cada path del SVG numerado y coloreado (útil para
  iterar sin regenerar).

## Regenerar variantes

El script `/tmp/build-showly-logo-variants.mjs` (guardado fuera del repo) toma el SVG
fuente y produce las 5 variantes SVG limpiando el metadata C2PA de Recraft. Si se
regenera el wordmark en el futuro, actualizar el script y correrlo. Rasterizar con:

```bash
rsvg-convert -w 1024 -h 1024 <svg> -o <png>
magick 32.png 64.png 512.png favicon.ico
```

## Pendientes

- [x] Reemplazar el logo `gochat` (`apps/web/src/components/landing/Logo.tsx`) por el
      nuevo wordmark Showly. *Hecho 2026-08-11 — componente reescrito, variantes `full`
      (wordmark via `<img>`) y `mark` (favicon inline).*
- [x] Copiar los assets críticos a `apps/web/public/`:
      `favicon.ico`, `favicon.svg`, `apple-touch-icon.png`. *Hecho — script en
      `/tmp/build-showly-web-assets.mjs`, también copia `showly-wordmark.svg` /
      `showly-wordmark-dark.svg` con viewBox recortado al bounding box del texto y
      `og-image.png` para social share.*
- [x] Actualizar `apps/web/src/app/[locale]/layout.tsx` con `metadata.icons` y
      `metadata.openGraph.images`. *Hecho — se usa el Metadata API de Next 15
      en vez de `<link rel="icon">` manual.*
- [~] ~~Actualizar el mock de teléfono del hero (WhatsApp preview) para usar el favicon
      como avatar de la conversación.~~ **Descartado 2026-08-11** — al revisar
      `WhatsAppMock.tsx` se confirmó que el avatar "A" representa a la clínica cliente
      del ejemplo ("Clínica Aurora"), no al producto Showly. El mock retrata cómo se
      ve el WhatsApp de una clínica que USA Showly; poner el favicon Showly ahí sería
      conceptualmente engañoso (el paciente le habla a su clínica, no a la plataforma).
      El comentario intencional en `WhatsAppMock.tsx:14-27` ya justifica la decisión.
- [x] Registrar tokens `navy` y `teal` en `tailwind.config.ts`. *Hecho 2026-08-11 —
      agregados como `brand.navy` (`#0F2A4A`) y `brand.teal` (`#28D9B9`) dentro del
      objeto `brand.*` existente. NO se tocó la escala verde `brand.50-900` porque
      representa el canal WhatsApp (mock del hero, tokens de estado del panel), no al
      producto Showly. Se documentó la coexistencia en el comentario del config.*

## Enlaces

- [[../adr/0013-rename-a-showly|ADR 0013 — Rebrand a Showly]]
- [[2026-08-10-nombre-gochat-y-logo|Nota 2026-08-10 — Logo anterior gochat]]
- [[../INDEX|Índice del vault]]
