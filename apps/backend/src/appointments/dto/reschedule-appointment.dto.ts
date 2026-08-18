import { IsISO8601 } from 'class-validator';

/**
 * DTO para `PATCH /api/appointments/:id/reschedule`. Solo se cambia el instante
 * de inicio — el service, professional y patient siguen iguales. Para cambiar
 * paciente/servicio/profesional: cancelar y crear cita nueva.
 */
export class RescheduleAppointmentDto {
  @IsISO8601()
  startAtISO!: string;
}
