import { IsISO8601, Matches } from 'class-validator';

/**
 * DTO de `POST /public/clinics/:slug/appointments/manage/:token/reschedule`.
 *
 * Solo lleva el horario nuevo: servicio, profesional y paciente se heredan de
 * la cita que el token identifica. Dejar que el cuerpo los cambiara convertiría
 * el link de gestión en un endpoint de creación sin las validaciones del alta
 * — el paciente podría saltar a otro profesional o a un servicio más caro.
 *
 * La validación real del horario (futuro, dentro de horario, slot libre) la
 * hace `SchedulingService.rescheduleAppointment` contra la TZ de la clínica;
 * acá solo comprobamos que sea un ISO 8601 parseable.
 */
export class RescheduleByTokenDto {
  @IsISO8601(
    { strict: true },
    { message: 'startAtISO debe ser una fecha ISO 8601 válida' },
  )
  // `@IsISO8601` acepta `2030-06-02` a secas, y eso se parsea como medianoche
  // en la TZ de la clínica: no matchea ningún slot y el paciente vería "ese
  // horario ya no está disponible" cuando lo correcto es un 400 por formato.
  @Matches(/T\d{2}:\d{2}/, {
    message: 'startAtISO debe incluir la hora (ej: 2030-06-02T14:00:00Z)',
  })
  startAtISO!: string;
}
