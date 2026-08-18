import { Module } from '@nestjs/common';
import { PublicModule } from '../public/public.module';
import { InvitationsController } from './invitations.controller';
import { InvitationsService } from './invitations.service';

/**
 * InvitationsModule — flujo de "invitar admin de clínica" (ver ADR 0014).
 *
 * Depende de `PublicModule` únicamente por `REDIS_CLIENT` (necesario para
 * el guard `RateLimit(N)`). PrismaModule es global.
 *
 * `InvitationsService` se exporta para que `AdminClinicsService` pueda
 * crear invitaciones al crear una clínica (misma transacción lógica).
 */
@Module({
  imports: [PublicModule],
  controllers: [InvitationsController],
  providers: [InvitationsService],
  exports: [InvitationsService],
})
export class InvitationsModule {}
