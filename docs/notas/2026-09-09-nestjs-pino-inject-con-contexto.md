# 2026-09-09 — nestjs-pino: `@InjectPinoLogger(Nombre)` rompe el bootstrap en prod

**Síntoma**: el backend arranca en dev y pasa los tests, pero en el contenedor de
producción muere en bootstrap con:

```
Nest can't resolve dependencies of the HealthController (PrismaService, Symbol(REDIS_CLIENT), ?).
Please make sure that the argument "PinoLogger:HealthController" at index [2] is available
```

**Causa**: `@InjectPinoLogger('Contexto')` pide el provider `PinoLogger:Contexto`.
nestjs-pino lo crea en `LoggerModule.forRoot()` recorriendo las clases ya decoradas en
ese momento. En `app.module.ts` el `LoggerModule` global se importa antes que
`HealthModule`, así que cuando `forRoot` corre la clase todavía no existe y el provider
nunca se registra. Los tests no lo ven porque instancian el controller con `new`.

**Regla del repo**: inyectar siempre sin contexto y fijarlo en el constructor, como ya
hacían `AuthController` y `AppointmentsController`:

```ts
constructor(@InjectPinoLogger() private readonly logger: PinoLogger) {
  this.logger.setContext(HealthController.name);
}
```

En los specs el mock del logger necesita `setContext: jest.fn()`.

**Deuda sugerida**: un test que levante `AppModule` con `Test.createTestingModule`
(mockeando Prisma/Redis) habría atrapado esto antes del deploy. Ver [[bitacora]]
(2026-09-09) y [[deploy-coolify]].
