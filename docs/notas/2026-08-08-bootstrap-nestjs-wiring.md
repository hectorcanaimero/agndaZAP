---
fecha: 2026-08-08
tags: [backend, nestjs, bullmq, wiring, bootstrap]
---

# Bloque 1 — Wiring NestJS ejecutable

Notas de la primera pasada que dejó el backend arrancable (`node dist/main.js`).

## Decisiones clave

### 1. Ciclo `WhatsappModule ↔ BotModule`
`WebhookController` (en whatsapp) depende de `BotService`; a la vez `BotService`
depende de `WahaService` (en whatsapp). Resuelto con `forwardRef()` en **ambos
lados** al importar el otro módulo. Sin esto Nest lanza "Circular dependency".

### 2. Proveer `Queue` de BullMQ a `RemindersService`
`RemindersService` está tipado como `constructor(prisma, queue: Queue)`. Como en
el proyecto hay **una sola** cola por ahora, el token puede ser la propia clase
`Queue` de bullmq:

```ts
providers: [
  { provide: Queue, useFactory: () => new Queue('reminders', { connection: parseRedis() }) },
  RemindersService,
]
```

Esto evita tocar el `constructor` con `@Inject(TOKEN)`. Si en el futuro
aparecen más colas (`notifications`, `analytics`…) hay que migrar a tokens
distintos (`Symbol('REMINDERS_QUEUE')`) porque proveer dos veces la misma clase
como token rompe.

### 3. Worker BullMQ en el bootstrap (no como provider)
`reminders.processor.ts` exporta la **factoría** `createRemindersWorker`, no una
clase `@Injectable`. En `main.ts` se hace `app.get(PrismaService)` y
`app.get(WahaService)` para inyectar deps al worker, y se comparte Redis con la
Queue usando el mismo helper `parseRedis()`.

Ventaja: el ciclo de vida del worker queda controlado explícitamente
(`worker.close()` en SIGTERM/SIGINT antes de `app.close()`), sin sorpresas del
DI de Nest sobre background jobs.

### 4. Webhook fuera del prefijo `/api`
`WHATSAPP_HOOK_URL` en `docker-compose.yml` apunta a
`http://backend:4000/webhooks/waha` (sin `/api`). Se resuelve con:

```ts
app.setGlobalPrefix('api', {
  exclude: [{ path: 'webhooks/(.*)', method: RequestMethod.ALL }],
});
```

Verificado: `POST /webhooks/waha` → 201 `{"ok":true}`; `POST /api/webhooks/waha` → 404.

## Gotcha: NestJS responde 201 al POST del webhook
Es el default de Nest para `@Post()`. WAHA no le importa; si algún día
queremos 200 (por ejemplo, para proxies estrictos), agregar `@HttpCode(200)`
al método `handleWaha`.

## Archivos creados
- `apps/backend/tsconfig.json`
- `apps/backend/nest-cli.json`
- `apps/backend/src/prisma/prisma.service.ts`
- `apps/backend/src/prisma/prisma.module.ts`
- `apps/backend/src/whatsapp/whatsapp.module.ts`
- `apps/backend/src/scheduling/scheduling.module.ts`
- `apps/backend/src/reminders/reminders.module.ts`
- `apps/backend/src/bot/bot.module.ts`
- `apps/backend/src/app.module.ts`
- `apps/backend/src/main.ts`

Ver también: [[2026-08-08-prisma-pgvector-y-env]]
