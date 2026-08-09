import { Module } from '@nestjs/common';
import { KnowledgeService } from './knowledge.service';

/**
 * KnowledgeModule — RAG FAQ (embeddings + pgvector + LLM synthesis).
 *
 * Depende de `PrismaService` (global, no requiere import). Exporta
 * `KnowledgeService` para que `FaqModule` (ingest/update) y `BotModule`
 * (answer) lo consuman.
 *
 * No importa `WhatsappModule` — el bot es quien envía las respuestas por
 * WAHA. `KnowledgeService` sólo produce texto.
 */
@Module({
  providers: [KnowledgeService],
  exports: [KnowledgeService],
})
export class KnowledgeModule {}
