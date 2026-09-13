import { Module } from '@nestjs/common';
import { SchedulingModule } from '../scheduling/scheduling.module';
import { WahaClientModule } from '../whatsapp/waha-client.module';
import { PatientWhatsappNotifier } from './patient-whatsapp-notifier.service';
import { PublicController } from './public.controller';
import { PublicSchedulingSessionController } from './scheduling-session.controller';

/**
 * PublicModule — Bloque 3.
 *
 * Expone la superficie pública (sin auth) para el flujo `/agendar/[clinicSlug]`.
 * `REDIS_CLIENT` (usado por `RateLimit(N)`) lo provee `RedisModule` global —
 * no duplicamos la conexión ni tenemos que exportar el token acá.
 *
 * Dos controllers:
 *  - `PublicController`                  → `/public/clinics/*` (agenda web).
 *  - `PublicSchedulingSessionController` → `/public/scheduling/session/:token`
 *    (hidrata form desde link mandado por WA).
 *
 * `WahaClientModule` y no `WhatsappModule`: este importa `PublicModule`, y el
 * ciclo dejaba módulos `undefined` al arrancar. Hace falta para avisar al
 * paciente por WhatsApp cuando agenda, mueve o cancela desde la web (ADR 0024).
 */
@Module({
  imports: [SchedulingModule, WahaClientModule],
  controllers: [PublicController, PublicSchedulingSessionController],
  providers: [PatientWhatsappNotifier],
})
export class PublicModule {}
