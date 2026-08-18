import { AdminAction } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AdminAuditService } from './admin-audit.service';

// Minimal prisma stub — sólo los métodos que AdminAuditService usa.
type PrismaStub = {
  adminAudit: { create: jest.Mock };
};

describe('AdminAuditService.logAction', () => {
  let prismaStub: PrismaStub;
  let service: AdminAuditService;

  const baseInput = {
    actorUserId: 'user-superadmin-1',
    action: AdminAction.SUSPEND_CLINIC,
    targetType: 'Clinic',
    targetId: 'clinic-42',
  };

  const fakeRecord = {
    id: 'audit-1',
    actorUserId: baseInput.actorUserId,
    action: baseInput.action,
    targetType: baseInput.targetType,
    targetId: baseInput.targetId,
    metadata: null,
    ip: null,
    userAgent: null,
    createdAt: new Date('2026-08-14T12:00:00Z'),
  };

  beforeEach(() => {
    prismaStub = {
      adminAudit: {
        create: jest.fn().mockResolvedValue(fakeRecord),
      },
    };

    service = new AdminAuditService(prismaStub as unknown as PrismaService);
  });

  it('persiste el registro con todos los campos obligatorios', async () => {
    const result = await service.logAction(baseInput);

    expect(prismaStub.adminAudit.create).toHaveBeenCalledWith({
      data: {
        actorUserId: baseInput.actorUserId,
        action: baseInput.action,
        targetType: baseInput.targetType,
        targetId: baseInput.targetId,
        metadata: undefined,
        ip: null,
        userAgent: null,
        impersonatedBy: null,
      },
    });
    expect(result.id).toBe('audit-1');
  });

  it('persiste metadata cuando se provee', async () => {
    const metadata = { reason: 'fraude detectado', ticket: 'INC-007' };
    prismaStub.adminAudit.create.mockResolvedValueOnce({ ...fakeRecord, metadata });

    await service.logAction({ ...baseInput, metadata });

    const callData = prismaStub.adminAudit.create.mock.calls[0][0];
    expect(callData.data.metadata).toEqual(metadata);
  });

  it('persiste ip y userAgent cuando se proveen', async () => {
    const ip = '203.0.113.42';
    const userAgent = 'Mozilla/5.0 (compatible; ShowlyAdmin/1.0)';
    prismaStub.adminAudit.create.mockResolvedValueOnce({ ...fakeRecord, ip, userAgent });

    const result = await service.logAction({ ...baseInput, ip, userAgent });

    const callData = prismaStub.adminAudit.create.mock.calls[0][0];
    expect(callData.data.ip).toBe(ip);
    expect(callData.data.userAgent).toBe(userAgent);
    expect(result.ip).toBe(ip);
    expect(result.userAgent).toBe(userAgent);
  });

  it('propaga el error de Prisma sin swallowear', async () => {
    prismaStub.adminAudit.create.mockRejectedValueOnce(new Error('DB connection lost'));

    await expect(service.logAction(baseInput)).rejects.toThrow('DB connection lost');
  });

  it('retorna el registro creado completo (incluye id + createdAt)', async () => {
    const result = await service.logAction(baseInput);

    expect(result).toMatchObject({
      id: 'audit-1',
      actorUserId: baseInput.actorUserId,
      action: baseInput.action,
      targetType: baseInput.targetType,
      targetId: baseInput.targetId,
    });
    expect(result.createdAt).toBeInstanceOf(Date);
  });
});

// ─── AdminAuditService.list ────────────────────────────────────────────────

type PrismaListStub = {
  adminAudit: {
    findMany: jest.Mock;
    count: jest.Mock;
  };
  $transaction: jest.Mock;
};

describe('AdminAuditService.list', () => {
  let prismaStub: PrismaListStub;
  let service: AdminAuditService;

  const fakeActor = { id: 'u-1', email: 'super@showly.io', name: 'Super Admin' };
  const makeAudit = (overrides: Record<string, unknown> = {}) => ({
    id: 'audit-1',
    actorUserId: 'u-1',
    action: AdminAction.SUSPEND_CLINIC,
    targetType: 'Clinic',
    targetId: 'clinic-42',
    metadata: null,
    ip: null,
    userAgent: null,
    createdAt: new Date('2026-08-14T12:00:00Z'),
    actor: fakeActor,
    ...overrides,
  });

  const setupStub = (items: unknown[], total: number) => {
    prismaStub = {
      adminAudit: {
        findMany: jest.fn(),
        count: jest.fn(),
      },
      $transaction: jest.fn().mockResolvedValue([items, total]),
    };
    service = new AdminAuditService(prismaStub as unknown as PrismaService);
  };

  beforeEach(() => {
    setupStub([makeAudit()], 1);
  });

  it('devuelve items + total + page + pageSize por defecto (page=1, pageSize=50)', async () => {
    const result = await service.list({});

    expect(result.page).toBe(1);
    expect(result.pageSize).toBe(50);
    expect(result.total).toBe(1);
    expect(result.items).toHaveLength(1);
    expect(result.items[0].actor).toEqual(fakeActor);
  });

  it('aplica filtro actorUserId en el where', async () => {
    await service.list({ actorUserId: 'u-99' });

    const [findManyCall] = prismaStub.$transaction.mock.calls[0][0];
    // $transaction recibe un array de promesas; verificamos que el query correcto se construyó
    // Inspeccionamos directamente el stub de findMany a través del mock de $transaction.
    // Como $transaction es un mock que resuelve directamente, verificamos la llamada
    // inspeccionando el where construido internamente pasando por el stub.
    // Usamos un enfoque más robusto: sobreescribimos $transaction para capturar el where.
    const capturedWheres: unknown[] = [];
    prismaStub.$transaction = jest.fn().mockImplementation(
      async (fns: Array<Promise<unknown>>) => {
        // Las promesas ya se armaron, no podemos inspeccionar el where directamente.
        // En cambio, usamos una instancia fresh con findMany espía.
        return [[], 0];
      },
    );

    const spyFindMany = jest.fn().mockResolvedValue([]);
    const spyCount = jest.fn().mockResolvedValue(0);
    const freshPrisma = {
      adminAudit: { findMany: spyFindMany, count: spyCount },
      $transaction: jest.fn().mockImplementation(async (ops: Array<Promise<unknown>>) => {
        return Promise.all(ops);
      }),
    };
    const freshService = new AdminAuditService(freshPrisma as unknown as PrismaService);

    await freshService.list({ actorUserId: 'u-99' });

    expect(spyFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ actorUserId: 'u-99' }),
      }),
    );
    expect(spyCount).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ actorUserId: 'u-99' }) }),
    );

    void capturedWheres;
    void findManyCall;
  });

  it('aplica filtros combinados (action + targetType + targetId)', async () => {
    const spyFindMany = jest.fn().mockResolvedValue([]);
    const spyCount = jest.fn().mockResolvedValue(0);
    const freshPrisma = {
      adminAudit: { findMany: spyFindMany, count: spyCount },
      $transaction: jest.fn().mockImplementation(async (ops: Array<Promise<unknown>>) =>
        Promise.all(ops),
      ),
    };
    const freshService = new AdminAuditService(freshPrisma as unknown as PrismaService);

    await freshService.list({
      action: AdminAction.ARCHIVE_CLINIC,
      targetType: 'Clinic',
      targetId: 'clinic-7',
    });

    expect(spyFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          action: AdminAction.ARCHIVE_CLINIC,
          targetType: 'Clinic',
          targetId: 'clinic-7',
        }),
      }),
    );
  });

  it('calcula skip correcto para paginación (page=3, pageSize=10 → skip=20)', async () => {
    const spyFindMany = jest.fn().mockResolvedValue([]);
    const freshPrisma = {
      adminAudit: { findMany: spyFindMany, count: jest.fn().mockResolvedValue(0) },
      $transaction: jest.fn().mockImplementation(async (ops: Array<Promise<unknown>>) =>
        Promise.all(ops),
      ),
    };
    const freshService = new AdminAuditService(freshPrisma as unknown as PrismaService);

    const result = await freshService.list({ page: 3, pageSize: 10 });

    expect(spyFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 20, take: 10 }),
    );
    expect(result.page).toBe(3);
    expect(result.pageSize).toBe(10);
  });

  it('ordena por createdAt desc', async () => {
    const spyFindMany = jest.fn().mockResolvedValue([]);
    const freshPrisma = {
      adminAudit: { findMany: spyFindMany, count: jest.fn().mockResolvedValue(0) },
      $transaction: jest.fn().mockImplementation(async (ops: Array<Promise<unknown>>) =>
        Promise.all(ops),
      ),
    };
    const freshService = new AdminAuditService(freshPrisma as unknown as PrismaService);

    await freshService.list({});

    expect(spyFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: { createdAt: 'desc' } }),
    );
  });

  it('capa pageSize a 200 cuando se pasa un valor mayor', async () => {
    const spyFindMany = jest.fn().mockResolvedValue([]);
    const freshPrisma = {
      adminAudit: { findMany: spyFindMany, count: jest.fn().mockResolvedValue(0) },
      $transaction: jest.fn().mockImplementation(async (ops: Array<Promise<unknown>>) =>
        Promise.all(ops),
      ),
    };
    const freshService = new AdminAuditService(freshPrisma as unknown as PrismaService);

    const result = await freshService.list({ pageSize: 9999 });

    expect(spyFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 200 }),
    );
    expect(result.pageSize).toBe(200);
  });

  it('sin filtros → where vacío (trae todo)', async () => {
    const spyFindMany = jest.fn().mockResolvedValue([]);
    const freshPrisma = {
      adminAudit: { findMany: spyFindMany, count: jest.fn().mockResolvedValue(0) },
      $transaction: jest.fn().mockImplementation(async (ops: Array<Promise<unknown>>) =>
        Promise.all(ops),
      ),
    };
    const freshService = new AdminAuditService(freshPrisma as unknown as PrismaService);

    await freshService.list({});

    expect(spyFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: {} }),
    );
  });
});
