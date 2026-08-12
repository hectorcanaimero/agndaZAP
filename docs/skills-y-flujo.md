# Skills, agentes y flujo de trabajo — Showly

Referencia de las herramientas de IA que usa este proyecto y en qué orden aplicarlas.
Objetivo: mantener disciplina (validar y especificar antes de codear) y no saltar pasos.

## Flujo estándar de arranque de una feature
1. **`validacion-mercado`** (skill propio) — go/no-go: ¿vale la pena? Marcar supuestos.
2. **`/spec` → `spec-driven-development`** (pack agent-skills) — PRD/contratos antes del código.
   Alternativa metodológica: `cndr-multica-pm:aplicar-metodologia` (POC→PRD→SPEC).
3. **`/plan` → `planning-and-task-breakdown`** — descomponer en tareas pequeñas verificables.
4. **`/build` → `incremental-implementation`** — slices verticales delgados, commit por checkpoint.
5. **`/test` → `test-driven-development`** — tests de la lógica de negocio.
6. **`/review`** — invocar los agentes del proyecto (ver abajo) antes de mergear.
7. **`/ship`** — despliegue con feature flags / rollback.

Regla de oro: **validar demanda y especificar ANTES de escribir código.**

## Agentes del proyecto (`.claude/agents/`)
- **`code-reviewer`** — revisión de 5 ejes (correctitud, multi-tenant, TZ/Luxon, idempotencia, calidad).
- **`test-engineer`** — cobertura de disponibilidad, estados, recordatorios, aislamiento tenant.
- **`security-auditor`** — OWASP + PII de salud + fugas entre tenants. **Invocar siempre** en cambios
  que toquen datos de pacientes, auth, multi-tenant o el endpoint público de agendamiento.

## Pack agent-skills (Addy Osmani) — comandos
`/spec` · `/plan` · `/build` · `/test` · `/review` · `/code-simplify` · `/ship`
(23 skills del ciclo de desarrollo; se activan solas según la tarea.)

## Skills propios relevantes
- **`validacion-mercado`** — evaluación go/no-go de ideas.
- **`perfil-alejandro`** — contexto del owner (stack, sesgos, proceso). Lo carga el asistente al asesorar.

Ver también: [[SPEC]] · [[ARCHITECTURE]] · [[proximo-incremento]]
