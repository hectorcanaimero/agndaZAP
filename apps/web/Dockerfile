# Showly web — multi-stage Dockerfile.
#
# Contexto: se buildea DESDE LA RAÍZ del monorepo. Ver
# `docker-compose.prod.yml`:
#   build:
#     context: .
#     dockerfile: apps/web/Dockerfile

# ─────────────────────────── Stage 1: build ───────────────────────────
FROM node:20-alpine AS build

RUN corepack enable && corepack prepare pnpm@9.0.0 --activate

# Coolify pasa NODE_ENV=production como --build-arg, lo cual hace que pnpm
# salte devDependencies y rompe el build. Desactivamos NODE_ENV en build stage.
ENV NODE_ENV=

WORKDIR /repo

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json ./apps/web/
COPY packages/shared/package.json ./packages/shared/

RUN pnpm install --frozen-lockfile --filter @showly/web...

COPY packages/shared ./packages/shared
COPY apps/web ./apps/web

WORKDIR /repo/apps/web

# `NEXT_PUBLIC_*` vars entran en el build de Next.js (client-side). Se
# resuelven en build-time. Pasarlas como `--build-arg` desde el compose.
# Fail-fast si falta: sin la URL el frontend hace fetch a undefined/... y
# queda roto en runtime sin señal clara. Mejor romper el build.
ARG NEXT_PUBLIC_API_URL
RUN test -n "$NEXT_PUBLIC_API_URL" || (echo "NEXT_PUBLIC_API_URL requerido en build (pasar --build-arg NEXT_PUBLIC_API_URL=https://api.tudominio.com)" && exit 1)
ENV NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL}

# Sentry client-side + upload de source maps (F2.1.T2).
#
# `NEXT_PUBLIC_SENTRY_*` deben ser ENV en el stage build para que Next.js las
# embeba en el bundle del cliente. Sin esto, aunque el compose las mande en
# `args:`, no llegan al bundle → Sentry queda deshabilitado en el navegador.
#
# `SENTRY_ORG`, `SENTRY_PROJECT` y `SENTRY_AUTH_TOKEN` los consume el plugin
# webpack de `@sentry/nextjs` durante `pnpm build` para subir los source maps
# a Sentry. Los seteamos como ENV en el stage build; NO se propagan al runtime
# image porque el stage runtime es un `FROM` fresh que no hereda envs del build.
ARG SENTRY_ORG
ARG SENTRY_PROJECT
ARG SENTRY_AUTH_TOKEN
ARG NEXT_PUBLIC_SENTRY_DSN
ARG NEXT_PUBLIC_SENTRY_ENABLED
ARG NEXT_PUBLIC_SENTRY_ENVIRONMENT
ARG NEXT_PUBLIC_SENTRY_RELEASE
ARG NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE
ARG SENTRY_TUNNEL_ROUTE
ENV SENTRY_ORG=${SENTRY_ORG}
ENV SENTRY_PROJECT=${SENTRY_PROJECT}
ENV SENTRY_AUTH_TOKEN=${SENTRY_AUTH_TOKEN}
ENV NEXT_PUBLIC_SENTRY_DSN=${NEXT_PUBLIC_SENTRY_DSN}
ENV NEXT_PUBLIC_SENTRY_ENABLED=${NEXT_PUBLIC_SENTRY_ENABLED}
ENV NEXT_PUBLIC_SENTRY_ENVIRONMENT=${NEXT_PUBLIC_SENTRY_ENVIRONMENT}
ENV NEXT_PUBLIC_SENTRY_RELEASE=${NEXT_PUBLIC_SENTRY_RELEASE}
ENV NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE=${NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE}
ENV SENTRY_TUNNEL_ROUTE=${SENTRY_TUNNEL_ROUTE}

RUN pnpm build

# ─────────────────────────── Stage 2: runtime ───────────────────────────
FROM node:20-alpine AS runtime

RUN apk add --no-cache tini

RUN addgroup -S app && adduser -S app -G app

WORKDIR /repo

# Next.js con output default (no standalone) → necesita node_modules.
# Si se activara `output: 'standalone'` en next.config.mjs, se podría
# copiar sólo `.next/standalone` + `.next/static` + `public` y evitar
# pnpm install en runtime. Post-piloto.
#
# `--frozen-lockfile` en el install debajo garantiza builds reproducibles.
# Copiamos el manifest+lockfile del workspace + los del web para que
# `pnpm install --filter @showly/web...` resuelva bien.
COPY --from=build /repo/package.json ./package.json
COPY --from=build /repo/pnpm-lock.yaml ./pnpm-lock.yaml
COPY --from=build /repo/pnpm-workspace.yaml ./pnpm-workspace.yaml
COPY --from=build /repo/apps/web/package.json ./apps/web/package.json
COPY --from=build /repo/apps/web/next.config.mjs ./apps/web/next.config.mjs
COPY --from=build /repo/apps/web/.next ./apps/web/.next
COPY --from=build /repo/apps/web/messages ./apps/web/messages
# `public/` existe siempre (con .gitkeep como mínimo) — COPY incondicional,
# sin `2>/dev/null || true` que es sintaxis inválida en Dockerfile.
COPY --from=build /repo/apps/web/public ./apps/web/public
COPY --from=build /repo/packages/shared/package.json ./packages/shared/package.json

RUN corepack enable && corepack prepare pnpm@9.0.0 --activate && \
    pnpm install --prod --frozen-lockfile --ignore-scripts --filter @showly/web... && \
    chown -R app:app /repo

USER app

WORKDIR /repo/apps/web

EXPOSE 3002

ENV PORT=3002
ENV NODE_ENV=production

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["pnpm", "start"]
