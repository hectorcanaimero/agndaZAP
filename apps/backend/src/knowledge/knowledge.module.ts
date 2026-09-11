import { Module } from '@nestjs/common';
import { ClinicFactsService } from './clinic-facts.service';
import { KnowledgeService } from './knowledge.service';

/**
 * KnowledgeModule — RAG FAQ (embeddings + pgvector + LLM synthesis) + hechos
 * de BD (`ClinicFactsService`, ver ADR 0019).
 *
 * Depende de `PrismaService` (global, no requiere import) y de `REDIS_CLIENT`
 * (provisto por `RedisModule`, también global). Exporta `KnowledgeService`
 * para que `FaqModule` (ingest/update) y `BotModule` (answer) lo consuman.
 * `ClinicFactsService` no se exporta: sólo lo usa `KnowledgeService` acá adentro.
 *
 * No importa `WhatsappModule` — el bot es quien envía las respuestas por
 * WAHA. `KnowledgeService` sólo produce texto.
 */
@Module({
  providers: [ClinicFactsService, KnowledgeService],
  exports: [KnowledgeService],
})
export class KnowledgeModule {}
