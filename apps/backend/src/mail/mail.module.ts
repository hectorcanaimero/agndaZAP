import { Global, Module } from '@nestjs/common';
import { MailService } from './mail.service';

/**
 * MailModule — provider global de `MailService`.
 *
 * `@Global()` porque el mailing es una utilidad transversal (admin,
 * reminders futuros, feedback, etc). Marcarlo global evita repetir
 * `imports: [MailModule]` en cada módulo consumidor.
 *
 * Nota de config: el service lee `RESEND_API_KEY` / `EMAIL_FROM` desde el
 * entorno en el constructor. No usamos ConfigModule acá porque el service
 * es tolerante a la ausencia de API key (dev-fallback), así que no vale
 * la pena introducir la dependencia.
 */
@Global()
@Module({
  providers: [MailService],
  exports: [MailService],
})
export class MailModule {}
