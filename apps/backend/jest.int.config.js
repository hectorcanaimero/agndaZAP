/**
 * Tests de integración contra un Redis REAL.
 *
 * Existen porque los mocks de Redis se desvían de Redis. En este repo ya pasó:
 * un mock de `del` que solo borraba claves de tipo string dejó pasar un test
 * del índice de tokens, cuando el `DEL` real borra la clave sea del tipo que
 * sea. El mock confirmaba lo que el autor creía en vez de lo que Redis hace.
 *
 * Lo que se prueba aquí es exactamente lo que un mock no puede garantizar:
 * atomicidad de `SET NX`, semántica de expiración, tipos de clave, y el
 * comportamiento de BullMQ al deduplicar por `jobId`.
 *
 * Corren en su propio job de CI con un servicio Redis; `pnpm test` no los toca.
 *
 * @type {import('jest').Config}
 */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: 'src',
  testRegex: '.*\\.int-spec\\.ts$',
  transform: {
    '^.+\\.(t|j)s$': ['ts-jest', { tsconfig: '<rootDir>/../tsconfig.json' }],
  },
  moduleFileExtensions: ['js', 'json', 'ts'],
  // Redis real y colas: en serie, para que un test no vea las claves de otro.
  maxWorkers: 1,
  testTimeout: 30_000,
};
