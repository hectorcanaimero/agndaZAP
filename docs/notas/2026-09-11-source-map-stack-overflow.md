---
titulo: "ts-jest + Math.random mockeado = RangeError opaco en el suite del bot"
fecha: 2026-09-11
tags: [gotcha, tests, jest, bot]
---

# `Maximum call stack size exceeded` al fallar un test de `bot.service.spec.ts`

## Síntoma

Cualquier test que falle dentro de `apps/backend/src/bot/bot.service.spec.ts` hacía
que jest reportara esto, sin decir qué test falló ni por qué:

```
FAIL src/bot/bot.service.spec.ts
  ● Test suite failed to run
    RangeError: Maximum call stack size exceeded
        at [Symbol.hasInstance] (<anonymous>)
      at node_modules/.pnpm/jest-mock@29.7.0/.../index.js:367:22
```

El stack completo son cientos de frames `doQuickSort` de `source-map@0.6.1`.
Con `node --stack-size=4000 .../jest.js` el suite corre y aparecen los fallos reales,
lo que confirma que no era una recursión infinita sino una recursión *profunda*.

## Causa

`source-map@0.6.1` (lo usa ts-jest para mapear el stack trace del error al `.ts`
original) ordena sus mappings con un quicksort que elige el pivote así:

```js
function randomIntInRange(low, high) {
  return Math.round(low + (Math.random() * (high - low)));
}
```

El `beforeEach` del spec hacía `jest.spyOn(Math, 'random').mockReturnValue(0)` para
que `pickVariant` devolviera siempre la primera variante del pool de mensajes. Con
`Math.random()` fijo en 0 el pivote es siempre el extremo inferior: el quicksort
degenera a **recursión lineal** sobre miles de mappings y revienta el stack.

El bug solo se ve cuando algo falla, porque el sort es perezoso: ocurre cuando jest
mapea el stack trace de un error. Con el suite verde nunca se dispara — por eso
apareció recién al agregar tests nuevos que fallaban.

## Fix

No mockear `Math.random` para fijar la variante; espiar directamente el método:

```ts
jest
  .spyOn(BotService.prototype as any, 'pickVariant')
  .mockImplementation((variants: any) => variants[0]);
```

## Regla

**Nunca mockear `Math.random` globalmente en un spec de este repo.** Si un test
necesita determinismo sobre algo que usa `Math.random`, se mockea la función del
dominio (`pickVariant`, etc.), no el primitivo. Aplica a cualquier spec que corra
bajo ts-jest con source maps.

Relacionado: [[notas/2026-09-11-bot-matching-saludo-si-persona]]
