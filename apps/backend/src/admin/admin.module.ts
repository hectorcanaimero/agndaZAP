import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { AuthModule } from '../auth/auth.module';
import { InvitationsModule } from '../invitations/invitations.module';
import { AdminAuditController } from './admin-audit.controller';
import { AdminAuditInterceptor } from './admin-audit.interceptor';
import { AdminAuditService } from './admin-audit.service';
import { AdminClinicsController } from './admin-clinics.controller';
import { AdminClinicsService } from './admin-clinics.service';
import { AdminMetricsController } from './admin-metrics.controller';
import { AdminMetricsService } from './admin-metrics.service';
import { ImpersonationController } from './impersonation.controller';
import { ImpersonationService } from './impersonation.service';

/**
 * AdminModule — área SaaS admin (SUPERADMIN). Ver ADR 0014.
 *
 * `PrismaModule` es global (@Global), no hace falta importarlo. `AuthModule`
 * sí — expone `JwtModule`, y `ImpersonationService` inyecta `JwtService`
 * para firmar el token temporal (30 min) con el mismo secret que el login.
 * Reusar el signer garantiza que rotar `JWT_SECRET` invalide TODOS los
 * tokens (login e impersonation) de una vez.
 *
 * `AdminAuditInterceptor` se registra como APP_INTERCEPTOR GLOBAL (ADR 0016)
 * para cubrir TODA mutation ejecutada bajo impersonation, no solo las de
 * `/admin/*`. La lógica interna filtra qué persistir:
 *  - user.impersonatedBy presente + mutation → siempre audita
 *  - decorador @AdminAudit + mutation → audita (backward compat)
 *  - resto → skip
 * Ver `admin-audit.interceptor.ts` para los detalles.
 */
@Module({
  imports: [AuthModule, InvitationsModule],
  controllers: [
    AdminClinicsController,
    AdminMetricsController,
    AdminAuditController,
    ImpersonationController,
  ],
  providers: [
    AdminAuditService,
    AdminAuditInterceptor,
    { provide: APP_INTERCEPTOR, useClass: AdminAuditInterceptor },
    AdminClinicsService,
    AdminMetricsService,
    ImpersonationService,
  ],
  exports: [AdminAuditService, AdminAuditInterceptor],
})
export class AdminModule {}
