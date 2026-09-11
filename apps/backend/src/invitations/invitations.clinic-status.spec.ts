import {
  ConflictException,
  GoneException,
  NotFoundException,
} from '@nestjs/common';
import { InvitationsService } from './invitations.service';

/**
 * Offboarding (S12): una clínica suspendida por impago o archivada al terminar
 * el contrato no puede seguir dando acceso a gente nueva.
 *
 * El `accept` se comprueba aparte del `getByToken` a propósito: entre ver la
 * pantalla y pulsar el botón la clínica puede haber sido suspendida, y `accept`
 * es el paso que de verdad da acceso (escribe la contraseña).
 */
describe('InvitationsService — clínica no activa', () => {
  const future = new Date(Date.now() + 86_400_000);

  function makeService(clinic: { status: string } | null) {
    const prisma: any = {
      invitation: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'inv-1',
          token: 'tok',
          userId: 'user-1',
          acceptedAt: null,
          expiresAt: future,
          user: {
            email: 'nuevo@clinica.com',
            name: 'Nuevo',
            clinic: clinic ? { name: 'Clínica A', ...clinic } : null,
          },
        }),
        update: jest.fn(),
      },
      user: { update: jest.fn() },
      $transaction: jest.fn().mockResolvedValue([]),
    };
    return { service: new InvitationsService(prisma as any), prisma };
  }

  it.each(['SUSPENDED', 'ARCHIVED'])(
    'getByToken con clínica %s → 404, sin revelar que la invitación existe',
    async (status) => {
      const { service } = makeService({ status });

      await expect(service.getByToken('tok')).rejects.toThrow(
        NotFoundException,
      );
    },
  );

  it.each(['SUSPENDED', 'ARCHIVED'])(
    'accept con clínica %s → 404 y NO escribe la contraseña',
    async (status) => {
      const { service, prisma } = makeService({ status });

      await expect(service.accept('tok', 'Password123!')).rejects.toThrow(
        NotFoundException,
      );
      expect(prisma.$transaction).not.toHaveBeenCalled();
    },
  );

  it('con la clínica ACTIVE la invitación sigue funcionando', async () => {
    const { service, prisma } = makeService({ status: 'ACTIVE' });

    await expect(service.getByToken('tok')).resolves.toBeDefined();
    await service.accept('tok', 'Password123!');
    expect(prisma.$transaction).toHaveBeenCalled();
  });

  it('una invitación sin clínica sigue dando el 409 de siempre, no el 404 nuevo', async () => {
    // Solo se invita a CLINIC_ADMIN, así que un user sin clínica es un estado
    // inválido preexistente. El chequeo de offboarding no debe tragárselo ni
    // cambiarle el código de error.
    const { service } = makeService(null);

    await expect(service.getByToken('tok')).rejects.toThrow(ConflictException);
  });

  it('la invitación expirada sigue dando 410, no 404 (no se confunden casos)', async () => {
    const prisma: any = {
      invitation: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'inv-1',
          acceptedAt: null,
          expiresAt: new Date(Date.now() - 1000),
          user: { email: 'x@y.com', name: 'N', clinic: { name: 'A', status: 'ACTIVE' } },
        }),
      },
    };
    const service = new InvitationsService(prisma as any);

    await expect(service.getByToken('tok')).rejects.toThrow(GoneException);
  });
});
