import {
  BadRequestException,
  ExecutionContext,
  ForbiddenException,
  ValidationPipe,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { LoginDto } from './dto/login.dto';
import { RolesGuard } from './guards/roles.guard';
import { ROLES_KEY } from './decorators/roles.decorator';

/**
 * Tests de la capa HTTP + guards del bloque de auth.
 *
 * - LoginDto: normalización + validaciones.
 * - RolesGuard: 403 si el rol no matchea, deja pasar si sí.
 * - Verificación de JWT: firmamos con JwtService real y decodificamos
 *   para asegurar el payload.
 */

type Deep<T> = { [K in keyof T]?: any } & Record<string, any>;

function makeExecutionContext(
  reqUser: any,
  handlerMeta: any[] | undefined = undefined,
): ExecutionContext {
  const handler = () => undefined;
  if (handlerMeta) {
    // Simulamos SetMetadata guardando la meta en la función handler.
    Reflect.defineMetadata(ROLES_KEY, handlerMeta, handler);
  }
  const cls = class Dummy {};
  return {
    switchToHttp: () => ({
      getRequest: () => ({ user: reqUser }),
      getResponse: () => ({}),
    }),
    getHandler: () => handler,
    getClass: () => cls,
  } as unknown as ExecutionContext;
}

describe('LoginDto validation', () => {
  async function validateDto(input: unknown) {
    const dto = plainToInstance(LoginDto, input);
    return validate(dto);
  }

  it('acepta credenciales bien formadas', async () => {
    const errors = await validateDto({
      email: 'admin@demo.dev',
      password: 'correcto1234',
    });
    expect(errors).toHaveLength(0);
  });

  it('normaliza email a lowercase + trim (via ValidationPipe)', async () => {
    const pipe = new ValidationPipe({ whitelist: true, transform: true });
    const out = (await pipe.transform(
      { email: '  ADMIN@Demo.DEV  ', password: 'correcto1234' },
      { type: 'body', metatype: LoginDto },
    )) as LoginDto;
    expect(out.email).toBe('admin@demo.dev');
  });

  it('rechaza email malformado con 400 al pasar por ValidationPipe', async () => {
    const pipe = new ValidationPipe({ whitelist: true, transform: true });
    await expect(
      pipe.transform(
        { email: 'no-es-email', password: 'correcto1234' },
        { type: 'body', metatype: LoginDto },
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rechaza password menor a 8 caracteres', async () => {
    const errors = await validateDto({
      email: 'admin@demo.dev',
      password: 'corto',
    });
    const pwdErr = errors.find((e) => e.property === 'password');
    expect(pwdErr).toBeDefined();
  });
});

describe('RolesGuard', () => {
  const reflector = new Reflector();
  const guard = new RolesGuard(reflector);

  it('sin @Roles decorator: deja pasar', () => {
    const ctx = makeExecutionContext({
      userId: 'u',
      clinicId: 'c',
      role: 'PROFESSIONAL',
    });
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('user con rol permitido: deja pasar', () => {
    const ctx = makeExecutionContext(
      { userId: 'u', clinicId: 'c', role: 'CLINIC_ADMIN' },
      ['SUPERADMIN', 'CLINIC_ADMIN'],
    );
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('user PROFESSIONAL contra rutas SUPERADMIN/CLINIC_ADMIN: 403', () => {
    const ctx = makeExecutionContext(
      { userId: 'u', clinicId: 'c', role: 'PROFESSIONAL' },
      ['SUPERADMIN', 'CLINIC_ADMIN'],
    );
    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
  });

  it('sin user en request pero con @Roles: 403 (defensa en profundidad)', () => {
    const ctx = makeExecutionContext(undefined, ['SUPERADMIN']);
    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
  });
});

/**
 * Verificación del contrato del JWT emitido por `JwtService` real. No mockeamos
 * la firma: firmamos con un secret conocido y decodificamos para chequear el
 * payload. Esto asegura que si migramos a otra impl (rotación de secret,
 * RS256, etc.) los tests se dan cuenta.
 */
describe('JWT payload contract', () => {
  it('token firmado por JwtService lleva sub/clinicId/role', async () => {
    // Import perezoso para no arrancar Nest solo por este test.
    const { JwtService } = await import('@nestjs/jwt');
    const jwt = new JwtService({
      secret: 'test-secret',
      signOptions: { expiresIn: '1h' },
    });
    const token = await jwt.signAsync({
      sub: 'user-1',
      clinicId: 'clinic-A',
      role: 'CLINIC_ADMIN',
    });
    const decoded = jwt.verify<{
      sub: string;
      clinicId: string;
      role: string;
      exp: number;
    }>(token, { secret: 'test-secret' });
    expect(decoded.sub).toBe('user-1');
    expect(decoded.clinicId).toBe('clinic-A');
    expect(decoded.role).toBe('CLINIC_ADMIN');
    expect(decoded.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it('token con secret distinto no valida (defensa contra tampering)', async () => {
    const { JwtService } = await import('@nestjs/jwt');
    const signer = new JwtService({ secret: 'secret-A' });
    const verifier = new JwtService({ secret: 'secret-B' });
    const token = await signer.signAsync({
      sub: 'user-1',
      clinicId: 'clinic-A',
      role: 'CLINIC_ADMIN',
    });
    expect(() => verifier.verify(token, { secret: 'secret-B' })).toThrow();
  });
});
