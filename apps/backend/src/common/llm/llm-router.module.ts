import { Global, Module } from '@nestjs/common';
import { LlmRouterService } from './llm-router.service';

/**
 * Global — `LlmRouterService` disponible en toda la app sin re-importar.
 * Es un servicio stateless que sólo hace fetch a APIs externas.
 */
@Global()
@Module({
  providers: [LlmRouterService],
  exports: [LlmRouterService],
})
export class LlmRouterModule {}
