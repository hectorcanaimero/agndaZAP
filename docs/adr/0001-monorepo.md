# ADR 0001 — Monorepo (pnpm workspace) + Flutter aparte

**Fecha:** 2026-08-08 · **Estado:** Aceptado

## Contexto
El producto tiene backend (NestJS), web (Next.js: panel + página pública) y app móvil (Flutter),
más tipos que backend y web comparten. Mantenerlos en repos separados duplica tipos y complica la
coordinación de contratos.

## Decisión
Monorepo único con pnpm workspace para los paquetes TypeScript (`apps/backend`, `apps/web`,
`packages/shared`). La app Flutter vive en `apps/mobile` dentro del mismo repo pero fuera del
workspace pnpm (usa su propio toolchain Dart/Flutter).

## Consecuencias
- (+) Tipos compartidos en `@agendazap/shared`, un solo lugar para los contratos.
- (+) Coordinación de cambios de API en un solo PR.
- (+) Reutiliza el patrón pnpm que ya se usa en Blog Condor.
- (−) La app Flutter no se beneficia del workspace pnpm (aceptable: distinto ecosistema).
- (−) Build/CI algo más complejo; se resuelve con filtros pnpm (`--filter`).
