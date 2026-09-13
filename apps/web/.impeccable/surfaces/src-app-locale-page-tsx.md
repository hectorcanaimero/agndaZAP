---
version: 1
slug: "src-app-locale-page-tsx"
primary_target: "src/app/[locale]/page.tsx"
related_targets: []
---

# Landing pública `/` (Showly)

Modo: Persuade. Visitante: dueño/a o administrador/a de clínica pequeña/mediana en LATAM y Brasil, decide en <60 s si deja sus datos. Acción: unirse al piloto gratis (form o WhatsApp). Prueba disponible: el producto mismo (bot demo por WhatsApp + `/agendar/<slug demo>`), la calculadora con los números del visitante y la honestidad de `/seguridad`. Sin testimonios, logos ni métricas inventadas (PRODUCT.md).

Decisiones del owner (2026-09-13): la clínica puede usar su número, se recomienda uno dedicado; demo público aprobado; dirección visual pinned por el owner (abajo), sin ronda de conceptos.

## Direction contract

THESIS: la página es la vida de una cita que se confirma sola. Rechaza el "SaaS cálido" por defecto (crema + serif display + tarjetas de ícono clonadas) y la grilla de 01/02/03.

OWN-WORLD: neutro frío con tinte navy (`mist`), tinta navy #0F2A4A, teal #28D9B9 como único acento (relleno y marcas; texto teal solo sobre navy). Geist para display y cuerpo de la landing. Pastillas solo en botones, tarjetas 16 px, inputs 8 px. Los estados de cita (pendiente/confirmada/en riesgo) son el único color semántico extra y viven dentro de la UI de producto.

STORY: entiende que el no-show le cuesta dinero medible (calculadora), ve cómo una cita pasa de WhatsApp a confirmada o en riesgo, lo prueba con el bot demo y se une al piloto sin tarjeta.

FIRST VIEWPORT: split. Izquierda: H1 de 2 líneas "Deja de perder pacientes por no-show.", subtítulo <=20 palabras, CTA primario "Unirme al piloto" y secundario "Probar el bot". Derecha: teléfono con la conversación que se escribe sola hasta el recordatorio. Franja de hechos debajo del hero, fuera de él.

FORM: redesign pinned por el owner (sin seed; concept-seed no corrido por dirección fijada por el usuario). Code-led, sin comps.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
