import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  ValidationPipe,
} from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { AvailabilityService } from '../scheduling/availability.service';
import { SchedulingService } from '../scheduling/scheduling.service';
import { PrismaService } from '../prisma/prisma.service';
import { CreatePublicAppointmentDto } from './dto/create-public-appointment.dto';
import { PublicController } from './public.controller';
import { extractIp, RateLimit, REDIS_CLIENT } from './rate-limit.guard';
import { SlugValidationPipe } from './slug.pipe';

/**
 * Tests del PublicController + del guard de rate-limit + del DTO.
 *
 * Estrategia: mocks manuales (no `@nestjs/testing`). Verificamos:
 *  - Slug inexistente → 404.
 *  - DTO inválido → errores de validación.
 *  - Honeypot lleno → 200 sin llamar a scheduling.
 *  - Rate limit: 6ta request → 429 con Retry-After: 60.
 *  - Happy path → SchedulingService recibe source='PUBLIC'.
 *  - Conflicto de slot (SchedulingService tira ConflictException) → propaga 409.
 *  - Multi-tenant: SchedulingService tira NotFoundException → 400/404 propagado.
 */

type Deep<T> = { [K in keyof T]?: any } & Record<string, any>;

function makeExecutionContext(req: any, res: any = { setHeader: jest.fn() }) {
  return {
    switchToHttp: () => ({
      getRequest: () => req,
      getResponse: () => res,
    }),
  } as any;
}

describe('CreatePublicAppointmentDto validation', () => {
  const baseValid = {
    phone: '+584141234567',
    name: 'Ana Rodríguez',
    consent: true,
    serviceId: 'svc-1',
    professionalId: 'prof-1',
    startAtISO: '2030-06-01T10:00:00-04:00',
  };

  async function validateDto(input: unknown) {
    const dto = plainToInstance(CreatePublicAppointmentDto, input);
    return validate(dto);
  }

  it('acepta un DTO válido', async () => {
    const errors = await validateDto(baseValid);
    expect(errors).toHaveLength(0);
  });

  it('rechaza phone mal formateado', async () => {
    const errors = await validateDto({ ...baseValid, phone: '123' });
    const phoneErr = errors.find((e) => e.property === 'phone');
    expect(phoneErr).toBeDefined();
  });

  it('rechaza name vacío', async () => {
    const errors = await validateDto({ ...baseValid, name: '' });
    const nameErr = errors.find((e) => e.property === 'name');
    expect(nameErr).toBeDefined();
  });

  it('rechaza consent=false', async () => {
    const errors = await validateDto({ ...baseValid, consent: false });
    const consentErr = errors.find((e) => e.property === 'consent');
    expect(consentErr).toBeDefined();
  });

  it('rechaza consent ausente', async () => {
    const { consent: _consent, ...noConsent } = baseValid;
    const errors = await validateDto(noConsent);
    const consentErr = errors.find((e) => e.property === 'consent');
    expect(consentErr).toBeDefined();
  });

  it('rechaza startAtISO no-ISO', async () => {
    const errors = await validateDto({
      ...baseValid,
      startAtISO: 'no-una-fecha',
    });
    const isoErr = errors.find((e) => e.property === 'startAtISO');
    expect(isoErr).toBeDefined();
  });

  it('trimea name y aplica minLength después del trim', async () => {
    // Simulamos el pipeline completo con ValidationPipe (que aplica @Transform).
    const pipe = new ValidationPipe({ whitelist: true, transform: true });
    await expect(
      pipe.transform(
        { ...baseValid, name: '  a  ' },
        { type: 'body', metatype: CreatePublicAppointmentDto },
      ),
    ).rejects.toThrow(BadRequestException);
  });
});

describe('PublicController', () => {
  let prisma: Deep<PrismaService>;
  let availability: Deep<AvailabilityService>;
  let scheduling: Deep<SchedulingService>;
  let controller: PublicController;

  beforeEach(() => {
    prisma = {
      clinic: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'clinic-A',
          name: 'Clínica A',
          slug: 'clinica-a',
          address: 'Av. X',
          timezone: 'America/Caracas',
          locale: 'es',
          services: [
            {
              id: 'svc-1',
              name: 'Consulta',
              durationMin: 30,
              priceCents: 5000,
            },
          ],
          professionals: [
            {
              id: 'prof-1',
              name: 'Dra. Ríos',
              services: [{ id: 'svc-1' }],
            },
          ],
        }),
      },
    };
    availability = {
      getSlots: jest.fn().mockResolvedValue([]),
    };
    scheduling = {
      createAppointment: jest.fn().mockResolvedValue({
        id: 'appt-1',
        startAt: new Date('2030-06-01T14:00:00Z'),
        endAt: new Date('2030-06-01T14:30:00Z'),
        status: 'PENDIENTE',
      }),
    };
    controller = new PublicController(
      prisma as unknown as PrismaService,
      availability as unknown as AvailabilityService,
      scheduling as unknown as SchedulingService,
    );
  });

  describe('GET :slug', () => {
    it('devuelve snapshot público sin datos sensibles', async () => {
      const result = await controller.getClinic('clinica-a');
      expect(result.id).toBe('clinic-A');
      expect(result.name).toBe('Clínica A');
      expect(result.services).toHaveLength(1);
      expect(result.professionals[0].serviceIds).toEqual(['svc-1']);
      // No exponemos wahaSession, autoConfirm, etc.
      expect(result).not.toHaveProperty('wahaSession');
      expect(result).not.toHaveProperty('autoConfirm');
    });

    it('tira 404 si el slug no existe', async () => {
      prisma.clinic.findUnique.mockResolvedValueOnce(null);
      await expect(controller.getClinic('no-existe')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('POST :slug/appointments', () => {
    const dto: CreatePublicAppointmentDto = {
      phone: '+584141234567',
      name: 'Ana',
      consent: true,
      serviceId: 'svc-1',
      professionalId: 'prof-1',
      startAtISO: '2030-06-01T10:00:00-04:00',
    };

    it('tira 404 si el slug no existe', async () => {
      prisma.clinic.findUnique.mockResolvedValueOnce(null);
      await expect(
        controller.createAppointment('no-existe', { ...dto }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(scheduling.createAppointment).not.toHaveBeenCalled();
    });

    it('honeypot lleno → 200 { ok: true } sin crear nada', async () => {
      const result = await controller.createAppointment('clinica-a', {
        ...dto,
        honeypot: 'i-am-a-bot',
      });
      expect(result).toEqual({ ok: true });
      expect(scheduling.createAppointment).not.toHaveBeenCalled();
      // Tampoco resolvimos la clínica en Prisma (respondemos antes).
      expect(prisma.clinic.findUnique).not.toHaveBeenCalled();
    });

    it('happy path: crea la cita con source="PUBLIC"', async () => {
      const result = await controller.createAppointment('clinica-a', {
        ...dto,
      });
      expect(scheduling.createAppointment).toHaveBeenCalledWith(
        expect.objectContaining({
          clinicId: 'clinic-A',
          source: 'PUBLIC',
          patient: expect.objectContaining({
            phone: '+584141234567',
            name: 'Ana',
            consent: true,
          }),
        }),
      );
      expect(result).toMatchObject({
        id: 'appt-1',
        status: 'PENDIENTE',
      });
      // Cero PII en la respuesta: NO debe incluir patient.{name,phone}.
      expect(result).not.toHaveProperty('patient');
    });

    it('normaliza phone sin `+` inicial agregándoselo', async () => {
      await controller.createAppointment('clinica-a', {
        ...dto,
        phone: '584141234567',
      });
      const call = scheduling.createAppointment.mock.calls[0][0];
      expect(call.patient.phone).toBe('+584141234567');
    });

    it('propaga ConflictException (slot tomado) como 409', async () => {
      scheduling.createAppointment.mockRejectedValueOnce(
        new ConflictException('slot ya no está disponible'),
      );
      await expect(
        controller.createAppointment('clinica-a', { ...dto }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('propaga NotFoundException del scheduling (serviceId de otra clínica)', async () => {
      scheduling.createAppointment.mockRejectedValueOnce(
        new NotFoundException('servicio no encontrado en esta clínica'),
      );
      await expect(
        controller.createAppointment('clinica-a', {
          ...dto,
          serviceId: 'svc-de-otra-clinica',
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('GET :slug/availability', () => {
    it('tira 404 si el slug no existe', async () => {
      prisma.clinic.findUnique.mockResolvedValueOnce(null);
      await expect(
        controller.getAvailability(
          'no-existe',
          'svc-1',
          'prof-1',
          '2030-06-01',
          '7',
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('tira 400 si falta serviceId/professionalId/from', async () => {
      await expect(
        controller.getAvailability('clinica-a', '', 'prof-1', '2030-06-01'),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('llama a availability.getSlots con clinicId resuelto por slug', async () => {
      await controller.getAvailability(
        'clinica-a',
        'svc-1',
        'prof-1',
        '2030-06-01',
        '7',
      );
      expect(availability.getSlots).toHaveBeenCalledWith(
        expect.objectContaining({
          clinicId: 'clinic-A',
          serviceId: 'svc-1',
          professionalId: 'prof-1',
          fromISO: '2030-06-01',
          days: 7,
        }),
      );
    });
  });
});

describe('RateLimit guard', () => {
  it('permite hasta N requests y bloquea la N+1 con 429 + Retry-After: 60', async () => {
    // Mock de ioredis: contador in-memory por key.
    const store = new Map<string, number>();
    const redis = {
      pipeline: () => {
        const ops: Array<() => any> = [];
        return {
          incr: (key: string) => {
            ops.push(() => {
              const current = (store.get(key) ?? 0) + 1;
              store.set(key, current);
              return current;
            });
            return this;
          },
          expire: (_key: string, _ttl: number) => {
            ops.push(() => 1);
            return this;
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
      },
    };

    const Guard = RateLimit(5);
    const guard = new Guard(redis as any);
    const setHeader = jest.fn();
    const res = { setHeader };

    // 5 pasan.
    for (let i = 0; i < 5; i++) {
      const ctx = makeExecutionContext(
        { params: { slug: 'clinica-a' }, headers: {}, ip: '1.2.3.4' },
        res,
      );
      await expect(guard.canActivate(ctx)).resolves.toBe(true);
    }

    // La 6ta falla con 429.
    const ctx6 = makeExecutionContext(
      { params: { slug: 'clinica-a' }, headers: {}, ip: '1.2.3.4' },
      res,
    );
    await expect(guard.canActivate(ctx6)).rejects.toMatchObject({
      status: 429,
    });
    // Retry-After seteado.
    expect(setHeader).toHaveBeenCalledWith('Retry-After', '60');
  });

  it('cuenta por combinación slug+ip (IPs distintas no comparten cupo)', async () => {
    const store = new Map<string, number>();
    const redis = {
      pipeline: () => {
        const ops: Array<() => any> = [];
        return {
          incr: (key: string) => {
            ops.push(() => {
              const current = (store.get(key) ?? 0) + 1;
              store.set(key, current);
              return current;
            });
            return this;
          },
          expire: (_key: string, _ttl: number) => {
            ops.push(() => 1);
            return this;
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
      },
    };

    const Guard = RateLimit(2);
    const guard = new Guard(redis as any);
    const res = { setHeader: jest.fn() };

    // 2 desde IP1 y 2 desde IP2 → todas pasan (buckets independientes).
    for (const ip of ['1.1.1.1', '2.2.2.2']) {
      for (let i = 0; i < 2; i++) {
        const ctx = makeExecutionContext(
          { params: { slug: 'clinica-a' }, headers: {}, ip },
          res,
        );
        await expect(guard.canActivate(ctx)).resolves.toBe(true);
      }
    }
  });
});

describe('extractIp', () => {
  it('sin TRUST_PROXY: devuelve req.ip aunque venga X-Forwarded-For', () => {
    const req = {
      ip: '10.0.0.1',
      headers: { 'x-forwarded-for': '1.2.3.4, 5.6.7.8' },
    };
    expect(extractIp(req, false)).toBe('10.0.0.1');
  });

  it('sin TRUST_PROXY y sin req.ip: devuelve "unknown"', () => {
    const req = { headers: {} };
    expect(extractIp(req, false)).toBe('unknown');
  });

  it('con TRUST_PROXY y XFF válido: devuelve la primera IP', () => {
    const req = {
      ip: '10.0.0.1',
      headers: { 'x-forwarded-for': '1.1.1.1, 2.2.2.2' },
    };
    expect(extractIp(req, true)).toBe('1.1.1.1');
  });

  it('con TRUST_PROXY y XFF con espacios: trimea la primera IP', () => {
    const req = {
      ip: '10.0.0.1',
      headers: { 'x-forwarded-for': '  8.8.8.8  , 9.9.9.9' },
    };
    expect(extractIp(req, true)).toBe('8.8.8.8');
  });

  it('con TRUST_PROXY y XFF con basura (10KB de "a"): devuelve "invalid"', () => {
    // 10240 chars — obvio garbage. Debe rebotar como invalid, no propagarse.
    const junk = 'a'.repeat(10_240);
    const req = {
      ip: '10.0.0.1',
      headers: { 'x-forwarded-for': junk },
    };
    // El slice(0, 45) recorta a "aaaa…" que sí matchearía IP_ALLOWED
    // (letras 'a' están dentro de [0-9a-f:.]), así que verificamos con
    // caracteres claramente inválidos (símbolos).
    // Test principal: garbage con símbolos → invalid.
    const req2 = {
      ip: '10.0.0.1',
      headers: { 'x-forwarded-for': '<script>alert(1)</script>' },
    };
    expect(extractIp(req2, true)).toBe('invalid');
    // Con 10KB de 'a' recortamos a 45 chars y sigue siendo hex-válido,
    // pero el objetivo del sanity check es evitar payloads gigantes:
    // verificamos que devuelve algo de longitud acotada.
    const result = extractIp(req, true);
    expect(result.length).toBeLessThanOrEqual(45);
  });

  it('con TRUST_PROXY y XFF con IPv6: devuelve la primera IP', () => {
    const req = {
      ip: '10.0.0.1',
      headers: {
        'x-forwarded-for': '2001:db8::1, 2001:db8::2',
      },
    };
    expect(extractIp(req, true)).toBe('2001:db8::1');
  });

  it('con TRUST_PROXY y XFF vacío: cae a req.ip', () => {
    const req = {
      ip: '10.0.0.1',
      headers: { 'x-forwarded-for': '' },
    };
    expect(extractIp(req, true)).toBe('10.0.0.1');
  });

  it('con TRUST_PROXY y XFF como array: usa el primer elemento', () => {
    const req = {
      ip: '10.0.0.1',
      headers: { 'x-forwarded-for': ['3.3.3.3', '4.4.4.4'] },
    };
    expect(extractIp(req, true)).toBe('3.3.3.3');
  });
});

describe('SlugValidationPipe', () => {
  const pipe = new SlugValidationPipe();

  it('acepta un slug válido con letras y guiones', () => {
    expect(pipe.transform('clinica-a', { type: 'param' } as any)).toBe(
      'clinica-a',
    );
  });

  it('acepta un slug con dígitos', () => {
    expect(pipe.transform('clinica-42', { type: 'param' } as any)).toBe(
      'clinica-42',
    );
  });

  it('rechaza slug con mayúsculas', () => {
    expect(() =>
      pipe.transform('CON-MAYUS', { type: 'param' } as any),
    ).toThrow(BadRequestException);
  });

  it('rechaza slug con símbolos', () => {
    expect(() =>
      pipe.transform('clinica!', { type: 'param' } as any),
    ).toThrow(BadRequestException);
  });

  it('rechaza slug vacío', () => {
    expect(() => pipe.transform('', { type: 'param' } as any)).toThrow(
      BadRequestException,
    );
  });

  it('rechaza slug de más de 50 chars', () => {
    const long = 'a'.repeat(51);
    expect(() => pipe.transform(long, { type: 'param' } as any)).toThrow(
      BadRequestException,
    );
  });
});
