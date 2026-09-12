import { Module } from '@nestjs/common';
import { SttService } from './stt.service';

/**
 * Transcripción de notas de voz (M10). Sin dependencias: habla con WAHA y con
 * OpenAI por `fetch`, y no toca la base — el audio no se persiste.
 */
@Module({
  providers: [SttService],
  exports: [SttService],
})
export class SttModule {}
