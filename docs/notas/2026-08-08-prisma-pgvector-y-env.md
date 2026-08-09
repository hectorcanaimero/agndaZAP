# Prisma + pgvector y carga de `.env` en el monorepo

**Fecha:** 2026-08-08
**Contexto:** primer `prisma migrate dev --name init` del backend.

## Gotcha 1 — `extensions` requiere `previewFeatures`

Declarar `extensions = [pgvector(map: "vector")]` en el bloque `datasource` **no basta**. Prisma
5 valida el schema y falla con `P1012` si el `generator client` no declara la preview feature:

```prisma
generator client {
  provider        = "prisma-client-js"
  previewFeatures = ["postgresqlExtensions"]
}

datasource db {
  provider   = "postgresql"
  url        = env("DATABASE_URL")
  extensions = [pgvector(map: "vector")]
}
```

Con esa flag activa, `prisma migrate dev` emite `CREATE EXTENSION IF NOT EXISTS "vector";`
al inicio de la migración. Verificado en `20260809010743_init/migration.sql` y en la DB:
`SELECT extname, extversion FROM pg_extension WHERE extname='vector';` → `vector | 0.8.6`.

## Gotcha 2 — Prisma no lee el `.env` de la raíz del monorepo

Al correr `pnpm prisma ...` desde `apps/backend/`, Prisma busca `.env` solo en:

1. El `CWD` (`apps/backend/`)
2. La carpeta del `schema.prisma` (`apps/backend/prisma/`)

**No sube** al workspace root (`/`). Por eso `DATABASE_URL` viene vacío aunque exista en la
`.env` de la raíz.

### Decisión

Symlink desde el backend a la `.env` de la raíz — DRY, una sola fuente de verdad:

```bash
ln -sf ../../.env apps/backend/.env
```

Alternativa descartada: duplicar la `.env` en cada app. Se desincroniza rápido.

### Host vs container: dos DATABASE_URL distintas

- **Host** (Prisma CLI, dev tooling): `postgresql://agendazap:agendazap@localhost:5432/agendazap`
- **Container backend** (dentro de la red de compose): `postgresql://agendazap:agendazap@db:5432/agendazap`

La `.env` de la raíz define el valor del **host** (`localhost`). El `docker-compose.yml` ya
hace override explícito bajo `services.backend.environment.DATABASE_URL` con `db:5432`, así
que el container siempre resuelve el hostname correcto. No hay conflicto.

## Ver también
- [[adr/0001-monorepo|ADR 0001 — Monorepo pnpm + Flutter]]
- `apps/backend/prisma/schema.prisma`
- `apps/backend/prisma/migrations/20260809010743_init/migration.sql`
