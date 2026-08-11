import { Module } from '@nestjs/common';
import { PublicModule } from '../public/public.module';
import { AdminLeadsController } from './admin-leads.controller';
import { LeadsController } from './leads.controller';
import { LeadsService } from './leads.service';

/**
 * LeadsModule — captura + gestión de prospects.
 *
 * Dos controllers en el mismo módulo porque comparten `LeadsService`:
 *  - `LeadsController`      → `POST /api/public/leads` (público, rate-limited).
 *  - `AdminLeadsController` → `GET  /api/leads`        (panel, SUPERADMIN).
 *
 * Importa `PublicModule` para reusar el `REDIS_CLIENT` que necesita
 * `RateLimit(N, 'leads')`. No duplicamos la conexión Redis: es la misma
 * instancia singleton que ya usan los endpoints de agendamiento.
 */
@Module({
  imports: [PublicModule],
  controllers: [LeadsController, AdminLeadsController],
  providers: [LeadsService],
})
export class LeadsModule {}
