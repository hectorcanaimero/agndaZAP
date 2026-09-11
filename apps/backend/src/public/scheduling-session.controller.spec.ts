import { NotFoundException } from '@nestjs/common';
import { ClinicStatusCache } from '../common/redis/clinic-status.cache';
import { SchedulingSessionService } from '../scheduling/scheduling-session.service';
import { PublicSchedulingSessionController } from './scheduling-session.controller';

/**
 * Hidratación del form desde el link de WhatsApp.
 *
 * El punto delicado es que la respuesta lleva NOMBRE y TELÉFONO del paciente:
 * el token se emitió cuando la clínica estaba activa, pero puede suspenderse
 * después y el token sigue vivo sus 30 minutos.
 */
describe('PublicSchedulingSessionController', () => {
  let sessions: any;
  let clinicStatus: any;
  let controller: PublicSchedulingSessionController;

  const SESSION = {
    conversationId: 'conv-1',
    clinicId: 'clinic-A',
    clinicSlug: 'demo',
    phone: '+584141234567',
    lid: null,
    name: 'Ana Pérez',
    createdAtISO: new Date().toISOString(),
  };

  beforeEach(() => {
    sessions = { resolve: jest.fn().mockResolvedValue(SESSION) };
    clinicStatus = { isActive: jest.fn().mockResolvedValue(true) };
    controller = new PublicSchedulingSessionController(
      sessions as unknown as SchedulingSessionService,
      clinicStatus as unknown as ClinicStatusCache,
    );
  });

  it('hidrata el form con la clínica activa', async () => {
    const res = await controller.getSession('t'.repeat(32));

    expect(res).toEqual({
      clinicSlug: 'demo',
      name: 'Ana Pérez',
      phone: '+584141234567',
      phoneEditable: false,
    });
  });

  it('clínica suspendida o archivada → 404 sin devolver PII del paciente', async () => {
    clinicStatus.isActive.mockResolvedValue(false);

    const err = await controller
      .getSession('t'.repeat(32))
      .catch((e) => e);

    expect(err).toBeInstanceOf(NotFoundException);
    // Ni el nombre ni el teléfono salen en el error.
    expect(JSON.stringify(err.getResponse())).not.toContain('584141234567');
    expect(JSON.stringify(err.getResponse())).not.toContain('Ana');
  });

  it('el estado se comprueba contra el clinicId del token', async () => {
    await controller.getSession('t'.repeat(32));

    expect(clinicStatus.isActive).toHaveBeenCalledWith('clinic-A');
  });

  it('token inexistente → el mismo 404, sin llegar a consultar el estado', async () => {
    sessions.resolve.mockResolvedValue(null);

    await expect(controller.getSession('t'.repeat(32))).rejects.toThrow(
      NotFoundException,
    );
    expect(clinicStatus.isActive).not.toHaveBeenCalled();
  });

  it('conversación @lid: phone null y editable', async () => {
    sessions.resolve.mockResolvedValue({ ...SESSION, phone: null, lid: 'abc' });

    const res = await controller.getSession('t'.repeat(32));

    expect(res.phone).toBeNull();
    expect(res.phoneEditable).toBe(true);
  });
});
