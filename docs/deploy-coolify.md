# Deploy en Coolify

Cómo está desplegado Showly en Coolify y cómo operarlo. Complementa [[deploy]] (el
runbook Hetzner + Caddy previo, hoy de referencia) y [[runbook-lanzamiento]].

## Dónde vive

| Cosa | Valor |
|---|---|
| Instancia Coolify | `https://cooly.usebot.chat` (corre en el propio VPS, Traefik en 80/443) |
| Proyecto | `showly` · uuid `afukz8yl66roqyxvisoarasg` · entorno `production` |
| Aplicación | `showly` (docker compose) · uuid `lcl2f6xdfwydeftjkv7c1dad` |
| Fuente | GitHub público `hectorcanaimero/agndaZAP`, rama `main`, `/docker-compose.coolify.yml` |
| Servidor | `localhost` (uuid `5pss6qedkxue1y3wmqmlancz`) |

Dominios actuales (temporales, vía sslip.io, hasta mover el DNS de `showly.us`, que hoy
apunta a otro VPS):

| Service del compose | Dominio |
|---|---|
| `web` | `https://showly.13.140.175.146.sslip.io` |
| `backend` | `https://api-showly.13.140.175.146.sslip.io` |
| `waha` | `https://waha-showly.13.140.175.146.sslip.io` |

Para pasar a `showly.us`: apuntar los tres registros A a la IP del VPS, cambiar
`docker_compose_domains` en la app (API: `PATCH /applications/{uuid}`), actualizar
`CORS_ORIGINS`, `APP_BASE_URL`, `WEB_BASE_URL` y `NEXT_PUBLIC_API_URL` (build-time), y
redesplegar. El marcador `.coolify` del repo apunta a una instancia anterior y hay que
actualizarlo con estos uuids.

## Variables de entorno

Se cargan en Coolify, no en disco. Los secretos generados para este entorno viven fuera
del repo en `~/.config/showly/coolify-prod.env` (chmod 600) del VPS. Al crear la app,
Coolify parsea el compose y crea una entrada vacía por cada `${VAR}`; el bulk se hace con
`PATCH /applications/{uuid}/envs/bulk` y `{"data":[{key,value,is_build_time,is_preview}]}`.

Reglas aprendidas:

- **No usar `is_literal: true` en NINGUNA variable de esta app**: Coolify la escribe
  entrecomillada. Con `NEXT_PUBLIC_API_URL` la comilla se horneó en el bundle y el
  login del panel apuntaba a `/es/'https://api…'/api/auth/login` (2026-09-10).
  Excepción histórica: `POSTGRES_PASSWORD` sigue literal porque la DB se inicializó con
  la contraseña entrecomillada; para limpiarla: `ALTER USER showly PASSWORD '<valor>'`
  en el contenedor `db` y luego pasar la variable a no-literal.
- **Sin `WEBHOOK_HMAC_SECRET` con WAHA community**: esa edición no firma los webhooks; si
  la variable existe el backend exige HMAC y responde 403 a todo (el bot no contesta,
  `wahaConnected` nunca pasa a `true`). Sólo `WEBHOOK_TOKEN` hasta migrar a WAHA Plus
  (ADR 0017).
- **Nunca inyectar eventos `message` sintéticos en producción**: el bot responde por
  WhatsApp real al `from` del evento. Probar el webhook con `session.status` o con el
  número propio.

- **No usar `is_literal: true`** en variables que el compose interpola en healthchecks o
  en `initdb` (`POSTGRES_USER`, `POSTGRES_DB`): Coolify las escribe entrecomilladas en el
  `.env` y Postgres falla con `invalid character in extension owner`.
- `NEXT_PUBLIC_*` son build-time (se hornean en el bundle del web).
- Coolify inyecta **todas** las variables de la app en **todos** los services del compose.
- `SENTRY_DSN` es obligatoria en producción por el fail-fast de `main.ts` aunque
  `SENTRY_ENABLED=false`. Hasta configurar Sentry real hay un placeholder.
- Pendientes de cargar con valores reales: `DEEPSEEK_API_KEY`, `GEMINI_API_KEY`,
  `OPENAI_API_KEY`, `RESEND_API_KEY`, `AXIOM_*`, `SENTRY_*`. Sin las de LLM el bot
  responde con handoff a humano; sin Resend no salen invitaciones.

## Operar por API

El token está en `~/.config/fluent/coolify.env` (`COOLIFY_TOKEN`, contiene `|`, así que
no se puede `source`; leerlo con `grep`/`cut`).

```bash
B=https://cooly.usebot.chat/api/v1; A=lcl2f6xdfwydeftjkv7c1dad
curl -s -H "Authorization: Bearer $T" $B/applications/$A | jq '{status,git_branch,fqdn}'
curl -s -X POST -H "Authorization: Bearer $T" "$B/deploy?uuid=$A&force=false"
curl -s -H "Authorization: Bearer $T" $B/deployments/<deployment_uuid> | jq -r .status
```

El log del deploy viene en `.logs` como JSON serializado: `jq -r '.logs | fromjson | .[].output'`.

## Historial de arranque (2026-09-09)

1. Deploy 1 falló en `pnpm build` del web: `AgendaLive.tsx` sin claves i18n (fix en PR #24).
2. Deploy 2 pasó el build y falló en `db` unhealthy por el gotcha de `is_literal`.
3. Deploy 3 con las variables corregidas.
