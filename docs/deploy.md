# Deploy — Producción (Hetzner + Docker Compose + Caddy)

Guía mínima para deploy productivo del piloto. Objetivo: **una clínica
real** operando 24/7 con costos bajos, TLS gratis y observabilidad
básica.

> Alternativas descartadas para el piloto: Kubernetes (over-engineering
> con 1 clínica), managed cloud (Vercel + Supabase — mayor costo y menos
> control), plataformas WhatsApp-as-a-Service (dependencia y lock-in).

---

## 1. Requisitos del servidor

**Mínimo recomendado**:

- **CPU**: 2 vCPU (x86_64).
- **RAM**: 4 GB (WAHA usa Chromium, ~1-1.5 GB idle; el resto para
  postgres + redis + backend + web + swap).
- **Disco**: 20 GB SSD (postgres data + WAHA session + Docker images).
- **Sistema**: Ubuntu 22.04 LTS o Debian 12 (probado). Alpine también
  funciona pero requiere ajustes de bash.
- **Red**: IP pública, puertos 22 (SSH), 80 (HTTP → redirect), 443
  (HTTPS) abiertos.

**Proveedores razonables** ($6-15/mes):

- **Hetzner Cloud** — CX22 (2 vCPU, 4 GB, 40 GB, €4.51/mes). Recomendado.
- **DigitalOcean** — Basic droplet 4 GB ($24/mes).
- **Linode/Akamai** — Nanode 4 GB ($24/mes).
- **OVH** — Value Instance ($9/mes con throttling).

> Para escalar a >5 clínicas simultáneas, evaluar 8 GB RAM + Postgres
> managed aparte (Supabase, Neon, Aiven).

---

## 2. Setup inicial del servidor

```bash
# 1. Crear usuario no-root (si no existe)
adduser agendazap
usermod -aG sudo agendazap
mkdir -p /home/agendazap/.ssh && \
  cp ~/.ssh/authorized_keys /home/agendazap/.ssh/ && \
  chown -R agendazap:agendazap /home/agendazap/.ssh && \
  chmod 700 /home/agendazap/.ssh

# 2. Docker + Docker Compose
curl -fsSL https://get.docker.com | sh
usermod -aG docker agendazap

# 3. UFW (firewall)
apt-get install -y ufw
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw enable

# 4. Fail2ban (protección SSH básica)
apt-get install -y fail2ban
systemctl enable --now fail2ban

# 5. Deshabilitar login root + password (SSH keys only)
sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin no/' /etc/ssh/sshd_config
sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
systemctl restart sshd

# 6. Crear estructura de datos
mkdir -p /srv/agendazap/data/{db,redis,waha,caddy/data,caddy/config}
chown -R agendazap:agendazap /srv/agendazap
```

Login como `agendazap`, y todo lo que sigue corre en su home.

---

## 3. Clonar y configurar

```bash
cd ~
git clone <repo-url> agendazap
cd agendazap

# Crear .env.production (NUNCA commiteado)
cp .env.example .env.production
# Editar con secrets reales (ver §5)
nano .env.production
```

---

## 4. `docker-compose.prod.yml`

Ya está en la raíz del repo. Diferencias clave vs `docker-compose.yml` (dev):

- **Sin `platform: linux/amd64`**: server x86_64 nativo. Zero emulación.
- **db + redis + waha + backend + web NO exponen puertos al host**: sólo
  accesibles en la red interna del compose. Caddy es la única puerta.
- **Volúmenes en paths absolutos**: `/srv/agendazap/data/*` para
  backups fáciles.
- **`restart: unless-stopped`** en todos los servicios.
- **Backend + web** con Dockerfiles multi-stage (context = raíz).
- **Caddy** como reverse proxy → TLS Let's Encrypt automático.

---

## 5. Env vars de producción (`.env.production`)

Copiar `.env.example` como punto de partida. Estos son los **críticos**
que hay que cambiar:

```bash
# ── Postgres ────────────────────────────────────────────
POSTGRES_USER=agendazap
POSTGRES_PASSWORD=$(openssl rand -base64 32)  # NO usar el default de dev
POSTGRES_DB=agendazap

# ── JWT ────────────────────────────────────────────────
# ≥32 chars, NO puede empezar con 'dev-'. El backend fail-fast si es débil.
JWT_SECRET=$(openssl rand -base64 48)

# ── WAHA ───────────────────────────────────────────────
WAHA_API_KEY=$(openssl rand -hex 24)
WEBHOOK_TOKEN=$(openssl rand -hex 32)
WAHA_DASHBOARD_USERNAME=admin
WAHA_DASHBOARD_PASSWORD=$(openssl rand -base64 24)
WHATSAPP_SWAGGER_USERNAME=admin
WHATSAPP_SWAGGER_PASSWORD=$(openssl rand -base64 24)
# **IMPORTANTE**: WAHA_DASHBOARD_PASSWORD y WHATSAPP_SWAGGER_PASSWORD DEBEN
# ser DISTINTOS. Si comprometen uno (ej: filtración del dashboard vía
# vulnerabilidad en Chromium), el otro (swagger — control total del API de WAHA)
# sigue seguro. Generá CADA uno con su propio `openssl rand -base64 24`.

# ── LLM ────────────────────────────────────────────────
DEEPSEEK_API_KEY=sk-...                # de platform.deepseek.com
GEMINI_API_KEY=...                      # de aistudio.google.com
OPENAI_API_KEY=sk-...                   # (opcional) para embeddings FAQ

# ── Proxy y CORS ───────────────────────────────────────
TRUST_PROXY=true                        # SIEMPRE true detrás de Caddy
CORS_ORIGINS=https://panel.tudominio.com,https://agenda.tudominio.com

# ── Web build-time ─────────────────────────────────────
NEXT_PUBLIC_API_URL=https://api.tudominio.com
```

**Reglas duras**:

- `openssl rand` para todos los secrets. Nunca strings adivinables.
- `.env.production` va en `/home/agendazap/agendazap/`, chmod 600.
- **Rotación**: cada 6 meses mínimo, o inmediato si sospechás filtración.
- **Rotar `JWT_SECRET` invalida todos los tokens en vuelo** — coordinar
  con la clínica antes (todos los operadores del panel tendrán que
  re-login).

---

## 6. `Caddyfile`

Crear `~/agendazap/Caddyfile` (Caddy lo lee via mount del compose):

```caddy
# api.tudominio.com — backend NestJS
api.tudominio.com {
    reverse_proxy backend:4000
    encode gzip
    header {
        Strict-Transport-Security "max-age=31536000; includeSubDomains"
        X-Content-Type-Options "nosniff"
        Referrer-Policy "no-referrer"
    }
    log {
        output file /data/access-api.log {
            roll_size 10mb
            roll_keep 5
        }
    }
}

# panel.tudominio.com — Next.js (panel + página pública)
panel.tudominio.com {
    reverse_proxy web:3002
    encode gzip
    header {
        Strict-Transport-Security "max-age=31536000; includeSubDomains"
        X-Content-Type-Options "nosniff"
        Referrer-Policy "strict-origin-when-cross-origin"
        Permissions-Policy "geolocation=(), camera=(), microphone=()"
        X-Frame-Options "DENY"
    }
    log {
        output file /data/access-panel.log {
            roll_size 10mb
            roll_keep 5
        }
    }
}

# waha.tudominio.com — dashboard WAHA (para escanear QRs y monitor)
# DOS capas: IP allowlist (remote_ip) + basicauth. Comprometido uno, el otro
# sigue firme. Generar el hash con: `docker run --rm caddy:2-alpine caddy hash-password`.
waha.tudominio.com {
    @office remote_ip <REEMPLAZAR_CON_IP_OFICINA>/32   # IP de la oficina o VPN (formato CIDR)
    handle @office {
        basicauth /* {
            <USUARIO> <HASH_CADDY_HASH_PASSWORD>
        }
        reverse_proxy waha:3000
    }
    handle {
        respond "forbidden" 403
    }
}
```

Ajustar `tudominio.com`, `<REEMPLAZAR_CON_IP_OFICINA>` (con la IP pública de
tu oficina o VPN — formato CIDR `/32` para una sola IP), `<USUARIO>` y
`<HASH_CADDY_HASH_PASSWORD>` (generado con `caddy hash-password`, ej:
`echo 'mi-password-fuerte' | docker run --rm -i caddy:2-alpine caddy hash-password`).

Caddy pide certificados Let's Encrypt automáticamente en el primer
request HTTPS.

---

## 7. DNS

Configurar A records apuntando a la IP del servidor:

```
A    api.tudominio.com     → <IP>
A    panel.tudominio.com   → <IP>
A    waha.tudominio.com    → <IP>
```

Esperar propagación (5-30 min). Verificar con `dig +short api.tudominio.com`.

---

## 8. Primer deploy

```bash
cd ~/agendazap

# Build + start (primera vez)
docker compose -f docker-compose.prod.yml --env-file .env.production up -d --build

# Verificar
docker compose -f docker-compose.prod.yml ps

# Migrations (se corren automáticamente en el entrypoint del backend, pero
# se puede forzar manual):
docker compose -f docker-compose.prod.yml exec backend \
  pnpm exec prisma migrate deploy

# Seed inicial (SOLO si querés la clínica demo — probablemente NO en prod).
# Alternativa: crear la clínica real via Prisma Studio (ver onboarding-clinica.md §2).
# NOTA: el seed hace fail-fast si NODE_ENV=production.
```

Verificar:

```bash
curl -s https://api.tudominio.com/api/dashboard/metrics -o /dev/null -w "%{http_code}"  # 401 ok
curl -s https://panel.tudominio.com/es/login -o /dev/null -w "%{http_code}"             # 200 ok
```

---

## 9. Crear la primera clínica

Ver [`onboarding-clinica.md`](./onboarding-clinica.md) — el flujo completo
paso a paso. Resumen:

```bash
docker compose -f docker-compose.prod.yml exec backend \
  pnpm exec prisma studio
# Abre :5555 → crear Clinic + User CLINIC_ADMIN (con password bcrypt-hasheado).
```

Después escanear el QR de WAHA desde `https://waha.tudominio.com/dashboard`.

---

## 10. Backups

**pg_dump diario CIFRADO con GPG** — cron simple en el host. Los dumps contienen
PHI (dados de saúde) — un tarball plaintext en `/srv/agendazap/backups` es un
vector obvio. La clave PRIVADA vive FUERA del server (offsite: laptop del
operador + cofre físico); solo la pública se importa acá para poder cifrar.

**Setup una vez (en tu laptop, NO en el server)**:

```bash
# Generar clave dedicada para backups (contraseña fuerte, key expira 5 años).
gpg --full-generate-key
# Elegir: (1) RSA and RSA, 4096, expires 5y, name="AgendaZap Backups",
# email=backup@agendazap.dev, passphrase fuerte.

# Exportar la clave PÚBLICA (safe para copiar al server) y la PRIVADA (offsite).
gpg --export --armor backup@agendazap.dev > agendazap-backup-pub.asc
gpg --export-secret-keys --armor backup@agendazap.dev > agendazap-backup-priv.asc

# La privada va: cofre físico + password manager. NUNCA al server prod.
# La pública se copia al server (paso siguiente).
```

**Setup en el server (una vez)**:

```bash
# Copiar la clave pública al server e importarla como user agendazap.
scp agendazap-backup-pub.asc agendazap@server:~/
ssh agendazap@server 'gpg --import ~/agendazap-backup-pub.asc && rm ~/agendazap-backup-pub.asc'

# Marcar la clave como "trusted" (sin esto, gpg pregunta interactivamente).
ssh agendazap@server "echo -e '5\ny\n' | gpg --command-fd 0 --edit-key backup@agendazap.dev trust"
```

**Script de backup**:

```bash
# ~/agendazap/scripts/backup.sh
#!/bin/bash
set -euo pipefail
STAMP=$(date +%Y%m%d_%H%M%S)
mkdir -p /srv/agendazap/backups
docker compose -f ~/agendazap/docker-compose.prod.yml exec -T db \
  pg_dump -U agendazap agendazap \
  | gzip \
  | gpg --encrypt --trust-model always --recipient backup@agendazap.dev \
  > /srv/agendazap/backups/agendazap-$STAMP.sql.gz.gpg
# Retención: 7 días locales
find /srv/agendazap/backups -name 'agendazap-*.sql.gz.gpg' -mtime +7 -delete
# TODO: subir a S3/B2 (rclone) para backups off-site.
# rclone copy /srv/agendazap/backups/agendazap-$STAMP.sql.gz.gpg remote:agendazap-backups/
```

```bash
chmod +x ~/agendazap/scripts/backup.sh
# Crontab (agendazap user)
crontab -e
# Agregar:
# 30 3 * * * /home/agendazap/agendazap/scripts/backup.sh >> /srv/agendazap/backups/backup.log 2>&1
```

**Off-site backups** (recomendado post-piloto): rclone → Backblaze B2 (~$5/TB)
o AWS S3 IA (~$12/TB). Los archivos `.gpg` ya vienen cifrados end-to-end → subirlos
a un bucket público es seguro (aunque nunca es buena idea).

**Restore** (requiere clave privada — importar temporalmente en el server o
descargar el backup a otro entorno con la privada):

```bash
# Restaurar el backup más reciente (asumiendo la clave privada está importada).
LAST=$(ls -t /srv/agendazap/backups/*.sql.gz.gpg | head -1)
gpg --decrypt "$LAST" | gunzip | \
  docker compose -f ~/agendazap/docker-compose.prod.yml exec -T db \
    psql -U agendazap agendazap
```

**Deuda**: verificación automática del restore (mensual: descargar backup a
staging, restaurar en DB efímera, correr una query de smoke). Post-piloto.

**Bonus — verificar que el build de Docker no filtra `.env`**:

Sanity check antes de un release grande: `.dockerignore` debería excluir
`.env*`, pero un COPY torpe puede colarlo igual. Verificarlo así:

```bash
# Verificar que el Docker build no filtra .env dentro de la imagen.
docker build -f apps/backend/Dockerfile -t agendazap-test .
docker run --rm agendazap-test find / -name .env 2>/dev/null | head -5 || echo "OK"
# Salida esperada: sólo "OK" (o nada). Si aparece cualquier ruta con .env → alarma.
```

Idem para `web`. Este check es manual por ahora; automatizarlo en CI post-piloto.

---

## 11. Monitoring

**Base (piloto)**:

- **`GET /api/health`** — endpoint público (sin auth) que responde 200
  con `{ ok, db, redis, timestamp }`. Chequea Postgres (`SELECT 1`) y
  Redis (`PING`). Responde 200 con `ok: false` cuando hay problemas —
  el orquestador decide qué es "unhealthy". Consumido por:
  - Docker healthcheck (agregar a `docker-compose.prod.yml` — cuando se
    documente el override).
  - Uptime Robot / BetterUptime externo: pegar cada 5 min a
    `https://api.tudominio.com/api/health`, alertar si `ok !== true`.
- `docker compose logs -f backend web` — tail de logs. Sin agregador
  externo por ahora.
- `docker stats` — CPU/RAM en tiempo real.
- `df -h /srv/agendazap/data` — chequeo de disco semanal (WAHA acumula
  logs, PG acumula WAL).

**Post-piloto (recomendado)**:

- **Grafana + Prometheus** vía `dockprom` o `swarmpit`. Métricas de
  container + host.
- **Loki** para agregación de logs.
- **Uptime robot** externo pegándole a `https://api.tudominio.com/api/dashboard/metrics`
  (esperando 401) cada 5 min → alerta email/SMS si cae.
- **Sentry** para errores del backend (agregar `@sentry/node` en el
  bootstrap).
- **Alertas WAHA**: cuando la sesión se caiga, notificar por Slack.
  Requiere un webhook custom (post-piloto).

---

## 12. Runbook de emergencia

### 12.1. Reiniciar todo

```bash
cd ~/agendazap
docker compose -f docker-compose.prod.yml --env-file .env.production restart
```

### 12.2. Reiniciar solo un servicio

```bash
docker compose -f docker-compose.prod.yml --env-file .env.production restart backend
```

### 12.3. Ver logs recientes

```bash
docker compose -f docker-compose.prod.yml logs --tail=200 -f backend
docker compose -f docker-compose.prod.yml logs --tail=200 -f waha
```

### 12.4. Restaurar DB desde backup

Ver §10 (Restore).

**IMPORTANTE**: bajar el backend antes de restaurar para evitar writes
concurrentes:

```bash
docker compose -f docker-compose.prod.yml stop backend web
# restaurar...
docker compose -f docker-compose.prod.yml start backend web
```

### 12.5. Rotar `JWT_SECRET`

```bash
# 1. Generar nuevo secret
NEW_SECRET=$(openssl rand -base64 48)

# 2. Anunciar a la clínica que van a tener que re-login (2 min de aviso).

# 3. Editar .env.production con el nuevo valor.

# 4. Restart backend.
docker compose -f docker-compose.prod.yml --env-file .env.production up -d backend

# Todos los tokens JWT existentes quedan inválidos. Los users tienen que
# re-login. El panel redirige automáticamente a /login?next=...
```

### 12.6. Rotar `POSTGRES_PASSWORD`

**Cuidado**: si cambiás sólo la env sin actualizar el DB, el backend no
puede conectar. Pasos:

```bash
# 1. Cambiar password EN LA DB primero:
docker compose -f docker-compose.prod.yml exec db \
  psql -U agendazap -c "ALTER USER agendazap PASSWORD 'NUEVO_PASSWORD_STRONG';"

# 2. Actualizar .env.production con el nuevo POSTGRES_PASSWORD.

# 3. Restart backend (el nuevo DATABASE_URL usa el nuevo password):
docker compose -f docker-compose.prod.yml --env-file .env.production up -d backend
```

### 12.7. Rebuild después de actualizar código

```bash
cd ~/agendazap
git pull origin main
docker compose -f docker-compose.prod.yml --env-file .env.production up -d --build backend web
# Prisma migrate deploy corre en el entrypoint del backend automáticamente.
```

### 12.8. WAHA no responde

```bash
# 1. Ver logs
docker compose -f docker-compose.prod.yml logs --tail=100 waha

# 2. Restart
docker compose -f docker-compose.prod.yml restart waha

# 3. Re-escanear QR desde https://waha.tudominio.com/dashboard si perdió sesión
```

---

## 13. Actualización de OS

Ubuntu unattended-upgrades (ya activo por default en 22.04). Reboot
manual mensual:

```bash
sudo apt update && sudo apt upgrade -y
sudo reboot
```

Los containers `restart: unless-stopped` se levantan solos al boot.

---

## 14. Costos estimados

| Item | Costo mensual |
|------|---------------|
| Server Hetzner CX22 | €4.51 (~$5 USD) |
| Dominio (namecheap, año) | $1.20/mes |
| Backup Backblaze B2 (~5 GB) | $0.03/mes |
| DeepSeek (~$0.001/1k tokens, ~$5/mes para 1 clínica) | ~$5 |
| Gemini (fallback, <$1/mes) | ~$1 |
| OpenAI embeddings (~50 FAQs/mes, $0.02/1M tokens) | <$0.01 |
| **Total 1 clínica** | **~$12 USD/mes** |

Escalado a 10 clínicas (mismo server, plan Hetzner CX42 = 8 vCPU/16 GB): ~$30/mes.

---

## 15. Deuda y roadmap deploy

Documentado en [[adr/0004-pii-y-compliance]] y [[adr/0005-auth-mvp-y-deuda]]:

- **Backups off-site automatizados**: rclone → B2 post-piloto.
- **Alerting WAHA disconnect** → Slack.
- ~~**Health check endpoint del backend**~~ ✅ **Listo** — `GET /api/health`
  público responde `{ ok, db, redis, timestamp }`. Ver sección 11.
- **Grafana + Prometheus** para métricas de containers.
- **Sentry** para errores del backend (opcional — hoy los logs
  estructurados de NestJS + `docker logs` cubren MVP).
- **Kubernetes / Nomad** si escalás a >20 clínicas concurrentes.
- **Multi-región** (LATAM + Europa) cuando el churn de latencia se note.

---

## 16. Quality gates — validación pre-merge

Todos los PRs contra `staged` o `main` corren automáticamente el
workflow `.github/workflows/ci.yml`, que valida:

### Backend
- `pnpm exec tsc --noEmit` — TypeScript strict.
- `pnpm test` — Jest full suite.

### Web
- `pnpm exec tsc --noEmit` — TypeScript strict (incluye chequeo
  type-safe de `next-intl` — `IntlMessages` global, ver
  `apps/web/global.d.ts`).
- `node scripts/i18n-check.mjs` — paridad estricta de paths escalares
  `es.json` ↔ `pt.json` + missing keys por consumidor. Cierra el patrón
  de `MISSING_MESSAGE` / `FORMATTING_ERROR` que apareció 3+ veces en
  producción antes de que el chequeo estuviera automatizado.

### Local (mismos comandos que CI)

```bash
pnpm check          # todo (backend + web + i18n)
pnpm check:backend  # solo backend (tsc + tests)
pnpm check:web      # solo web (tsc + i18n)
pnpm i18n:check     # solo i18n (paridad + missing keys)
```

**Regla**: no mergear PRs con CI en rojo. GitHub debería tener
"require status checks to pass" activado en `staged`/`main` (setup
manual en Settings → Branches).

Referencias: [[PRD]], [[ARCHITECTURE]], [[onboarding-clinica]],
[[runbook-panel]].
