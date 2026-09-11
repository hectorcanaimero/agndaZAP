import { ConflictException } from '@nestjs/common';
import {
  RescheduleLimitExceededException,
  SchedulingConflictException,
  SlotTakenException,
  SCHEDULING_ERROR_CODES,
} from './scheduling.errors';

/**
 * Estos errores existen porque `rescheduleAppointment` puede fallar con 409 por
 * dos motivos que piden respuestas OPUESTAS: "el horario se ocupó" invita a
 * elegir otro, "ya cambiaste demasiadas veces" invita a hablar con la clínica.
 *
 * La primera versión los separaba comparando el texto del mensaje. Estos tests
 * fijan que esa dependencia desapareció.
 */
describe('errores de agendamiento', () => {
  it('siguen siendo 409: nada del manejo existente cambia', () => {
    // Importa: quien ya capturaba `ConflictException` se comporta igual, y el
    // status HTTP no se mueve.
    for (const e of [
      new RescheduleLimitExceededException(),
      new SlotTakenException(),
    ]) {
      expect(e).toBeInstanceOf(ConflictException);
      expect(e).toBeInstanceOf(SchedulingConflictException);
      expect(e.getStatus()).toBe(409);
    }
  });

  it('el código viaja en el cuerpo, que es lo que mira el cliente', () => {
    expect(new RescheduleLimitExceededException().getResponse()).toMatchObject({
      statusCode: 409,
      code: SCHEDULING_ERROR_CODES.RESCHEDULE_LIMIT,
    });
    expect(new SlotTakenException().getResponse()).toMatchObject({
      statusCode: 409,
      code: SCHEDULING_ERROR_CODES.SLOT_TAKEN,
    });
  });

  it('se distinguen por tipo sin mirar el mensaje', () => {
    const limite: unknown = new RescheduleLimitExceededException();
    const slot: unknown = new SlotTakenException();

    expect(limite instanceof RescheduleLimitExceededException).toBe(true);
    expect(slot instanceof RescheduleLimitExceededException).toBe(false);
  });

  it('el mensaje se puede reescribir sin romper la distinción', () => {
    // Es el punto de todo esto: el copy cambia con cada pasada de tono o de
    // traducción, y antes eso rompía la lógica en silencio.
    const e = new RescheduleLimitExceededException(
      'Texto completamente distinto, en otro idioma incluso.',
    );

    expect(e).toBeInstanceOf(RescheduleLimitExceededException);
    expect(e.code).toBe(SCHEDULING_ERROR_CODES.RESCHEDULE_LIMIT);
    expect(e.getResponse()).toMatchObject({ code: 'RESCHEDULE_LIMIT' });
  });

  it('expone `code` también como propiedad, para el backend', () => {
    // El cliente mira el cuerpo; el backend puede mirar la propiedad sin
    // deserializar la respuesta.
    expect(new SlotTakenException().code).toBe('SLOT_TAKEN');
  });
});
