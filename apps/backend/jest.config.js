/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: 'src',
  // Solo unitarios. Los de integración se llaman `*.int-spec.ts` —con guion,
  // no con punto— precisamente para que este patrón NO los capture: necesitan
  // un Redis real y corren en su propio job de CI (`jest.int.config.js`).
  // Si alguien los renombrara a `*.int.spec.ts` entrarían aquí y el job
  // `backend` empezaría a fallar sin Redis.
  testRegex: '.*\\.spec\\.ts$',
  transform: {
    '^.+\\.(t|j)s$': ['ts-jest', { tsconfig: '<rootDir>/../tsconfig.json' }],
  },
  moduleFileExtensions: ['js', 'json', 'ts'],
};
