import { Module } from '@nestjs/common';
import { KnowledgeModule } from '../knowledge/knowledge.module';
import { FaqController } from './faq.controller';

/**
 * FaqModule — CRUD de FaqChunk con re-embed automático vía KnowledgeModule.
 * Sin OPENAI_API_KEY, degrada silenciosamente: guarda el content sin embedding
 * y responde con warning header (ver FaqController para el detalle).
 */
@Module({
  imports: [KnowledgeModule],
  controllers: [FaqController],
})
export class FaqModule {}
