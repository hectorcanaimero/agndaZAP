---
date: 2026-09-13
tags: [nestjs, modulos, gotcha]
---

# Ciclo de módulos PublicModule ↔ WhatsappModule: tests verdes, app que no arranca

**Síntoma**: al añadir `WhatsappModule` a los imports de `PublicModule` (con `forwardRef` en los
dos lados, como ya se hacía con `BotModule`), `tsc` y los 1519 tests pasaban, pero la app no
arrancaba:

```
Nest cannot create the BotModule instance.
The module at index [5] of the BotModule "imports" array is undefined.
Scope [AppModule -> WhatsappModule]
```

**Causa**: `PublicModule` lo importan muchos módulos (bot, auth, leads, health, invitations,
whatsapp) solo para reusar `REDIS_CLIENT`. Con `public.module.ts → whatsapp.module.ts →
bot.module.ts → public.module.ts`, el `import` de TypeScript de `bot.module.ts` se evalúa cuando
`public.module.ts` aún no terminó de cargar, y `PublicModule` vale `undefined` en el array de
`BotModule`. `forwardRef` en los módulos que tú tocas no arregla un tercero que importa sin él.

**Arreglo**: sacar lo que hacía falta (`WahaService`, sin estado) a un módulo hoja sin imports,
`WahaClientModule`, que `WhatsappModule` importa y re-exporta. `PublicModule` importa la hoja.

**Lección**: los tests unitarios construyen las clases a mano y nunca ven el grafo de módulos.
Cualquier cambio en un `*.module.ts` se verifica levantando el contexto:

```js
const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
app.get(PatientWhatsappNotifier, { strict: false });
await app.close();
```

(con `node --env-file=.env` sobre `dist/`; no escucha HTTP ni arranca workers). El job `e2e` de CI
también lo detectaría, pero tarde.

Ver [[adr/0024-bot-link-first]].
