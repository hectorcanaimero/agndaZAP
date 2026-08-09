# AgendaZap web — multi-stage Dockerfile.
#
# Contexto: se buildea DESDE LA RAÍZ del monorepo. Ver
# `docker-compose.prod.yml`:
#   build:
#     context: .
#     dockerfile: apps/web/Dockerfile

# ─────────────────────────── Stage 1: build ───────────────────────────
FROM node:20-alpine AS build

RUN corepack enable && corepack prepare pnpm@9.0.0 --activate

WORKDIR /repo

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json ./apps/web/
COPY packages/shared/package.json ./packages/shared/

RUN pnpm install --frozen-lockfile --filter @agendazap/web...

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
# `pnpm install --filter @agendazap/web...` resuelva bien.
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
    pnpm install --prod --frozen-lockfile --ignore-scripts --filter @agendazap/web... && \
    chown -R app:app /repo

USER app

WORKDIR /repo/apps/web

EXPOSE 3002

ENV PORT=3002
ENV NODE_ENV=production

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["pnpm", "start"]
