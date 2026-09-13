---
status: accepted
date: 2026-09-13
tags: [web, landing, marca, diseño, marketing]
---

# ADR 0025 — Landing: navy + teal + Geist, la vida de una cita como hilo y cero prueba social inventada

## Contexto

La landing (`apps/web/src/app/[locale]/page.tsx`) se revisó el 2026-09-13 con tres lentes
(taste-skill, impeccable, marketing-psychology) sobre el código y capturas reales. Hallazgos que
motivan la decisión:

- **Testimonio inventado**: retrato de stock + cita de "Dueña de clínica · Piloto". `apps/web/PRODUCT.md`
  prohíbe fabricar testimonios; no hay clínica en producción con caso publicable.
- **El copy se contradecía**: hero y pasos decían "el WhatsApp de siempre / sin cambiar de número" y
  la FAQ respondía "¿Necesito un número nuevo? Sí".
- **Cuatro textos para la misma acción** ("Solicita tu demo", "Quiero entrar al piloto", "Quiero
  probarlo", "Escribinos por WhatsApp") y la oferta no sabía si era demo o piloto.
- **Sistema visual por defecto**: Fraunces + crema + sombras marrones + una sección café. Es el look
  que ambas skills señalan como "SaaS cálido generado"; y no es la marca (navy #0F2A4A + teal #28D9B9,
  [[notas/2026-08-11-brand-kit-showly]]). Además la página cambiaba de tema tres veces.
- **Bento de funcionalidades con celdas vacías** en desktop, tres secciones con la misma plantilla de
  tarjetas de ícono, y en mobile el hero no mostraba el producto en la primera pantalla.
- El diferenciador real (ciclo PENDIENTE → CONFIRMADA / EN_RIESGO) no aparecía; `AgendaLive.tsx` existía
  sin usarse.

## Decisión

Decidido con el owner (2026-09-13):

1. **Marca como sistema**: neutro frío con tinte navy (`mist-*`), navy como tinta y superficie oscura,
   teal como único acento (`teal-ink` para texto teal sobre claro, AA). Geist (`font-display`) para las
   superficies públicas; el panel sigue en Inter. Un solo bloque oscuro en la página. Botones pastilla,
   tarjetas 16 px, inputs 8 px; una sola elevación por elemento.
2. **Un CTA**: "Unirme al piloto" (pt: "Entrar no piloto") en nav, hero, precio y formulario. "Probar el
   bot" es la única acción secundaria (intención distinta). WhatsApp de ventas queda como alternativa en
   el cierre.
3. **Número**: la clínica puede usar su número; recomendamos uno dedicado. Dicho igual en hechos, FAQ y cierre.
4. **Prueba sin inventar**: fuera testimonios, logos y cifras de clientes. La prueba es (a) el producto
   mismo, con una clínica demo pública (ver [[notas/2026-09-13-demo-publico-landing]]), (b) una
   calculadora de costo de no-shows con los números del visitante, y (c) la honestidad de `/seguridad`.
5. **Estructura** (AIDA): hero con chat que se confirma solo → hechos → problema + calculadora → la vida
   de una cita (scroll-driven, estados reales) → funcionalidades (5 celdas) → demo → piloto con "¿y
   después?" → seguridad → FAQ → cierre con formulario. Salen "Para quién", el testimonio y los tres
   pasos 01/02/03.
6. **Movimiento con motivo**: sólo dos momentos (el SÍ del paciente en el hero y el cambio de estado de la
   agenda). Ambos respetan `prefers-reduced-motion` y el HTML del servidor ya se entiende sin JS. Fuera los
   `FadeIn`/`Stagger` idénticos en cada sección.

## Consecuencias

- **Positivas**: la página deja de afirmar cosas que no podemos respaldar; cada afirmación de producto se
  verificó contra el backend (recordatorios 24/3 h, `check-risk` con `confirmThresholdH`, feed iCal por
  profesional, feedback 1-5). Página ~24% más corta en desktop y ~26% en mobile.
- **Medición**: los eventos de Plausible no cambian de nombre (`hero_view`, `cta_click`, `lead_form_view`,
  `lead_submitted`); se suman ubicaciones `hero-demo`, `demo-whatsapp` y `demo-web` en `cta_click`. Comparar
  el embudo 2 semanas antes y después; con el tráfico actual un A/B no llega a significancia.
- **A cargo del owner**: encender `NEXT_PUBLIC_DEMO_*` con un número WAHA propio para la demo; sin ellas la
  sección no aparece. `/seguridad` y las páginas legales heredan Geist y `mist` pero no se rediseñaron.
- **Riesgo**: la demo pública manda WhatsApp reales a quien agenda; mitigaciones en la nota.
- El contrato visual vive en `apps/web/.impeccable/surfaces/src-app-locale-page-tsx.md` y los tokens en
  `apps/web/DESIGN.md`.
