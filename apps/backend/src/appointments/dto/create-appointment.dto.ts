import { Transform } from 'class-transformer';
import {
  Equals,
  IsBoolean,
  IsISO8601,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { stripControlChars } from '../../common/sanitize-text';

/**
 * DTO para crear cita desde el panel (mostrador de la clínica).
 * Reutiliza `SchedulingService.createAppointment` con `source: 'PUBLIC'`.
 * (Ver `SchedulingService.AppointmentSource`; a hoy solo hay 'BOT' y 'PUBLIC'.)
 */
export class CreatePanelAppointmentDto {
  @IsString()
  @Matches(/^\+?[1-9]\d{7,14}$/, {
    message: 'phone debe estar en formato E.164 (ej: +584141234567)',
  })
  phone!: string;

  @IsOptional()
  @IsString()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? stripControlChars(value) : value,
  )
  @MinLength(2)
  @MaxLength(80)
  name?: string;

  /**
   * Consent SIEMPRE obligatorio (no negociable — LGPD/GDPR datos de salud).
   * `@Equals(true)` corta en el ValidationPipe si viene `false` o falta.
   * El rol interno NO otorga consent — se resuelve legalmente por acto del
   * paciente. Ver ADR 0006 §Consent.
   */
  @IsBoolean()
  @Equals(true, { message: 'consent debe ser true' })
  consent!: boolean;

  @IsString()
  serviceId!: string;

  @IsString()
  professionalId!: string;

  @IsISO8601()
  startAtISO!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;
}
