# ADR 0002 — WAHA (WhatsApp no oficial) para el MVP

**Fecha:** 2026-08-08 · **Estado:** Aceptado (con riesgo asumido)

## Contexto
El público objetivo (clínicas pequeñas en LATAM) es sensible al costo. La API oficial de WhatsApp
Cloud exige verificación de negocio en Meta y cobra por conversación. WAHA conecta por WhatsApp Web
sin esos costos.

## Decisión
Usar WAHA en el MVP, una sesión por clínica. Diseñar `WahaService` como capa aislada para poder
sustituirlo por la API oficial sin tocar el resto del sistema.

## Consecuencias
- (+) Costo casi nulo, arranque rápido, multi-tenant simple (sesión por clínica).
- (−) **Riesgo de baneo** del número por Meta. Mitigación: número dedicado, volumen moderado,
  detección de desconexión + alerta.
- Plan: si un cliente escala o exige garantía, migrar esa clínica a la API oficial (la capa
  `WahaService` lo permite sin refactor grande).
