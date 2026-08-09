# Nota — Next.js vs Astro para AgendaZap

**Fecha:** 2026-08-08 · **Tipo:** decisión de stack (web)

## Pregunta
¿Usar Next.js o Astro para `apps/web`?

## Resumen
No hay "mejor" absoluto: Astro brilla en sitios de contenido (landings, blog, marketing, docs,
e-commerce de catálogo) con casi cero JS; Next.js brilla en aplicaciones interactivas (paneles,
auth, dashboards, datos en vivo, formularios con estado). Regla: **¿sitio o aplicación?**

## Decisión
**Next.js** para todo `apps/web` en este proyecto.
- El **panel admin** es una app pura: agenda interactiva, bandeja de conversaciones en vivo,
  dashboard de no-show, auth + RBAC multi-tenant. Territorio Next.js.
- La **página pública `/agendar/[clinicSlug]`** es más "sitio", pero separarla en Astro obligaría
  a mantener dos stacks y duplicar tipos/llamadas API por una sola página. Next.js SSR la resuelve
  bien dentro del mismo `apps/web`, compartiendo `@agendazap/shared`.

## Cuándo sí usar Astro (futuro)
- Sitio de **marketing de AgendaZap** (landing para vender el producto): ahí Astro es la mejor opción.

Ver también: [[ARCHITECTURE|Arquitectura]] · [[adr/0001-monorepo|ADR 0001]]
