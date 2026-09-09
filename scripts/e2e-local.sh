#!/usr/bin/env bash
# Smoke E2E local — página pública de agendamiento (Playwright, chromium).
#
# Levanta db+redis efímeros (docker-compose.e2e.yml, proyecto `showly-e2e`,
# puertos 5433/6380), migra + seedea, arranca el backend compilado en :4102 y
# el web (build + start de Next) en :3102, corre los tests y SIEMPRE limpia
# (trap EXIT): mata backend/web y baja los contenedores.
#
# Uso: scripts/e2e-local.sh [args extra para `playwright test`]
#   E2E_SKIP_BUILD=1  → reutiliza apps/backend/dist y apps/web/.next existentes.
#   E2E_KEEP_INFRA=1  → no baja los contenedores al final (debug).
#
# Ver docs/smoke-e2e.md §Automatizado.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

API_PORT="${E2E_API_PORT:-4102}"
WEB_PORT="${E2E_WEB_PORT:-3102}"
export E2E_API_URL="http://localhost:${API_PORT}"
export E2E_WEB_URL="http://localhost:${WEB_PORT}"
LOG_DIR="${E2E_LOG_DIR:-$ROOT/.e2e-logs}"
mkdir -p "$LOG_DIR"

COMPOSE=(docker compose -f docker-compose.e2e.yml)
BACKEND_PID=""
WEB_PID=""

cleanup() {
  local code=$?
  set +e
  echo "[e2e] limpiando (exit=$code)…"
  for pid in "$WEB_PID" "$BACKEND_PID"; do
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
      # Matar el árbol completo: `pnpm exec` y `devsrv` spawnean hijos.
      pkill -TERM -P "$pid" 2>/dev/null
      kill -TERM "$pid" 2>/dev/null
    fi
  done
  sleep 2
  for pid in "$WEB_PID" "$BACKEND_PID"; do
    [[ -n "$pid" ]] && kill -KILL "$pid" 2>/dev/null
  done
  # Red de seguridad por puerto (systemd-run/devsrv reparenta los hijos).
  for port in "$WEB_PORT" "$API_PORT"; do
    for pid in $(ss -ltnpH "sport = :$port" 2>/dev/null | grep -o 'pid=[0-9]*' | cut -d= -f2 | sort -u); do
      kill -KILL "$pid" 2>/dev/null
    done
  done
  if [[ "${E2E_KEEP_INFRA:-0}" != "1" ]]; then
    "${COMPOSE[@]}" down -v --remove-orphans >/dev/null 2>&1
  fi
  echo "[e2e] logs en $LOG_DIR"
  exit "$code"
}
trap cleanup EXIT INT TERM

wait_http() {
  local url=$1 name=$2 tries=${3:-90}
  for ((i = 1; i <= tries; i++)); do
    if curl -sf -o /dev/null "$url"; then
      echo "[e2e] $name OK ($url)"
      return 0
    fi
    sleep 2
  done
  echo "[e2e] $name no respondió en $((tries * 2))s: $url" >&2
  return 1
}

# ── 1) Infra efímera ────────────────────────────────────────────────────────
echo "[e2e] levantando db+redis (showly-e2e)…"
"${COMPOSE[@]}" up -d --wait db redis

# ── 2) Env mínima del backend (sin WAHA real, sin LLM, sin Sentry/Axiom) ───
export NODE_ENV=test
export DATABASE_URL="postgresql://showly:showly@127.0.0.1:5433/showly"
export REDIS_URL="redis://127.0.0.1:6380"
export PORT="$API_PORT"
export JWT_SECRET="e2e-jwt-secret-de-prueba-con-mas-de-32-caracteres"
export WEBHOOK_TOKEN="e2e-webhook-token"
export WAHA_BASE_URL="http://127.0.0.1:9"   # puerto discard: falla rápido
export WAHA_API_KEY="e2e-waha-key"
export WAHA_HEALTH_INTERVAL_MIN=60
export CORS_ORIGINS="$E2E_WEB_URL"
export ICAL_SECRET="e2e-ical-secret"
export SENTRY_ENABLED=false
export AXIOM_ENABLED=false
export LOG_LEVEL="${LOG_LEVEL:-warn}"
export LOG_PRETTY=false
export BOT_TYPING_ENABLED=false
export APP_BASE_URL="$E2E_WEB_URL"
export WEB_BASE_URL="$E2E_WEB_URL"

# ── 3) Migrate + seed ──────────────────────────────────────────────────────
echo "[e2e] prisma migrate deploy + seed…"
pnpm --filter @showly/backend exec prisma migrate deploy >"$LOG_DIR/migrate.log" 2>&1
pnpm --filter @showly/backend exec prisma db seed >"$LOG_DIR/seed.log" 2>&1

# ── 4) Build backend + web ─────────────────────────────────────────────────
if [[ "${E2E_SKIP_BUILD:-0}" != "1" ]]; then
  echo "[e2e] build backend…"
  pnpm --filter @showly/backend build >"$LOG_DIR/build-backend.log" 2>&1
  echo "[e2e] build web (NEXT_PUBLIC_API_URL=$E2E_API_URL)…"
  NEXT_PUBLIC_API_URL="$E2E_API_URL" NEXT_PUBLIC_SENTRY_ENABLED=false SENTRY_ENABLED=false \
    pnpm --filter @showly/web build >"$LOG_DIR/build-web.log" 2>&1
fi

# ── 5) Arrancar backend + web ──────────────────────────────────────────────
RUNNER=()
if command -v devsrv >/dev/null 2>&1; then RUNNER=(devsrv -m 3G); fi

echo "[e2e] backend en :$API_PORT…"
(cd apps/backend && "${RUNNER[@]}" node dist/main.js >"$LOG_DIR/backend.log" 2>&1) &
BACKEND_PID=$!

echo "[e2e] web en :$WEB_PORT…"
# `pnpm start` del web fija -p 3002; acá pasamos el puerto E2E explícito.
(cd apps/web && NEXT_PUBLIC_API_URL="$E2E_API_URL" "${RUNNER[@]}" \
  pnpm exec next start -p "$WEB_PORT" >"$LOG_DIR/web.log" 2>&1) &
WEB_PID=$!

wait_http "$E2E_API_URL/api/health/live" backend
wait_http "$E2E_WEB_URL/es/agendar/demo" web

# ── 6) Tests ───────────────────────────────────────────────────────────────
echo "[e2e] playwright test…"
pnpm --filter @showly/web e2e "$@"
