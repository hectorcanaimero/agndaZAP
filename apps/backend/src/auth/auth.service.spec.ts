import { HttpException, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../prisma/prisma.service';
import { AuthService, hashEmailForKey } from './auth.service';
import * as passwordUtil from './password.util';

/**
 * Tests del AuthService — la lógica sensible del bloque de auth vive acá:
 * - Anti-enumeración: mismo error si email no existe o password mala.
 * - Anti-timing DETERMINÍSTICO: spy sobre `verifyPassword` con DUMMY_HASH.
 * - Payload JWT correcto (sub, clinicId, role).
 * - `me()` NO devuelve password bajo ningún caso.
 * - Multi-tenant: dos users → dos payloads con clinicId distinto.
 * - Rate-limit por email hasheado: 6to fail seguido → 429.
 */

type Deep<T> = { [K in keyof T]?: any } & Record<string, any>;

/**
 * Mock in-memory de ioredis: modela `get`, `del` y un `pipeline().incr().expire().exec()`
 * con la semántica que usa AuthService. No pretende ser fiel al 100% del API
 * de ioredis — sólo lo que consumimos.
 */
function makeRedisMock() {
  const store = new Map<string, number>();
  const ttl = new Map<string, number>();
  const api: any = {
    _store: store,
    _ttl: ttl,
    get: jest.fn(async (key: string) => {
      const v = store.get(key);
      return v === undefined ? null : String(v);
    }),
    del: jest.fn(async (key: string) => {
      const existed = store.delete(key);
      ttl.delete(key);
      return existed ? 1 : 0;
    }),
    pipeline: () => {
      const ops: Array<() => any> = [];
      const p: any = {
        incr: (key: string) => {
          ops.push(() => {
            const next = (store.get(key) ?? 0) + 1;
            store.set(key, next);
            return next;
          });
          return p;
        },
        expire: (key: string, seconds: number) => {
          ops.push(() => {
            ttl.set(key, seconds);
            return 1;
          });
          return p;
        },
        exec: async () =>
          ops.map((op) => {
            try {
              return [null, op()];
            } catch (e) {
              return [e, null];
            }
          }),
      };
      return p;
    },
  };
  return api;
}

describe('AuthService', () => {
  let prisma: Deep<PrismaService>;
  let jwt: Deep<JwtService>;
  let redis: any;
  let service: AuthService;

  const validHash = () => passwordUtil.hashPassword('correcto1234');

  beforeEach(() => {
    prisma = {
      user: {
        findUnique: jest.fn(),
      },
    };
    jwt = {
      signAsync: jest.fn().mockImplementation(async (payload: any) =>
        // Simulamos un token opaco pero determinista basado en el payload.
        // El controller de AuthController.spec.ts hace la verificación real.
        `signed.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.sig`,
      ),
    };
    redis = makeRedisMock();
    service = new AuthService(
      prisma as unknown as PrismaService,
      jwt as unknown as JwtService,
      redis,
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('login', () => {
    it('acepta credenciales válidas y firma JWT con sub/clinicId/role', async () => {
      const hash = await validHash();
      prisma.user.findUnique.mockResolvedValue({
        id: 'user-1',
        clinicId: 'clinic-A',
        email: 'admin@demo.dev',
        password: hash,
        name: 'Admin',
        role: 'CLINIC_ADMIN',
      });

      const result = await service.login('admin@demo.dev', 'correcto1234');
      expect(result).toHaveProperty('accessToken');
      // `expiresIn`/`algorithm` viven en JwtModule.register — el service
      // ya no pasa options a signAsync. Sólo verificamos el payload.
      expect(jwt.signAsync).toHaveBeenCalledWith({
        sub: 'user-1',
        clinicId: 'clinic-A',
        role: 'CLINIC_ADMIN',
      });
    });

    it('rechaza con email inexistente con mensaje genérico', async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      await expect(
        service.login('noexiste@x.dev', 'cualquiera1234'),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      // Segunda llamada limpiamos el rate-limit por email para que no gatille 429.
      redis._store.clear();
      await expect(
        service.login('noexiste@x.dev', 'cualquiera1234'),
      ).rejects.toThrow('credenciales inválidas');
    });

    it('rechaza con password incorrecta con MISMO mensaje que email inexistente', async () => {
      const hash = await validHash();
      prisma.user.findUnique.mockResolvedValue({
        id: 'user-1',
        clinicId: 'clinic-A',
        email: 'admin@demo.dev',
        password: hash,
        name: 'Admin',
        role: 'CLINIC_ADMIN',
      });
      await expect(
        service.login('admin@demo.dev', 'password-mala'),
      ).rejects.toThrow('credenciales inválidas');
    });

    it('mitigación timing DETERMINÍSTICA: rama "user no existe" llama verifyPassword con DUMMY_HASH', async () => {
      // Spy sobre verifyPassword del módulo. Sin medir tiempo — sin flakiness.
      const spy = jest
        .spyOn(passwordUtil, 'verifyPassword')
        .mockResolvedValue(false);
      prisma.user.findUnique.mockResolvedValueOnce(null);
      await service
        .login('noexiste@x.dev', 'cualquiera1234')
        .catch(() => null);
      // Aserción DIRECTA: verifyPassword corrió con el DUMMY_HASH.
      expect(spy).toHaveBeenCalledWith('cualquiera1234', passwordUtil.DUMMY_HASH);
    });

    it('multi-tenant: dos users de clínicas distintas firman JWTs con SU clinicId', async () => {
      const hash = await validHash();
      // User de la clínica A.
      prisma.user.findUnique.mockResolvedValueOnce({
        id: 'user-A',
        clinicId: 'clinic-A',
        email: 'a@demo.dev',
        password: hash,
        name: 'A',
        role: 'CLINIC_ADMIN',
      });
      await service.login('a@demo.dev', 'correcto1234');

      // User de la clínica B.
      prisma.user.findUnique.mockResolvedValueOnce({
        id: 'user-B',
        clinicId: 'clinic-B',
        email: 'b@demo.dev',
        password: hash,
        name: 'B',
        role: 'CLINIC_ADMIN',
      });
      await service.login('b@demo.dev', 'correcto1234');

      const call1 = jwt.signAsync.mock.calls[0][0];
      const call2 = jwt.signAsync.mock.calls[1][0];
      expect(call1.clinicId).toBe('clinic-A');
      expect(call2.clinicId).toBe('clinic-B');
      // Ningún leak cruzado.
      expect(call1.sub).toBe('user-A');
      expect(call2.sub).toBe('user-B');
    });

    it('SUPERADMIN sin clínica: payload trae clinicId=null', async () => {
      const hash = await validHash();
      prisma.user.findUnique.mockResolvedValue({
        id: 'user-super',
        clinicId: null,
        email: 'super@agendazap.dev',
        password: hash,
        name: 'Super',
        role: 'SUPERADMIN',
      });
      await service.login('super@agendazap.dev', 'correcto1234');
      const payload = jwt.signAsync.mock.calls[0][0];
      expect(payload.clinicId).toBeNull();
      expect(payload.role).toBe('SUPERADMIN');
    });
  });

  describe('login rate-limit por email hasheado', () => {
    it('5 logins fallidos con el mismo email → el 6to → 429 con "demasiados intentos"', async () => {
      prisma.user.findUnique.mockResolvedValue(null); // siempre user no existe
      // 5 intentos deben fallar con 401.
      for (let i = 0; i < 5; i++) {
        await expect(
          service.login('victima@demo.dev', 'password-mala'),
        ).rejects.toBeInstanceOf(UnauthorizedException);
      }
      // El 6to intento: 429.
      await expect(
        service.login('victima@demo.dev', 'password-mala'),
      ).rejects.toBeInstanceOf(HttpException);
      await expect(
        service.login('victima@demo.dev', 'password-mala'),
      ).rejects.toMatchObject({ status: 429 });
    });

    it('login exitoso limpia el counter (DEL sobre login_fail:*)', async () => {
      const hash = await validHash();
      // Simulamos 2 fails previos: seteamos el counter directo en el store.
      const key = `login_fail:${hashEmailForKey('victima@demo.dev')}`;
      redis._store.set(key, 2);

      prisma.user.findUnique.mockResolvedValue({
        id: 'user-1',
        clinicId: 'clinic-A',
        email: 'victima@demo.dev',
        password: hash,
        name: 'Admin',
        role: 'CLINIC_ADMIN',
      });
      await service.login('victima@demo.dev', 'correcto1234');
      // Después del ok, el counter debe estar borrado.
      expect(redis._store.has(key)).toBe(false);
      expect(redis.del).toHaveBeenCalledWith(key);
    });

    it('diferentes emails NO comparten counter', async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      // 5 fails para email A.
      for (let i = 0; i < 5; i++) {
        await service.login('a@demo.dev', 'pw').catch(() => null);
      }
      // El primer intento de email B debe pasar (a 401, NO a 429).
      await expect(
        service.login('b@demo.dev', 'pw'),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      // El keyspace debe tener 2 entries distintos.
      const keys = Array.from(redis._store.keys()) as string[];
      expect(keys.length).toBe(2);
    });
  });

  describe('me', () => {
    it('devuelve user + clinic (sin password)', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: 'user-1',
        clinicId: 'clinic-A',
        email: 'admin@demo.dev',
        password: '<hash-secreto>',
        name: 'Admin',
        role: 'CLINIC_ADMIN',
        clinic: {
          id: 'clinic-A',
          name: 'Clínica A',
          slug: 'clinica-a',
          timezone: 'America/Caracas',
          locale: 'es',
        },
      });
      const me = await service.me('user-1');
      expect(me).not.toHaveProperty('password');
      expect(me.clinic).toMatchObject({
        id: 'clinic-A',
        slug: 'clinica-a',
      });
    });

    it('SUPERADMIN sin clínica: clinic es null', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: 'user-super',
        clinicId: null,
        email: 'super@agendazap.dev',
        password: '<hash>',
        name: 'Super',
        role: 'SUPERADMIN',
        clinic: null,
      });
      const me = await service.me('user-super');
      expect(me.clinic).toBeNull();
      expect(me.role).toBe('SUPERADMIN');
    });

    it('tira 401 si el user del JWT ya no existe (usuario borrado)', async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      await expect(service.me('user-fantasma')).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });
  });
});
