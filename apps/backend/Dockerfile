# AgendaZap backend — multi-stage Dockerfile.
#
# Contexto: se buildea DESDE LA RAÍZ del monorepo para poder acceder a
# `pnpm-workspace.yaml`, `pnpm-lock.yaml` y `packages/`. Ver
# `docker-compose.prod.yml` para el build context correcto:
#   build:
#     context: .
#     dockerfile: apps/backend/Dockerfile

# ─────────────────────────── Stage 1: build ───────────────────────────
FROM node:20-alpine AS build

# pnpm via corepack — el mismo pin que el repo (pnpm 9.0.0).
RUN corepack enable && corepack prepare pnpm@9.0.0 --activate

WORKDIR /repo

# Copiar sólo los manifests primero — cache-friendly.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/backend/package.json ./apps/backend/
COPY packages/shared/package.json ./packages/shared/

# Instalar TODAS las deps (dev+prod) del workspace del backend + shared.
# `--frozen-lockfile` = build reproducible.
RUN pnpm install --frozen-lockfile --filter @showly/backend...

# Copiar el resto del código.
COPY packages/shared ./packages/shared
COPY apps/backend ./apps/backend

# Prisma generate + nest build.
WORKDIR /repo/apps/backend
RUN pnpm exec prisma generate
RUN pnpm build

# ─────────────────────────── Stage 2: runtime ───────────────────────────
FROM node:20-alpine AS runtime

# Adds: tini para PID 1 correcto (SIGTERM propagado a Node → shutdown limpio
# de BullMQ workers). openssl requerido por Prisma runtime.
RUN apk add --no-cache tini openssl

# Corremos como usuario no-root.
RUN addgroup -S app && adduser -S app -G app

WORKDIR /repo

# Copiamos los manifests + lockfile del workspace + dist compilado.
# `--frozen-lockfile` en el install debajo garantiza builds reproducibles.
# Si rompe por drift, es señal de que el lockfile debe regenerarse en el repo
# — NO bypasear con --no-frozen-lockfile (esa opción abre la puerta a que un
# atacante meta una versión distinta de una dep por typosquatting, y también
# vuelve los builds no-deterministas).
COPY --from=build /repo/package.json ./package.json
COPY --from=build /repo/pnpm-lock.yaml ./pnpm-lock.yaml
COPY --from=build /repo/pnpm-workspace.yaml ./pnpm-workspace.yaml
COPY --from=build /repo/apps/backend/package.json ./apps/backend/package.json
COPY --from=build /repo/apps/backend/dist ./apps/backend/dist
COPY --from=build /repo/apps/backend/prisma ./apps/backend/prisma
COPY --from=build /repo/packages/shared/package.json ./packages/shared/package.json

# Instalar SÓLO prod deps del workspace del backend (el `--filter` mantiene chico).
# Prisma client se regenera con `pnpm exec prisma generate` (postinstall skipped
# por `--ignore-scripts`; corremos generate explícito abajo).
RUN corepack enable && corepack prepare pnpm@9.0.0 --activate && \
    pnpm install --prod --frozen-lockfile --ignore-scripts --filter @showly/backend... && \
    cd apps/backend && pnpm exec prisma generate && cd /repo && \
    chown -R app:app /repo

USER app

WORKDIR /repo/apps/backend

EXPOSE 4000

# Entrypoint: primero corre migrations, después arranca el server.
# `sh -c` para poder chainear. `tini` como PID 1.
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["sh", "-c", "pnpm exec prisma migrate deploy && node dist/main.js"]
