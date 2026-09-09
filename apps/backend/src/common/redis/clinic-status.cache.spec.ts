import { PrismaService } from '../../prisma/prisma.service';
import { ClinicStatusCache } from './clinic-status.cache';

describe('ClinicStatusCache', () => {
  let prisma: { clinic: { findUnique: jest.Mock } };
  let redis: { get: jest.Mock; set: jest.Mock; del: jest.Mock };
  let cache: ClinicStatusCache;

  beforeEach(() => {
    prisma = { clinic: { findUnique: jest.fn().mockResolvedValue({ status: 'ACTIVE' }) } };
    redis = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue('OK'),
      del: jest.fn().mockResolvedValue(1),
    };
    cache = new ClinicStatusCache(prisma as unknown as PrismaService, redis as any);
  });

  it('miss: va a DB y cachea el status con TTL 60', async () => {
    await expect(cache.isActive('c1')).resolves.toBe(true);
    expect(prisma.clinic.findUnique).toHaveBeenCalledWith({
      where: { id: 'c1' },
      select: { status: true },
    });
    expect(redis.set).toHaveBeenCalledWith('clinic:status:c1', 'ACTIVE', 'EX', 60);
  });

  it('hit: no va a DB', async () => {
    redis.get.mockResolvedValueOnce('SUSPENDED');
    await expect(cache.isActive('c1')).resolves.toBe(false);
    expect(prisma.clinic.findUnique).not.toHaveBeenCalled();
  });

  it('Redis falla → fail-closed: consulta DB directo', async () => {
    redis.get.mockRejectedValueOnce(new Error('redis down'));
    prisma.clinic.findUnique.mockResolvedValueOnce({ status: 'SUSPENDED' });
    await expect(cache.isActive('c1')).resolves.toBe(false);
    expect(prisma.clinic.findUnique).toHaveBeenCalledTimes(1);
  });

  it('clínica inexistente → false', async () => {
    prisma.clinic.findUnique.mockResolvedValueOnce(null);
    await expect(cache.isActive('nope')).resolves.toBe(false);
  });

  it('invalidate borra la clave', async () => {
    await cache.invalidate('c1');
    expect(redis.del).toHaveBeenCalledWith('clinic:status:c1');
  });
});
