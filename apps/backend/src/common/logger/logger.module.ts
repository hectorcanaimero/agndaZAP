import { Global, Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { LoggerModule as PinoModule } from 'nestjs-pino';
import { pinoConfig } from './logger.config';
import { RequestContextService } from './request-context';
import { RequestContextInterceptor } from './request-context.interceptor';

// Módulo global de logging + request context. Un solo lugar donde se
// instancia Pino y donde se registra el interceptor de contexto.
//
// Al importarse en AppModule (root) como @Global, todos los otros módulos
// tienen `PinoLogger` inyectable via `@InjectPinoLogger()` sin necesidad
// de importar este módulo explícitamente. `RequestContextService` también
// queda inyectable globalmente para services que necesiten leer el context.
//
// `pinoConfig()` es una factory — se evalúa en tiempo de forRoot, así lee
// las envs frescas (importante en Docker donde envs se inyectan post-build).
@Global()
@Module({
  imports: [PinoModule.forRoot(pinoConfig())],
  providers: [
    RequestContextService,
    { provide: APP_INTERCEPTOR, useClass: RequestContextInterceptor },
  ],
  exports: [PinoModule, RequestContextService],
})
export class LoggerModule {}
