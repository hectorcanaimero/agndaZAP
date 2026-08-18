import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { extractIp, MinimalRequest } from '../common/extract-ip';
import { RateLimit } from '../public/rate-limit.guard';
import { AuthMe, AuthService, LoginResult } from './auth.service';
import { CurrentUser, AuthUser } from './decorators/current-user.decorator';
import { Public } from './decorators/public.decorator';
import { LoginDto } from './dto/login.dto';

/**
 * AuthController — superficie HTTP del bloque de autenticación.
 *
 * Rutas:
 * - `POST /api/auth/login` (público, rate-limited)  → `{ accessToken }`
 * - `GET  /api/auth/me`    (auth JWT)               → snapshot user + clínica
 *
 * Nota: NO exponemos endpoint `admin-ping`. El comportamiento de `RolesGuard`
 * está cubierto por tests unitarios (`auth.controller.spec.ts` → describe
 * "RolesGuard"), sin superficie HTTP innecesaria en runtime.
 */
@Controller('auth')
export class AuthController {
  private readonly trustProxy = process.env.TRUST_PROXY === 'true';

  constructor(
    private readonly auth: AuthService,
    @InjectPinoLogger() private readonly logger: PinoLogger,
  ) {
    // `setContext` en el ctor evita la necesidad de `LoggerModule.forFeature`
    // (removido en nestjs-pino v4). El context queda como base field en cada
    // log entry emitido desde este controller.
    this.logger.setContext(AuthController.name);
  }

  /**
   * Login. Mismo mensaje de error para "email inexistente" y "password mala"
   * — la lógica anti-enumeración vive en el service.
   *
   * Rate-limit 10/min con scope `auth-login`: mitigación de fuerza bruta a
   * nivel red. Aún así el password hashing con bcrypt(10) tira el costo de
   * un ataque offline si el hash filtra. El scope explícito evita colisión
   * con futuros endpoints y no depende del path (`:slug` no aplica acá).
   *
   * Response `HTTP 200` (no 201): login NO crea recurso, sólo genera un token.
   *
   * Logging: envolvemos en try/catch para loguear intentos fallidos con IP
   * y estado. **CERO PII**: nunca email, phone, ni password. Sólo IP + status.
   */
  @Public()
  @Post('login')
  @HttpCode(200)
  @UseGuards(RateLimit(10, 'auth-login'))
  async login(
    @Body() dto: LoginDto,
    @Req() req: MinimalRequest,
  ): Promise<LoginResult> {
    try {
      return await this.auth.login(dto.email, dto.password);
    } catch (err) {
      if (err instanceof UnauthorizedException) {
        // Log de intento fallido: solo IP + status. El email NO se loguea
        // (ni en claro ni hasheado en warn) — ADR 0004 + regla dura de logs.
        const ip = extractIp(req, this.trustProxy);
        this.logger.warn(`auth login fail ip=${ip}`);
      }
      throw err;
    }
  }

  /**
   * Devuelve el user autenticado + su clínica (si `clinicId` no es null).
   * SUPERADMIN devuelve `clinic: null`.
   */
  @Get('me')
  me(@CurrentUser() user: AuthUser): Promise<AuthMe> {
    return this.auth.me(user.userId);
  }
}
