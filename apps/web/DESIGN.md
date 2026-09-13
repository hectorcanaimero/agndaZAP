---
name: Showly (superficies públicas)
description: La vida de una cita que se confirma sola, en navy, mist y un solo teal.
colors:
  navy: "#0F2A4A"
  navy-hover: "#16375D"
  teal: "#28D9B9"
  teal-ink: "#0A7A67"
  mist-50: "#F7F9FB"
  mist-100: "#EEF2F6"
  mist-200: "#DFE6EE"
  mist-300: "#C3CEDA"
  mist-600: "#4A5A70"
  mist-700: "#33435A"
  surface-white: "#FFFFFF"
  chat-ink: "#171717"
  channel-green: "#15803D"
  channel-wallpaper: "#EFEAE2"
  channel-bubble-out: "#D9FDD3"
  status-pending: "#FDE68A"
  status-at-risk: "#FECDD3"
  status-writing: "#BAE6FD"
  error: "#DC2626"
typography:
  display:
    fontFamily: "Geist, ui-sans-serif, system-ui, sans-serif"
    fontSize: "2.6rem"
    fontWeight: 600
    lineHeight: 1.04
    letterSpacing: "-0.035em"
  headline:
    fontFamily: "Geist, ui-sans-serif, system-ui, sans-serif"
    fontSize: "2.25rem"
    fontWeight: 600
    lineHeight: 1.08
    letterSpacing: "-0.03em"
  numeral:
    fontFamily: "Geist, ui-sans-serif, system-ui, sans-serif"
    fontSize: "3rem"
    fontWeight: 600
    lineHeight: 1.1
    letterSpacing: "-0.03em"
    fontFeature: "\"tnum\""
  title:
    fontFamily: "Geist, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.25rem"
    fontWeight: 600
    lineHeight: 1.375
    letterSpacing: "normal"
  lead:
    fontFamily: "Geist, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.125rem"
    fontWeight: 400
    lineHeight: 1.625
    letterSpacing: "normal"
  body:
    fontFamily: "Geist, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.625
    letterSpacing: "normal"
  button:
    fontFamily: "Geist, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1rem"
    fontWeight: 600
    lineHeight: 1.5
    letterSpacing: "normal"
  label:
    fontFamily: "Geist, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 500
    lineHeight: 1.43
    letterSpacing: "normal"
  caption:
    fontFamily: "Geist, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 400
    lineHeight: 1.625
    letterSpacing: "normal"
rounded:
  field: "8px"
  inset: "12px"
  card: "16px"
  device: "2.6rem"
  pill: "9999px"
spacing:
  gutter-mobile: "16px"
  gutter-tablet: "24px"
  gutter-desktop: "32px"
  container-max: "72rem"
  grid-gap: "16px"
  card-pad: "24px"
  card-pad-roomy: "32px"
  column-gap: "40px"
  column-gap-wide: "64px"
  heading-to-content: "48px"
  heading-to-content-wide: "64px"
  section-y: "80px"
  section-y-wide: "112px"
components:
  button-primary:
    backgroundColor: "{colors.navy}"
    textColor: "{colors.surface-white}"
    typography: "{typography.button}"
    rounded: "{rounded.pill}"
    padding: "0 28px"
    height: "56px"
  button-primary-hover:
    backgroundColor: "{colors.navy-hover}"
  button-primary-compact:
    backgroundColor: "{colors.navy}"
    textColor: "{colors.surface-white}"
    typography: "{typography.label}"
    rounded: "{rounded.pill}"
    padding: "0 20px"
    height: "32px"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.navy}"
    typography: "{typography.button}"
    rounded: "{rounded.pill}"
    padding: "0 24px"
    height: "56px"
  card:
    backgroundColor: "{colors.surface-white}"
    textColor: "{colors.navy}"
    rounded: "{rounded.card}"
    padding: "{spacing.card-pad-roomy}"
  card-tonal:
    backgroundColor: "{colors.mist-100}"
    textColor: "{colors.navy}"
    rounded: "{rounded.card}"
    padding: "{spacing.card-pad-roomy}"
  card-action:
    backgroundColor: "{colors.navy}"
    textColor: "{colors.surface-white}"
    rounded: "{rounded.card}"
    padding: "{spacing.card-pad-roomy}"
  card-action-hover:
    backgroundColor: "{colors.navy-hover}"
  card-inset:
    backgroundColor: "{colors.mist-100}"
    textColor: "{colors.navy}"
    rounded: "{rounded.inset}"
    padding: "20px"
  input-field:
    backgroundColor: "{colors.surface-white}"
    textColor: "{colors.navy}"
    typography: "{typography.label}"
    rounded: "{rounded.field}"
    padding: "4px 12px"
    height: "44px"
  chip-confirmed:
    backgroundColor: "{colors.navy}"
    textColor: "{colors.surface-white}"
    typography: "{typography.caption}"
    rounded: "{rounded.pill}"
    padding: "6px 12px"
  chat-bubble-out:
    backgroundColor: "{colors.channel-bubble-out}"
    textColor: "{colors.chat-ink}"
    rounded: "{rounded.card}"
    padding: "6px 12px"
  chat-bubble-in:
    backgroundColor: "{colors.surface-white}"
    textColor: "{colors.chat-ink}"
    rounded: "{rounded.card}"
    padding: "6px 12px"
---

# Design System: Showly (superficies públicas)

Alcance: landing `/`, `/seguridad` y legales (`/privacidad`, `/terminos`). El panel `/panel/*` y `/admin/*` son otro mundo (Inter, grises shadcn) y quedan fuera de este documento; `/agendar/[clinicSlug]` tampoco se cubre en esta pasada.

## Overview

**Creative North Star: "The Appointment That Confirms Itself"**

La página es la vida de una cita: un mensaje de WhatsApp que se vuelve pendiente, luego confirmada o en riesgo, y termina en la agenda de recepción. Todo lo visual está al servicio de esa transición de estado. El producto es la prueba (un teléfono que se escribe solo, una agenda que cambia de estado, una calculadora con los números del visitante); por eso no hay fotos de stock, logos de clientes ni cifras inventadas que decorar.

El mundo es un neutro frío con tinte navy (mist) sobre el que el navy hace de tinta y de única superficie oscura, y el teal aparece sólo como acento: rellenos, marcas, subrayados e íconos sobre navy. Geist lleva display y cuerpo con pesos semibold y tracking negativo en los titulares. La densidad es media y editorial: secciones con aire (80 px, 112 px en desktop), splits asimétricos y una sola columna en mobile.

Rechazos confirmados por el owner (ADR 0025): el "SaaS cálido" por defecto (crema, serif display, sombras marrones, tarjetas de ícono clonadas), la grilla de pasos 01/02/03, los `FadeIn` idénticos en cada sección y cambiar de tema varias veces en la misma página.

**Key Characteristics:**
- Navy como tinta y como el único bloque oscuro; mist como suelo; teal como único acento.
- Geist en todo, semibold (600) con tracking negativo en titulares grandes.
- Profundidad por tono y hairline, no por sombra; la sombra se reserva para los dos protagonistas.
- Botones pastilla, tarjetas de 16 px, paneles internos de 12 px.
- Movimiento sólo en dos momentos con motivo: el SÍ del paciente y el cambio de estado de la agenda.
- El color semántico extra (estados de cita, verde del canal) vive dentro de la UI de producto, nunca en la página.

## Colors

Una paleta fría y contenida: navy y mist hacen el 90 % del trabajo y el teal marca lo que importa.

### Primary
- **Showly Navy** (navy): tinta de titulares, cuerpo fuerte y enlaces; relleno de todos los botones primarios; superficie del único bloque oscuro a ancho completo ("La vida de una cita"), de las tarjetas de acción de la demo y del marco del teléfono.
- **Navy Pressed** (navy-hover): hover de botones primarios y tarjetas de acción navy. Es la única variación de navy.

### Secondary
- **Signal Teal** (teal): el acento. Rellenos (check del piloto, celda de feedback al 15 %, selección de texto al 35 %), marcas (subrayado de enlaces, indicador activo del nav y de los pasos), íconos, texto de acción y chip "confirmada" sobre navy, anillo de foco global.
- **Teal Ink** (teal-ink): el mismo tono oscurecido para que el teal pueda ser texto o ícono sobre fondos claros con contraste AA. Íconos de hechos, funcionalidades y franja de seguridad.

### Neutral
- **Mist 50** (mist-50): suelo de la página, del nav (opaco) y de las legales.
- **Mist 100** (mist-100): bandas tonales (franja de seguridad, cierre con formulario), celdas tonales, el panel de resultado de la calculadora, paneles internos y la burbuja entrante fuera del teléfono; hover de filas del menú móvil.
- **Mist 200** (mist-200): hairlines y bordes de tarjeta, divisores de FAQ y de la demo.
- **Mist 300** (mist-300): borde de controles circulares (el "+" de la FAQ).
- **Mist 600** (mist-600): texto secundario (subtítulos, cuerpo de tarjetas, notas, links del nav en reposo).
- **Mist 700** (mist-700): texto secundario más fuerte (labels del formulario, chips de la franja de seguridad, links del footer).
- **White** (surface-white): tarjetas con borde, sección demo, footer, franja de hechos al 60 %.

### Product-UI colors (sólo dentro de mocks de producto)
- **Channel Green / Wallpaper / Outgoing Bubble** (channel-green, channel-wallpaper, channel-bubble-out) con **Chat Ink** (chat-ink): el lenguaje del canal WhatsApp dentro del teléfono del hero y de la muestra de "handoff". No son marca.
- **Status Pending / At Risk / Writing** (status-pending, status-at-risk, status-writing): texto de los chips de estado sobre navy, con fondo del mismo tono al 10 % y anillo al 25-30 %. "Confirmada" usa teal; "atendida" usa blanco al 60 %.
- **Error** (error): mensajes de validación del formulario (fondo red-50 y borde red-200 en el banner).

### Named Rules
**The Single Accent Rule.** Teal es el único acento. Como texto sobre claro usa siempre teal-ink; el teal de marca como texto sólo va sobre navy.

**The One Dark Block Rule.** Una página tiene un solo bloque navy a ancho completo. Las demás secciones cambian de tono dentro de la familia mist/blanco; navy dentro de ellas sólo como relleno de acciones (botones, tarjetas de acción) o de UI de producto.

**The States Stay In The Product Rule.** Ámbar, rosa, cielo y los verdes del canal sólo existen dentro de una UI de producto (teléfono, agenda, muestras). Nunca pintan secciones, íconos decorativos ni CTAs.

## Typography

**Display Font:** Geist (con ui-sans-serif, system-ui)
**Body Font:** Geist (con ui-sans-serif, system-ui)

**Character:** Una sola familia grotesca, precisa y sin adorno. La jerarquía sale de tamaño, peso 600 y tracking negativo, no de un contraste de familias.

### Hierarchy
- **Display** (600, 2.6rem; sm 3.75rem, lg 3.4rem en el split, xl 3.6rem; 1.04; -0.035em): sólo el H1 del hero, con `text-balance`, dos líneas.
- **Headline** (600, 2.25rem; sm 3rem; 1.08; -0.03em): H2 de cada sección, con `text-balance` y ancho máximo de 42-48rem.
- **Numeral** (600, 3rem; sm 3.75rem; -0.03em, tabular): el resultado de la calculadora; cifras secundarias en 1.5rem 600 tabular.
- **Title** (600, 1.25rem; 1.375): H3 de celdas, pasos (sm 1.5rem en el bloque oscuro), títulos de tarjetas de acción en 1.5rem, preguntas de FAQ en 1.125rem.
- **Lead** (400, 1.125rem; 1.625; mist-600): subtítulo bajo cada H2, máx. 40rem cuando va apilado bajo el H2 y 28-34rem dentro de un split. En el hero sube a 1.25rem en sm.
- **Body** (400, 1rem; 1.625; mist-600): cuerpo de tarjetas y respuestas, máx. 28rem (~65ch en FAQ).
- **Button** (600, 1rem): texto de botones y enlaces de acción.
- **Label** (500, 0.875rem): nav, hechos, labels de formulario, chips de la franja de seguridad.
- **Caption** (400, 0.75rem): notas legales, copyright, chips de estado (500).

### Named Rules
**The One Family Rule.** Geist lleva display y cuerpo en toda superficie pública, activado con `font-display` en el wrapper de la página. Nada de serif display ni de una segunda familia.

**The Tight Headline Rule.** El tracking negativo (-0.03em a -0.035em) es sólo para 36 px o más. Title, body y label van con tracking normal.

## Layout

Contenedor centrado de 72rem con gutters de 16/24/32 px (mobile/sm/lg). Ritmo vertical de sección de 80 px, 112 px desde lg; bandas comprimidas (hechos, seguridad) con 20-40 px. Del H2 al contenido 48 px, 64 px en lg.

Dos patrones de sección. (1) Encabezado apilado: H2 (máx. 42-48rem) y lead (máx. 40rem) arriba, contenido a lo ancho debajo; lo usan problema (calculadora partida 1.1/0.9 entre controles y resultado), funcionalidades y demo (grilla de 2 tarjetas de acción desde md). (2) Split asimétrico de dos columnas en lg, que se apila debajo de 1024 px: hero 1.35/0.65 (texto / teléfono), cierre 1/1 con el formulario. La FAQ es una sola columna de lectura de 48rem. Los hijos de grid llevan `min-w-0`. Las funcionalidades usan una grilla de 6 columnas con celdas 4+2 / 2+2+2 (md: 2 columnas; mobile: 1). La vida de una cita pone los pasos a la izquierda (cada uno de 28vh de alto) y la agenda sticky a la derecha; en mobile la agenda va primero.

Separación de columnas 40 px, 64 px en lg; entre tarjetas 16 px. Padding de tarjeta 24 px, 32 px desde sm (40 px en la tarjeta de precio). Nav sticky de 64 px; las anclas compensan con `scroll-margin-top` de 64 px. Breakpoints de Tailwind: sm 640, md 768, lg 1024, xl 1280.

## Elevation & Depth

Híbrido que es plano por defecto. La profundidad sale del tono (mist-50 → mist-100 → blanco → navy) y de hairlines mist-200 en `border-y` entre bandas. Las tarjetas llevan borde o tono, no sombra. El único vidrio es el nav (mist-50 al 85 % con blur) y, dentro del bloque navy, paneles blancos al 3-8 % con anillo interno blanco al 10 %. Las sombras tienen tinte navy y se reservan para lo que protagoniza la primera pantalla.

### Shadow Vocabulary
- **Lift MD** (`box-shadow: 0 6px 16px -4px rgba(15, 42, 74, 0.10), 0 2px 4px rgba(15, 42, 74, 0.05)`): el CTA primario del hero.
- **Lift LG** (`box-shadow: 0 24px 48px -16px rgba(15, 42, 74, 0.22), 0 8px 16px -8px rgba(15, 42, 74, 0.10)`): el teléfono del hero.
- **Lift SM** (`box-shadow: 0 1px 2px rgba(15, 42, 74, 0.06), 0 1px 3px rgba(15, 42, 74, 0.05)`): definida para superficies públicas, sin uso todavía.

### Named Rules
**The Border Or Shadow Rule.** Una sola elevación por elemento: borde, tono o sombra, nunca dos.

**The Two Protagonists Rule.** En la landing sólo llevan sombra el CTA primario del hero y el teléfono. Todo lo demás es plano.

## Shapes

Geometría suave y consistente por rol. Acciones y estados en pastilla (9999px): botones, chips de estado, chip "confirmada", checks del piloto, el "+" de la FAQ. Contenedores en 16 px: tarjetas, celdas, calculadora, formulario, la lista de la demo. Lo anidado dentro de una tarjeta baja a 12 px: el panel "¿y después?", el tile del ícono de la demo, las filas de la agenda y el menú móvil. Los campos del formulario van en 6 px (primitivo shadcn; la dirección pedía 8 px y aún no se aplicó).

El teléfono es la silueta firma: marco navy de 2.6rem con pantalla de 2.1rem y una isla pastilla navy. Las burbujas de chat son de 16 px con la esquina de la cola en 6 px (abajo a la derecha si sale, abajo a la izquierda si entra). La barra de estado activo es una línea de 1 px (paso activo en el bloque oscuro, subrayado del nav), no un bloque.

## Components

### Buttons
Firmes y redondos; una sola acción principal por página, repetida con el mismo texto.
- **Shape:** pastilla completa (9999px).
- **Primary:** relleno navy, texto blanco 600 de 1rem, 56 px de alto con 28 px de padding horizontal (48 px de alto en el formulario, ancho completo en precio y formulario). Flecha a la derecha que avanza 4 px en hover.
- **Hover / Focus:** fondo navy-hover; el del hero además sube 2 px con `out-soft` (cubic-bezier(0.22, 1, 0.36, 1), 300 ms) y vuelve a 0 en active. Foco: el anillo global teal de 2 px con offset de 2 px (el primitivo shadcn `Button` todavía lo reemplaza por un anillo navy de 1 px, invisible sobre el relleno navy; no copiar ese override).
- **Compact (nav):** misma pastilla navy en 32 px, label 600 de 0.875rem, 20 px de padding.
- **Ghost:** sin fondo, texto navy 600, 56 px; hover con navy al 5 %. Es la única acción secundaria ("Probar el bot").

### Chips
- **Estado de cita (sobre navy):** pastilla con ícono lucide de 14 px, caption 500, fondo del tono al 10-15 %, texto del tono claro y anillo interno al 25-30 %. Aparece con opacidad y escala 0.9 → 1 en 300 ms al cambiar de estado.
- **Confirmada (en el chat):** pastilla navy con ícono teal y texto blanco; es el remate de la animación del hero.

### Cards / Containers
- **Corner Style:** 16 px; paneles anidados 12 px.
- **Background:** blanco con borde mist-200 (celdas de funcionalidad, calculadora, formulario, precio), mist-100 sin borde (celda protagonista, resultado de la calculadora, paneles internos), teal al 15 % para una sola celda de acento, navy para tarjetas de acción.
- **Shadow Strategy:** ninguna (ver The Border Or Shadow Rule).
- **Border:** hairline mist-200 o nada.
- **Internal Padding:** 24 px, 32 px desde sm.
- **Contenido (celda de funcionalidad):** title y body arriba, y debajo un fragmento de UI real del producto (burbujas, lista de profesionales en un panel de 12 px, filas de zona horaria, estrellas) en vez de un ícono suelto. Separación de 32 px entre texto y fragmento; en la celda ancha el fragmento va a la derecha alineado abajo.

### Action Card
Tarjeta-enlace para probar el producto (bot demo, página de agendamiento demo). Relleno navy, 16 px de radio, 24/32 px de padding, altura igual en la grilla. Ícono lucide de 28 px en teal con trazo 1.75, título de 1.5rem 600 en blanco, cuerpo blanco al 75 % y la acción en teal 600 con flecha diagonal que se desplaza 2 px hacia arriba y a la derecha. Hover: fondo navy-hover en 200 ms. Abre en pestaña nueva.

### Inputs / Fields
- **Style:** primitivo shadcn re-skineado en la landing: 44 px de alto (target táctil), borde mist-300 de 1 px, 8 px de radio, texto de 0.875rem en desktop; labels 500 navy encima con 8 px de aire.
- **Focus:** anillo de 1 px en navy (del primitivo). Los botones navy llevan anillo teal de 2 px con offset, porque el navy no se ve sobre navy.
- **Error / Disabled:** mensaje caption en error bajo el campo con `role="alert"`; banner de envío en red-50 con borde red-200. Deshabilitado al 50 %.
- **Slider (calculadora):** `accent-color` navy, 8 px de alto; el valor va a la derecha del label en 600 tabular.

### Navigation
- **Style:** barra sticky de 64 px, mist-50 opaco con hairline mist-200 (translúcida se enturbiaba sobre el bloque navy). Las anclas llevan ruta (`/<locale>#seccion`) porque /seguridad y las legales usan la misma nav. Wordmark a la izquierda, anclas en label 500 mist-600 al centro, "Entrar" y el CTA compacto a la derecha.
- **States:** hover pasa a navy y dibuja un subrayado teal de 1 px que crece desde la izquierda en 300 ms.
- **Mobile:** botón de menú de 40 px; panel mist-50 con filas de 12 px de radio, 16 px de texto y el CTA como pastilla de ancho completo al final.

### Inline Action Link
Enlaces de acción dentro del texto sobre claro (ver seguridad, WhatsApp de ventas): texto navy 600 con subrayado teal de 2 px y offset de 4 px, flecha o ícono que se desplaza 2-4 px en hover.

### Hero Phone (signature)
Marco navy de 2.6rem con Lift LG, máx. 340 px de ancho, pantalla con el lenguaje del canal (barra verde, fondo wallpaper, burbujas). El HTML del servidor ya trae la conversación completa; al entrar en pantalla se reproduce una vez el final: escribiendo, SÍ del paciente (opacidad, 12 px y escala 0.96 → 1 en 350 ms) y chip "confirmada". Con `prefers-reduced-motion` muestra el estado final quieto. Alto fijo de 440-470 px con los mensajes anclados abajo y una máscara de 56 px arriba.

### Appointment Lifecycle (signature)
El único bloque navy. Pasos en una lista con línea izquierda blanca al 15 % y un segmento teal de 1 px en el paso activo; en desktop los inactivos se atenúan con color (título blanco 60 %, cuerpo blanco 55 %, ambos AA sobre navy), nunca con opacidad sobre texto ya translúcido. A la derecha, la agenda del día en un panel blanco al 6 % con 16 px de radio: filas de 12 px con hora tabular, paciente, servicio y chip de estado; la fila en foco lleva anillo teal al 40 %. Un indicador de progreso de pastillas (activo 20 px teal, resto 6 px blanco al 25 %). En desktop avanza con el scroll; en mobile recorre los pasos una sola vez mientras está a la vista y se queda en el día completo; con reduced motion muestra el día completo.

## Do's and Don'ts

### Do:
- **Do** usar navy (#0F2A4A) como tinta y como único relleno de CTA; su hover es navy-hover (#16375D).
- **Do** poner el teal como texto sólo sobre navy; sobre mist o blanco usa teal-ink (#0A7A67).
- **Do** envolver cada página pública con `bg-mist-50 font-display text-brand-navy` para que herede Geist y la tinta navy.
- **Do** separar secciones por tono (mist-50, mist-100, blanco) y hairline mist-200, con un solo bloque navy por página.
- **Do** usar pastilla para botones y chips de estado, 16 px para tarjetas y 12 px para lo anidado dentro de ellas.
- **Do** mostrar la UI real del producto (chat, agenda, estados) donde otra plantilla pondría un ícono o una foto.
- **Do** limitar el movimiento a transiciones de estado con motivo, con `out-soft` y 200-400 ms, respetando `prefers-reduced-motion` y con el HTML del servidor comprensible sin JS.
- **Do** usar íconos lucide con trazo 1.75.

### Don't:
- **Don't** usar crema, serif display, sombras marrones ni tarjetas de ícono clonadas en fila (el "SaaS cálido" rechazado en ADR 0025).
- **Don't** numerar pasos como 01/02/03 en grilla.
- **Don't** poner eyebrows ni encabezados en mayúsculas con tracking amplio sobre los titulares.
- **Don't** repetir la misma animación de entrada (fade-in/stagger) en cada sección.
- **Don't** combinar borde y sombra en el mismo elemento, ni dar sombra a tarjetas de contenido.
- **Don't** sacar ámbar, rosa, cielo o los verdes de WhatsApp de la UI de producto.
- **Don't** meter una segunda sección oscura a ancho completo (neutral-900 o navy) en una página que ya tiene su bloque navy.
- **Don't** ilustrar con testimonios, logos de clientes, retratos de stock ni métricas que el producto no respalda.
