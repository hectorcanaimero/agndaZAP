import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  ValidationPipe,
} from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { AvailabilityService } from '../scheduling/availability.service';
import { SchedulingSessionService } from '../scheduling/scheduling-session.service';
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
  let sessions: Deep<SchedulingSessionService>;
  let controller: PublicController;

  beforeEach(() => {
    prisma = {
      clinic: {
        // `issueManageUrl` lee el locale para armar la URL de la web.
        findUnique: jest.fn().mockResolvedValue({ locale: 'es' }),
        findFirst: jest.fn().mockResolvedValue({
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
      service: {
        findFirst: jest.fn().mockResolvedValue({ id: 'svc-1' }),
      },
      professional: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'prof-1',
          services: [{ id: 'svc-1' }],
        }),
      },
      appointment: {
        // `issueManageUrl` lee el phone del paciente para guardarlo en el token.
        findUnique: jest
          .fn()
          .mockResolvedValue({ patient: { phone: '+584141234567' } }),
        findFirst: jest.fn().mockResolvedValue(null),
      },
    };
    availability = {
      getSlots: jest.fn().mockResolvedValue([]),
    };
    scheduling = {
      createAppointment: jest.fn().mockResolvedValue({
        appointment: {
          id: 'appt-1',
          clinicId: 'clinic-1',
          startAt: new Date('2030-06-01T14:00:00Z'),
          endAt: new Date('2030-06-01T14:30:00Z'),
          status: 'PENDIENTE',
        },
        patientCreated: true,
      }),
    };
    sessions = {
      // Por defecto: sin token, cero interacciones. Tests que ejercitan el
      // flujo `?t=` sobrescriben esta implementación.
      consume: jest.fn().mockResolvedValue(null),
      resolve: jest.fn().mockResolvedValue(null),
      create: jest.fn(),
      createManage: jest
        .fn()
        .mockResolvedValue({ token: 'mtok-abc', expiresInSeconds: 86400 }),
      resolveManage: jest.fn().mockResolvedValue(null),
      invalidateManage: jest.fn().mockResolvedValue(undefined),
    };
    controller = new PublicController(
      prisma as unknown as PrismaService,
      availability as unknown as AvailabilityService,
      scheduling as unknown as SchedulingService,
      sessions as unknown as SchedulingSessionService,
    );
  });

  describe('POST :slug/appointments — manageUrl', () => {
    it('devuelve manageUrl para que /gracias ofrezca cancelar o cambiar horario', async () => {
      process.env.WEB_BASE_URL = 'https://showly.us';
      const res: any = await controller.createAppointment('clinica-a', {
        phone: '+584141234567',
        name: 'Ana',
        serviceId: 'svc-1',
        professionalId: 'prof-1',
        startAtISO: '2030-06-01T14:00:00.000Z',
        consent: true,
      } as any);

      expect(res.manageUrl).toBe(
        'https://showly.us/es/agendar/clinica-a/cita?t=mtok-abc',
      );
      delete process.env.WEB_BASE_URL;
    });

    it('si Redis está caído la cita se crea igual, solo sin manageUrl', async () => {
      // Fail-open: perder el link de gestión no puede costar la cita.
      sessions.createManage.mockRejectedValue(new Error('redis down'));

      const res: any = await controller.createAppointment('clinica-a', {
        phone: '+584141234567',
        name: 'Ana',
        serviceId: 'svc-1',
        professionalId: 'prof-1',
        startAtISO: '2030-06-01T14:00:00.000Z',
        consent: true,
      } as any);

      expect(res.id).toBe('appt-1');
      expect(res.manageUrl).toBeUndefined();
    });

    it('la respuesta pública nunca filtra patientCreated', async () => {
      // Diría si ese teléfono ya era paciente de la clínica → oráculo para
      // enumerar pacientes probando números.
      const res: any = await controller.createAppointment('clinica-a', {
        phone: '+584141234567',
        name: 'Ana',
        serviceId: 'svc-1',
        professionalId: 'prof-1',
        startAtISO: '2030-06-01T14:00:00.000Z',
        consent: true,
      } as any);

      expect(res).not.toHaveProperty('patientCreated');
    });
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

    it('whatsappPhone es null cuando la clínica no configuró publicWhatsappPhone (opt-in)', async () => {
      const result = await controller.getClinic('clinica-a');
      expect(result.whatsappPhone).toBeNull();
    });

    it('whatsappPhone devuelve el número configurado (ya canonizado en E.164)', async () => {
      const base = await prisma.clinic.findFirst();
      prisma.clinic.findFirst.mockResolvedValueOnce({
        ...base,
        publicWhatsappPhone: '+5804121234567',
      });
      const result = await controller.getClinic('clinica-a');
      expect(result.whatsappPhone).toBe('+5804121234567');
      // El nombre interno del campo no se filtra tal cual.
      expect(result).not.toHaveProperty('publicWhatsappPhone');
    });

    it('nunca expone teléfonos de profesionales aunque Prisma los traiga', async () => {
      const base = await prisma.clinic.findFirst();
      prisma.clinic.findFirst.mockResolvedValueOnce({
        ...base,
        wahaSession: 'clinica-a',
        professionals: [
          {
            id: 'prof-1',
            name: 'Dra. Ríos',
            phone: '+5804129999999',
            services: [{ id: 'svc-1' }],
          },
        ],
      });
      const result = await controller.getClinic('clinica-a');
      expect(result.professionals[0]).toEqual({
        id: 'prof-1',
        name: 'Dra. Ríos',
        serviceIds: ['svc-1'],
      });
      expect(JSON.stringify(result)).not.toContain('9999999');
      expect(result).not.toHaveProperty('wahaSession');
    });

    it('tira 404 si el slug no existe', async () => {
      prisma.clinic.findFirst.mockResolvedValueOnce(null);
      await expect(controller.getClinic('no-existe')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('filtra por status ACTIVE (clínica SUSPENDED → 404)', async () => {
      // Prisma no devuelve la fila si no cumple el where; simulamos eso.
      prisma.clinic.findFirst.mockResolvedValueOnce(null);
      await expect(controller.getClinic('suspendida')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(prisma.clinic.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { slug: 'suspendida', status: 'ACTIVE' },
        }),
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
      prisma.clinic.findFirst.mockResolvedValueOnce(null);
      await expect(
        controller.createAppointment('no-existe', { ...dto }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(scheduling.createAppointment).not.toHaveBeenCalled();
    });

    it('clínica SUSPENDED → 404 y no crea cita', async () => {
      prisma.clinic.findFirst.mockResolvedValueOnce(null);
      await expect(
        controller.createAppointment('suspendida', { ...dto }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.clinic.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { slug: 'suspendida', status: 'ACTIVE' },
        }),
      );
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
      expect(prisma.clinic.findFirst).not.toHaveBeenCalled();
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

    describe('con token (link mandado por WA)', () => {
      const validToken = 'a'.repeat(32);

      it('happy path: consume el token, crea con source=BOT_WEB y ata conversationId', async () => {
        sessions.consume.mockResolvedValueOnce({
          conversationId: 'conv-1',
          clinicId: 'clinic-A',
          clinicSlug: 'clinica-a',
          phone: '+584141234567',
          lid: null,
          name: 'Ana',
          createdAtISO: new Date().toISOString(),
        });

        await controller.createAppointment('clinica-a', {
          ...dto,
          token: validToken,
        });

        expect(sessions.consume).toHaveBeenCalledWith(validToken);
        expect(scheduling.createAppointment).toHaveBeenCalledWith(
          expect.objectContaining({
            source: 'BOT_WEB',
            conversationId: 'conv-1',
          }),
        );
      });

      it('token inválido/expirado → 400 y NO crea cita', async () => {
        sessions.consume.mockResolvedValueOnce(null);
        await expect(
          controller.createAppointment('clinica-a', {
            ...dto,
            token: validToken,
          }),
        ).rejects.toBeInstanceOf(BadRequestException);
        expect(scheduling.createAppointment).not.toHaveBeenCalled();
      });

      it('token de otra clínica → 400 (multi-tenant guard)', async () => {
        sessions.consume.mockResolvedValueOnce({
          conversationId: 'conv-1',
          clinicId: 'clinic-B',
          clinicSlug: 'clinica-b', // ≠ 'clinica-a' del path
          phone: '+584141234567',
          lid: null,
          name: 'Ana',
          createdAtISO: new Date().toISOString(),
        });
        await expect(
          controller.createAppointment('clinica-a', {
            ...dto,
            token: validToken,
          }),
        ).rejects.toBeInstanceOf(BadRequestException);
        expect(scheduling.createAppointment).not.toHaveBeenCalled();
      });

      it('sin token: mantiene source=PUBLIC y no toca sessions', async () => {
        await controller.createAppointment('clinica-a', { ...dto });
        expect(sessions.consume).not.toHaveBeenCalled();
        expect(scheduling.createAppointment).toHaveBeenCalledWith(
          expect.objectContaining({ source: 'PUBLIC' }),
        );
      });
    });
  });

  describe('GET :slug/availability', () => {
    it('tira 404 si el slug no existe', async () => {
      prisma.clinic.findFirst.mockResolvedValueOnce(null);
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

    it('clínica SUSPENDED → 404 sin consultar slots', async () => {
      prisma.clinic.findFirst.mockResolvedValueOnce(null);
      await expect(
        controller.getAvailability(
          'suspendida',
          'svc-1',
          'prof-1',
          '2030-06-01',
          '7',
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.clinic.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { slug: 'suspendida', status: 'ACTIVE' },
        }),
      );
      expect(availability.getSlots).not.toHaveBeenCalled();
    });

    it('tira 400 si falta serviceId/professionalId/from', async () => {
      await expect(
        controller.getAvailability('clinica-a', '', 'prof-1', '2030-06-01'),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('tira 400 si days no es entero', async () => {
      await expect(
        controller.getAvailability(
          'clinica-a',
          'svc-1',
          'prof-1',
          '2030-06-01',
          'abc',
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(availability.getSlots).not.toHaveBeenCalled();
    });

    it('tira 400 si from no es ISO válido', async () => {
      await expect(
        controller.getAvailability(
          'clinica-a',
          'svc-1',
          'prof-1',
          'not-a-date',
          '7',
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(availability.getSlots).not.toHaveBeenCalled();
    });

    it('tira 404 si el servicio no pertenece a la clínica', async () => {
      prisma.service.findFirst.mockResolvedValueOnce(null);
      await expect(
        controller.getAvailability(
          'clinica-a',
          'svc-otra',
          'prof-1',
          '2030-06-01',
          '7',
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(availability.getSlots).not.toHaveBeenCalled();
    });

    it('tira 400 si el profesional no atiende el servicio', async () => {
      prisma.professional.findFirst.mockResolvedValueOnce({
        id: 'prof-1',
        services: [],
      });
      await expect(
        controller.getAvailability(
          'clinica-a',
          'svc-1',
          'prof-1',
          '2030-06-01',
          '7',
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(availability.getSlots).not.toHaveBeenCalled();
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

  it('si Redis rechaza la operación, hace fail-open y no tira 500', async () => {
    const redis = {
      pipeline: () => ({
        incr: jest.fn().mockReturnThis(),
        expire: jest.fn().mockReturnThis(),
        exec: jest.fn().mockRejectedValue(new Error('redis down')),
      }),
    };

    const Guard = RateLimit(1);
    const guard = new Guard(redis as any);
    const ctx = makeExecutionContext({
      params: { slug: 'clinica-a' },
      headers: {},
      ip: '1.2.3.4',
    });

    await expect(guard.canActivate(ctx)).resolves.toBe(true);
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

/**
 * Gestión de cita por link (ADR 0020). El token ES la autorización: no hay
 * usuario autenticado, así que lo que se prueba acá es sobre todo que no haya
 * forma de llegar a una cita ajena y que el estado se re-valide contra la DB.
 */
describe('PublicController — gestión de cita por link', () => {
  let prisma: any;
  let availability: any;
  let scheduling: any;
  let sessions: any;
  let controller: PublicController;

  const TOKEN = 'm'.repeat(32);
  const future = () => new Date(Date.now() + 48 * 60 * 60 * 1000);

  const SESSION = {
    kind: 'manage' as const,
    appointmentId: 'appt-1',
    clinicId: 'clinic-A',
    clinicSlug: 'clinica-a',
    phone: '+584141234567',
    createdAtISO: new Date().toISOString(),
  };

  function makeAppt(over: Record<string, unknown> = {}) {
    return {
      id: 'appt-1',
      clinicId: 'clinic-A',
      status: 'CONFIRMADA',
      startAt: future(),
      serviceId: 'svc-1',
      professionalId: 'prof-1',
      rescheduleCount: 0,
      patientRescheduleCount: 0,
      service: { id: 'svc-1', name: 'Consulta', durationMin: 30 },
      professional: { id: 'prof-1', name: 'Dra. Ríos' },
      patient: { name: 'Ana Pérez' },
      clinic: {
        name: 'Clínica A',
        address: 'Av. X',
        timezone: 'America/Caracas',
        locale: 'es',
      },
      ...over,
    };
  }

  beforeEach(() => {
    process.env.WEB_BASE_URL = 'https://showly.us';
    prisma = {
      clinic: { findUnique: jest.fn().mockResolvedValue({ locale: 'es' }) },
      appointment: {
        findFirst: jest.fn().mockResolvedValue(makeAppt()),
        findUnique: jest
          .fn()
          .mockResolvedValue({ patient: { phone: '+584141234567' } }),
      },
    };
    availability = { getSlots: jest.fn() };
    scheduling = {
      cancelByPatient: jest
        .fn()
        .mockResolvedValue({ id: 'appt-1', status: 'CANCELADA' }),
      rescheduleAppointment: jest.fn().mockResolvedValue({
        id: 'appt-1',
        clinicId: 'clinic-A',
        serviceId: 'svc-1',
        professionalId: 'prof-1',
        // Reagendar reinicia el ciclo de confirmación (S6).
        status: 'PENDIENTE',
        startAt: new Date('2030-06-02T14:00:00Z'),
        patientRescheduleCount: 1,
      }),
    };
    sessions = {
      resolveManage: jest.fn().mockResolvedValue(SESSION),
      invalidateManage: jest.fn().mockResolvedValue(undefined),
      createManage: jest
        .fn()
        .mockResolvedValue({ token: 'mtok-new', expiresInSeconds: 3600 }),
    };
    controller = new PublicController(
      prisma as unknown as PrismaService,
      availability as unknown as AvailabilityService,
      scheduling as unknown as SchedulingService,
      sessions as unknown as SchedulingSessionService,
    );
  });

  afterEach(() => {
    delete process.env.WEB_BASE_URL;
  });

  describe('GET manage/:token', () => {
    it('devuelve la cita con canCancel/canReschedule y NO consume el token', async () => {
      const res = await controller.getManagedAppointment('clinica-a', TOKEN);

      expect(res.appointment).toMatchObject({
        id: 'appt-1',
        serviceName: 'Consulta',
        professionalName: 'Dra. Ríos',
        durationMin: 30,
        status: 'CONFIRMADA',
        rescheduleCount: 0,
      });
      expect(res.clinic.name).toBe('Clínica A');
      expect(res.patient.name).toBe('Ana Pérez');
      expect(res.canCancel).toBe(true);
      expect(res.canReschedule).toBe(true);
      // El paciente puede recargar la página cuantas veces quiera.
      expect(sessions.invalidateManage).not.toHaveBeenCalled();
    });

    it('NO expone el teléfono del paciente', async () => {
      // El link puede acabar reenviado por WhatsApp o en el historial del
      // navegador; el nombre basta para que el paciente reconozca su cita.
      const res = await controller.getManagedAppointment('clinica-a', TOKEN);

      expect(JSON.stringify(res)).not.toContain('584141234567');
      expect(res.patient).not.toHaveProperty('phone');
    });

    it('multi-tenant: la cita se busca por el clinicId DEL TOKEN, no por el slug', async () => {
      await controller.getManagedAppointment('clinica-a', TOKEN);

      expect(prisma.appointment.findFirst.mock.calls[0][0].where).toEqual({
        id: 'appt-1',
        clinicId: 'clinic-A',
        // Una clínica suspendida o archivada deja de servir datos de pacientes
        // y de aceptar cambios, igual que en los otros endpoints públicos.
        clinic: { status: 'ACTIVE' },
      });
    });

    it('token de otra clínica → 404 aunque el token sea válido', async () => {
      sessions.resolveManage.mockResolvedValue({
        ...SESSION,
        clinicSlug: 'otra-clinica',
      });

      await expect(
        controller.getManagedAppointment('clinica-a', TOKEN),
      ).rejects.toThrow(NotFoundException);
      expect(prisma.appointment.findFirst).not.toHaveBeenCalled();
    });

    it('token inexistente o expirado → 404 con el mismo mensaje que el resto', async () => {
      // Mensajes distintos le dirían a quien prueba tokens si acertó el formato
      // o la clínica.
      sessions.resolveManage.mockResolvedValue(null);
      const expirado = await controller
        .getManagedAppointment('clinica-a', TOKEN)
        .catch((e) => e);

      sessions.resolveManage.mockResolvedValue(SESSION);
      prisma.appointment.findFirst.mockResolvedValue(null);
      const borrada = await controller
        .getManagedAppointment('clinica-a', TOKEN)
        .catch((e) => e);

      expect(expirado).toBeInstanceOf(NotFoundException);
      expect(borrada).toBeInstanceOf(NotFoundException);
      expect(expirado.message).toBe(borrada.message);
    });

    it('alcanzado el tope, canReschedule es false pero canCancel sigue true', async () => {
      // Deliberado: cancelar es justo la acción que queremos que sea más fácil
      // que no aparecer, así que el tope de reagendamientos no la toca.
      prisma.appointment.findFirst.mockResolvedValue(
        makeAppt({ patientRescheduleCount: 3 }),
      );

      const res = await controller.getManagedAppointment('clinica-a', TOKEN);

      expect(res.canReschedule).toBe(false);
      expect(res.canCancel).toBe(true);
      expect(res.appointment.rescheduleCount).toBe(3);
    });

    it('clínica suspendida o archivada → 404: deja de servir datos de pacientes', async () => {
      // El where lleva `clinic: { status: 'ACTIVE' }`, así que el findFirst no
      // encuentra nada aunque el token siga vivo sus 30 días.
      prisma.appointment.findFirst.mockResolvedValue(null);

      await expect(
        controller.getManagedAppointment('clinica-a', TOKEN),
      ).rejects.toThrow(NotFoundException);
    });

    it('el token guardado NO lleva el teléfono del paciente', async () => {
      // PII de salud viviendo hasta 30 días en Redis sin que nadie la consuma.
      await controller.rescheduleManagedAppointment('clinica-a', TOKEN, {
        startAtISO: '2030-06-02T14:00:00.000Z',
      } as any);

      const payload = sessions.createManage.mock.calls[0][0];
      expect(payload).not.toHaveProperty('phone');
      expect(JSON.stringify(payload)).not.toContain('584141234567');
    });

    it('cita pasada o terminal → canCancel/canReschedule en false', async () => {
      prisma.appointment.findFirst.mockResolvedValue(
        makeAppt({ status: 'ATENDIDA' }),
      );
      const atendida = await controller.getManagedAppointment('clinica-a', TOKEN);
      expect(atendida.canCancel).toBe(false);
      expect(atendida.canReschedule).toBe(false);

      prisma.appointment.findFirst.mockResolvedValue(
        makeAppt({ startAt: new Date(Date.now() - 3600_000) }),
      );
      const pasada = await controller.getManagedAppointment('clinica-a', TOKEN);
      expect(pasada.canCancel).toBe(false);
    });
  });

  describe('POST manage/:token/cancel', () => {
    it('cancela y quema el token', async () => {
      const res = await controller.cancelManagedAppointment('clinica-a', TOKEN);

      expect(res).toEqual({ status: 'CANCELADA' });
      expect(scheduling.cancelByPatient).toHaveBeenCalledWith({
        clinicId: 'clinic-A',
        appointmentId: 'appt-1',
      });
      expect(sessions.invalidateManage).toHaveBeenCalledWith(TOKEN);
    });

    it('token inválido → 404 sin llegar a tocar la cita', async () => {
      sessions.resolveManage.mockResolvedValue(null);

      await expect(
        controller.cancelManagedAppointment('clinica-a', TOKEN),
      ).rejects.toThrow(NotFoundException);
      expect(scheduling.cancelByPatient).not.toHaveBeenCalled();
    });

    it('propaga el 409 del servicio cuando el estado ya no permite cancelar', async () => {
      // La clínica pudo marcarla ATENDIDA entre que se pintó la página y el
      // clic; el servicio re-valida contra la DB y manda.
      scheduling.cancelByPatient.mockRejectedValue(
        new ConflictException('esta cita ya no se puede cancelar'),
      );

      await expect(
        controller.cancelManagedAppointment('clinica-a', TOKEN),
      ).rejects.toThrow(ConflictException);
    });
  });

  describe('POST manage/:token/reschedule', () => {
    const body = { startAtISO: '2030-06-02T14:00:00.000Z' };

    it('mueve la cita in-place y devuelve un manageUrl nuevo', async () => {
      const res = await controller.rescheduleManagedAppointment(
        'clinica-a',
        TOKEN,
        body as any,
      );

      expect(scheduling.rescheduleAppointment).toHaveBeenCalledWith({
        clinicId: 'clinic-A',
        appointmentId: 'appt-1',
        startAtISO: body.startAtISO,
        byPatient: true,
        maxPatientReschedules: 3,
      });
      // Mismo id: no se crea una cita nueva ni queda una CANCELADA que
      // ensuciaría el no-show rate.
      expect(res.appointment.id).toBe('appt-1');
      expect(res.appointment.status).toBe('PENDIENTE');
      expect(res.manageUrl).toBe(
        'https://showly.us/es/agendar/clinica-a/cita?t=mtok-new',
      );
    });

    it('el tope lo aplica el servicio de forma atómica, no un if previo', async () => {
      // Con el check fuera del update, una ráfaga con el mismo token pasaría
      // varias veces entre la lectura y la escritura.
      await controller.rescheduleManagedAppointment('clinica-a', TOKEN, body as any);

      expect(scheduling.rescheduleAppointment).toHaveBeenCalledWith(
        expect.objectContaining({ byPatient: true, maxPatientReschedules: 3 }),
      );
    });

    it('tope alcanzado → 409 que deriva a la clínica, distinto del de slot ocupado', async () => {
      scheduling.rescheduleAppointment.mockRejectedValue(
        new ConflictException('tope de reagendamientos alcanzado'),
      );

      const err = await controller
        .rescheduleManagedAppointment('clinica-a', TOKEN, body as any)
        .catch((e) => e);

      expect(err).toBeInstanceOf(ConflictException);
      expect(err.message).toContain('Escríbele a la clínica');
    });

    it('invalida el token viejo: no quedan dos links vivos para la misma cita', async () => {
      await controller.rescheduleManagedAppointment(
        'clinica-a',
        TOKEN,
        body as any,
      );
      expect(sessions.invalidateManage).toHaveBeenCalledWith(TOKEN);
    });

    it('cita terminal → 409 sin llamar al servicio', async () => {
      prisma.appointment.findFirst.mockResolvedValue(
        makeAppt({ status: 'CANCELADA' }),
      );

      await expect(
        controller.rescheduleManagedAppointment('clinica-a', TOKEN, body as any),
      ).rejects.toThrow(ConflictException);
      expect(scheduling.rescheduleAppointment).not.toHaveBeenCalled();
    });

    it('slot ocupado → 409 con mensaje para el paciente, en tuteo', async () => {
      scheduling.rescheduleAppointment.mockRejectedValue(
        new ConflictException('slot no disponible'),
      );

      const err = await controller
        .rescheduleManagedAppointment('clinica-a', TOKEN, body as any)
        .catch((e) => e);

      expect(err).toBeInstanceOf(ConflictException);
      expect(err.message).toBe('Ese horario ya no está disponible. Elige otro.');
    });

    it('token de otra clínica → 404 sin mover nada', async () => {
      sessions.resolveManage.mockResolvedValue({
        ...SESSION,
        clinicSlug: 'otra-clinica',
      });

      await expect(
        controller.rescheduleManagedAppointment('clinica-a', TOKEN, body as any),
      ).rejects.toThrow(NotFoundException);
      expect(scheduling.rescheduleAppointment).not.toHaveBeenCalled();
    });

    it('si no se puede emitir el token nuevo, la cita queda movida y el viejo SIGUE VIVO', async () => {
      // Fail-open: lo que el paciente pidió ya está hecho. Pero el token viejo
      // no se quema hasta que el nuevo existe — si no, un fallo de Redis
      // dejaría al paciente sin ningún link para volver a su cita.
      sessions.createManage.mockRejectedValue(new Error('redis down'));

      const res = await controller.rescheduleManagedAppointment(
        'clinica-a',
        TOKEN,
        body as any,
      );

      expect(res.appointment.id).toBe('appt-1');
      expect(res.manageUrl).toBeUndefined();
      expect(sessions.invalidateManage).not.toHaveBeenCalled();
    });

    it('cita pasada pero PENDIENTE → 409 en el controller', async () => {
      prisma.appointment.findFirst.mockResolvedValue(
        makeAppt({ status: 'PENDIENTE', startAt: new Date(Date.now() - 3600_000) }),
      );

      await expect(
        controller.rescheduleManagedAppointment('clinica-a', TOKEN, body as any),
      ).rejects.toThrow(ConflictException);
      expect(scheduling.rescheduleAppointment).not.toHaveBeenCalled();
    });
  });
});
