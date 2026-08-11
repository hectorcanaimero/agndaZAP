import { Module } from '@nestjs/common';
import { PublicModule } from '../public/public.module';
import { LeadsController } from './leads.controller';
import { LeadsService } from './leads.service';

/**
 * LeadsModule — captura de prospects desde la landing pública.
 *
 * Importa `PublicModule` para reusar el `REDIS_CLIENT` que necesita
 * `RateLimit(N, 'leads')`. No duplicamos la conexión Redis: es la misma
 * instancia singleton que ya usan los endpoints de agendamiento.
 */
@Module({
  imports: [PublicModule],
  controllers: [LeadsController],
  providers: [LeadsService],
})
export class LeadsModule {}
