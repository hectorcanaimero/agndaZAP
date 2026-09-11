import { ConflictException } from '@nestjs/common';

/**
 * Códigos de error de agendamiento que el cliente necesita distinguir.
 *
 * Existen porque `rescheduleAppointment` puede fallar con 409 por dos motivos
 * que piden respuestas OPUESTAS: "el horario se ocupó" invita a elegir otro,
 * "ya cambiaste demasiadas veces" invita a hablar con la clínica. Ofrecerle al
 * paciente el selector de horarios cuando lo que necesita es llamar es una mala
 * respuesta, y al revés también.
 *
 * La primera versión los separaba comparando el texto del mensaje. Funcionaba y
 * era frágil por definición: cualquiera que reescribiera el copy —cosa que este
 * repo hace a menudo, por tono o por traducción— rompía la lógica sin que nada
 * fallara en compilación ni en los tests del emisor.
 */
export const SCHEDULING_ERROR_CODES = {
  /** El paciente agotó su cupo de reagendamientos por link. */
  RESCHEDULE_LIMIT: 'RESCHEDULE_LIMIT',
  /** El slot dejó de estar disponible entre que se eligió y se confirmó. */
  SLOT_TAKEN: 'SLOT_TAKEN',
} as const;

export type SchedulingErrorCode =
  (typeof SCHEDULING_ERROR_CODES)[keyof typeof SCHEDULING_ERROR_CODES];

/**
 * 409 con `code` en el cuerpo, para que el cliente ramifique por el código y no
 * por el texto.
 *
 * Sigue siendo `ConflictException`, así que todo el manejo existente —y el
 * status HTTP— no cambia: quien no mire el `code` se comporta igual que antes.
 */
export class SchedulingConflictException extends ConflictException {
  constructor(
    readonly code: SchedulingErrorCode,
    message: string,
  ) {
    super({ statusCode: 409, message, code });
  }
}

/**
 * El paciente agotó su cupo de cambios de horario desde el link.
 *
 * Clase propia además del `code` para que el backend pueda distinguirlo con
 * `instanceof` sin inspeccionar el cuerpo de la respuesta.
 */
export class RescheduleLimitExceededException extends SchedulingConflictException {
  constructor(message = 'tope de reagendamientos alcanzado') {
    super(SCHEDULING_ERROR_CODES.RESCHEDULE_LIMIT, message);
  }
}

/** El slot dejó de estar libre entre que se eligió y se confirmó. */
export class SlotTakenException extends SchedulingConflictException {
  constructor(message = 'slot ya no está disponible') {
    super(SCHEDULING_ERROR_CODES.SLOT_TAKEN, message);
  }
}
