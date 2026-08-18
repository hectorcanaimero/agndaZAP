import { BadRequestException, NotFoundException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { AdminAction } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AdminAuditService } from './admin-audit.service';
import { ImpersonationService } from './impersonation.service';

/**
 * Tests de ImpersonationService — foco en seguridad (ADR 0014).
 *
 * Cubre:
 *  - Firma del JWT con TODOS los claims correctos (sub, clinicId, role,
 *    impersonatedBy) usando `JwtService` real (no mock de la firma).
 *  - TTL de 30min → `exp - iat ≈ 1800`.
 *  - Gate de status: NotFound si la clínica no existe, BadRequest si
 *    está SUSPENDED o ARCHIVED.
 *  - Persistencia del audit con `START_IMPERSONATION` y metadata correcta.
 *  - Orden: audit se llama ANTES de retornar; si falla, se propaga.
 */
describe('ImpersonationService', () => {
  let prismaStub: { clinic: { findUnique: jest.Mock } };
  let jwt: JwtService;
  let audit: { logAction: jest.Mock };
  let service: ImpersonationService;

  const SECRET = 'test-impersonation-secret';

  const activeClinic = {
    id: 'clinic-Z',
    name: 'Clínica Zeta',
    slug: 'clinica-zeta',
    status: 'ACTIVE' as const,
  };

  beforeEach(() => {
    prismaStub = {
      clinic: {
        findUnique: jest.fn().mockResolvedValue(activeClinic),
      },
    };
    // JwtService real. Así verificamos EL PAYLOAD FIRMADO, no la impl del
    // mock. Si migramos a RS256 / otra lib, este test se rompe.
    jwt = new JwtService({
      secret: SECRET,
      signOptions: { expiresIn: '24h', algorithm: 'HS256' },
    });
    audit = { logAction: jest.fn().mockResolvedValue({ id: 'audit-1' }) };
    service = new ImpersonationService(
      prismaStub as unknown as PrismaService,
      jwt,
      audit as unknown as AdminAuditService,
    );
  });

  it('firma un JWT con sub=actor, clinicId=target, role=CLINIC_ADMIN, impersonatedBy=actor', async () => {
    const result = await service.createImpersonationToken({
      actorUserId: 'user-super-1',
      targetClinicId: 'clinic-Z',
    });

    const decoded = jwt.verify<{
      sub: string;
      clinicId: string;
      role: string;
      impersonatedBy: string;
      iat: number;
      exp: number;
    }>(result.token, { secret: SECRET });

    expect(decoded.sub).toBe('user-super-1');
    expect(decoded.clinicId).toBe('clinic-Z');
    expect(decoded.role).toBe('CLINIC_ADMIN');
    expect(decoded.impersonatedBy).toBe('user-super-1');
  });

  it('el JWT tiene TTL ~30min (override del default de 24h del module)', async () => {
    const result = await service.createImpersonationToken({
      actorUserId: 'user-super-1',
      targetClinicId: 'clinic-Z',
    });

    const decoded = jwt.verify<{ iat: number; exp: number }>(result.token, {
      secret: SECRET,
    });

    // Margen de 5s para variabilidad de reloj / CPU en CI.
    const ttlSeconds = decoded.exp - decoded.iat;
    expect(ttlSeconds).toBeGreaterThanOrEqual(30 * 60 - 5);
    expect(ttlSeconds).toBeLessThanOrEqual(30 * 60 + 5);
  });

  it('response.expiresAt está ~30min en el futuro', async () => {
    const before = Date.now();
    const result = await service.createImpersonationToken({
      actorUserId: 'user-super-1',
      targetClinicId: 'clinic-Z',
    });
    const after = Date.now();

    const expected = 30 * 60 * 1000;
    expect(result.expiresAt.getTime()).toBeGreaterThanOrEqual(before + expected - 100);
    expect(result.expiresAt.getTime()).toBeLessThanOrEqual(after + expected + 100);
  });

  it('devuelve metadata mínima de la clínica (id, name, slug) sin PII extra', async () => {
    const result = await service.createImpersonationToken({
      actorUserId: 'user-super-1',
      targetClinicId: 'clinic-Z',
    });

    expect(result.clinic).toEqual({
      id: 'clinic-Z',
      name: 'Clínica Zeta',
      slug: 'clinica-zeta',
    });
    // No filtramos status / timezone / etc.
    expect(Object.keys(result.clinic).sort()).toEqual(['id', 'name', 'slug']);
  });

  it('clínica inexistente → NotFoundException + NO firma token ni audita', async () => {
    prismaStub.clinic.findUnique.mockResolvedValueOnce(null);
    const jwtSpy = jest.spyOn(jwt, 'signAsync');

    await expect(
      service.createImpersonationToken({
        actorUserId: 'user-super-1',
        targetClinicId: 'clinic-fantasma',
      }),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(jwtSpy).not.toHaveBeenCalled();
    expect(audit.logAction).not.toHaveBeenCalled();
  });

  it('clínica SUSPENDED → BadRequestException con copy explícito + NO firma ni audita', async () => {
    prismaStub.clinic.findUnique.mockResolvedValueOnce({
      ...activeClinic,
      status: 'SUSPENDED',
    });
    const jwtSpy = jest.spyOn(jwt, 'signAsync');

    await expect(
      service.createImpersonationToken({
        actorUserId: 'user-super-1',
        targetClinicId: 'clinic-Z',
      }),
    ).rejects.toMatchObject({
      status: 400,
      message: expect.stringContaining('suspendida'),
    });

    expect(jwtSpy).not.toHaveBeenCalled();
    expect(audit.logAction).not.toHaveBeenCalled();
  });

  it('clínica ARCHIVED → BadRequestException + NO firma ni audita', async () => {
    prismaStub.clinic.findUnique.mockResolvedValueOnce({
      ...activeClinic,
      status: 'ARCHIVED',
    });

    await expect(
      service.createImpersonationToken({
        actorUserId: 'user-super-1',
        targetClinicId: 'clinic-Z',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(audit.logAction).not.toHaveBeenCalled();
  });

  it('persiste audit START_IMPERSONATION con targetType=Clinic, targetId, ip y userAgent', async () => {
    await service.createImpersonationToken({
      actorUserId: 'user-super-1',
      targetClinicId: 'clinic-Z',
      ip: '203.0.113.7',
      userAgent: 'ShowlyAdmin/1.0',
    });

    expect(audit.logAction).toHaveBeenCalledTimes(1);
    expect(audit.logAction).toHaveBeenCalledWith({
      actorUserId: 'user-super-1',
      action: AdminAction.START_IMPERSONATION,
      targetType: 'Clinic',
      targetId: 'clinic-Z',
      metadata: { targetClinicSlug: 'clinica-zeta' },
      ip: '203.0.113.7',
      userAgent: 'ShowlyAdmin/1.0',
    });
  });

  it('si el audit falla, el error se propaga y el caller ve el fallo', async () => {
    audit.logAction.mockRejectedValueOnce(new Error('DB unavailable'));

    await expect(
      service.createImpersonationToken({
        actorUserId: 'user-super-1',
        targetClinicId: 'clinic-Z',
      }),
    ).rejects.toThrow('DB unavailable');
  });

  it('select en Prisma trae SOLO id/name/slug/status (no filtra PII)', async () => {
    await service.createImpersonationToken({
      actorUserId: 'user-super-1',
      targetClinicId: 'clinic-Z',
    });

    expect(prismaStub.clinic.findUnique).toHaveBeenCalledWith({
      where: { id: 'clinic-Z' },
      select: { id: true, name: true, slug: true, status: true },
    });
  });
});
