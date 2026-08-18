import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { PublicModule } from '../public/public.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { JwtStrategy } from './strategies/jwt.strategy';

/**
 * AuthModule — Bloque 5.
 *
 * Wiring:
 * - `JwtModule.register`: secret desde env (con fallback dev). Firma con HS256
 *   por default de @nestjs/jwt — nos alcanza para MVP single-signer. Si un día
 *   queremos rotación / múltiples signers, migramos a RS256 con JWKS.
 * - `PassportModule`: adaptador estándar de Nest para estrategias passport.
 * - `APP_GUARD`: registra `JwtAuthGuard` GLOBAL — deny-by-default. Cada ruta
 *   pública debe marcarse con `@Public()` explícito.
 *
 * Importa `PublicModule` sólo para reusar `REDIS_CLIENT` (que consume el
 * `RateLimit(10)` del `POST /auth/login`). NO expone nada más de public.
 */
@Module({
  imports: [
    PublicModule,
    PassportModule,
    JwtModule.register({
      // Fallback sólo para dev; en prod, `main.ts` fail-fast'ea si falta JWT_SECRET.
      secret: process.env.JWT_SECRET ?? 'dev-jwt-secret',
      // `algorithm: 'HS256'` es EXPLÍCITO — pinnearlo en verify (JwtStrategy)
      // y en sign es la única forma de garantizar que no derrapamos por
      // default de la lib. Cambiar acá y en JwtStrategy.algorithms si migramos.
      signOptions: { expiresIn: '24h', algorithm: 'HS256' },
    }),
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    JwtStrategy,
    { provide: APP_GUARD, useClass: JwtAuthGuard },
  ],
  // Exportamos `JwtModule` para que `AdminModule` (impersonation, ADR 0014)
  // pueda inyectar `JwtService` sin duplicar la configuración del secret /
  // algoritmo. Un único signer = un único punto donde rotar credenciales.
  exports: [AuthService, JwtModule],
})
export class AuthModule {}
