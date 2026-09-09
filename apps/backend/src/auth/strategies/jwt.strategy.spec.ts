import { UnauthorizedException } from '@nestjs/common';
import { ClinicStatusCache } from '../../common/redis/clinic-status.cache';
import { JwtPayload, JwtStrategy } from './jwt.strategy';

/**
 * F1.4.T4: un JWT de impersonation (payload con `impersonatedBy`) debe
 * re-validar en cada request que la clínica sigue ACTIVE. Los tokens de
 * login normal no consultan nada.
 */
describe('JwtStrategy.validate', () => {
  const originalSecret = process.env.JWT_SECRET;
  let clinicStatus: { isActive: jest.Mock };
  let strategy: JwtStrategy;

  const base: JwtPayload = {
    sub: 'user-1',
    clinicId: 'clinic-A',
    role: 'CLINIC_ADMIN',
  };

  beforeEach(() => {
    process.env.JWT_SECRET = 'x'.repeat(48);
    clinicStatus = { isActive: jest.fn().mockResolvedValue(true) };
    strategy = new JwtStrategy(clinicStatus as unknown as ClinicStatusCache);
  });

  afterEach(() => {
    if (originalSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = originalSecret;
  });

  it('token normal (sin impersonatedBy): no consulta el status y devuelve AuthUser', async () => {
    const user = await strategy.validate(base);
    expect(clinicStatus.isActive).not.toHaveBeenCalled();
    expect(user).toEqual({
      userId: 'user-1',
      clinicId: 'clinic-A',
      role: 'CLINIC_ADMIN',
      impersonatedBy: undefined,
    });
  });

  it('impersonation + clínica ACTIVE → pasa y propaga impersonatedBy', async () => {
    const user = await strategy.validate({ ...base, impersonatedBy: 'super-1' });
    expect(clinicStatus.isActive).toHaveBeenCalledWith('clinic-A');
    expect(user.impersonatedBy).toBe('super-1');
  });

  it('impersonation + clínica SUSPENDED → 401', async () => {
    clinicStatus.isActive.mockResolvedValueOnce(false);
    await expect(
      strategy.validate({ ...base, impersonatedBy: 'super-1' }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('impersonation + no se puede verificar (DB caída) → 401 (fail-closed)', async () => {
    clinicStatus.isActive.mockRejectedValueOnce(new Error('db down'));
    await expect(
      strategy.validate({ ...base, impersonatedBy: 'super-1' }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
