# 2026-09-10 — Healthcheck de WAHA: la imagen no trae `wget`

**Síntoma.** `scripts/dev-up.sh` se colgaba para siempre en
`docker compose up -d --wait db redis waha`. El contenedor `showly-waha-1`
quedaba `unhealthy` aunque WAHA arrancaba bien. Dos sesiones de Claude Code
quedaron bloqueadas esperando ese comando.

**Causa.** El healthcheck del servicio `waha` en `docker-compose.yml` usaba
`wget --spider`, pero la imagen `devlikeapro/waha:noweb` no incluye `wget`
(`/bin/sh: 1: wget: not found`, exit 1 en cada intento). `--wait` espera a
`healthy` y nunca llega.

**Fix.** El healthcheck ahora usa `curl -fsS` (sí viene en la imagen):

```yaml
test: ["CMD-SHELL", "curl -fsS -o /dev/null -H \"X-Api-Key: $$WAHA_API_KEY\" http://localhost:3000/health || exit 1"]
```

**Regla.** Antes de escribir un healthcheck para una imagen ajena, comprobar
con `docker exec <c> which curl wget` qué cliente HTTP trae. El healthcheck
comentado del servicio `backend` también usa `wget`; revisar al activarlo.

**Ojo con el puerto 3000.** El compose publica WAHA en `3000:3000`. En este VPS
el puerto 3000 está reservado por convención a `labo-system`; si ambos
conviven habrá conflicto. Ver [[bitacora]].
