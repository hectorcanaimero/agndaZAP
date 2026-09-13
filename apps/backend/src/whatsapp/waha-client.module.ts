import { Module } from '@nestjs/common';
import { WahaService } from './waha.service';

/**
 * Solo el cliente HTTP de WAHA, sin controllers ni colas.
 *
 * Existe para que un módulo pueda mandar un WhatsApp sin importar
 * `WhatsappModule`, que arrastra el webhook, el bot y `PublicModule`: desde
 * `PublicModule` (aviso al paciente, ADR 0023) ese import cerraba un ciclo de
 * archivos y `BotModule` arrancaba con un import `undefined`.
 *
 * `WahaService` no tiene estado más allá del env, así que un único provider
 * aquí, re-exportado por `WhatsappModule`, sirve a todos.
 */
@Module({
  providers: [WahaService],
  exports: [WahaService],
})
export class WahaClientModule {}
