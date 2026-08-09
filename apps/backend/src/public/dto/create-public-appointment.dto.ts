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

/**
 * DTO del endpoint público de agendamiento.
 *
 * Notas de diseño:
 * - `phone` en E.164 (con o sin `+` inicial). No aceptamos separadores.
 * - `consent` DEBE ser true — es un requisito de LGPD/GDPR para datos de salud.
 *   Si viene false o falta, el `ValidationPipe` global tira 400.
 * - `honeypot` es un campo trampa. Si viene con cualquier valor, el controller
 *   responde 200 sin crear nada (así no señalizamos al bot que lo detectamos).
 * - Los `serviceId`/`professionalId` no los validamos con @IsCUID (no lo trae
 *   class-validator por default); el chequeo de tenant lo hace SchedulingService.
 */
export class CreatePublicAppointmentDto {
  /** E.164 con o sin `+` inicial. Longitud 8–15. */
  @IsString()
  @Matches(/^\+?[1-9]\d{7,14}$/, {
    message: 'phone debe estar en formato E.164 (ej: +584141234567)',
  })
  phone!: string;

  @IsString()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @MinLength(2)
  @MaxLength(80)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;

  @IsBoolean()
  @Equals(true, { message: 'consent debe ser true' })
  consent!: boolean;

  @IsString()
  @MinLength(1)
  serviceId!: string;

  @IsString()
  @MinLength(1)
  professionalId!: string;

  @IsISO8601()
  startAtISO!: string;

  /**
   * Honeypot invisible en el frontend. Los bots suelen llenar TODOS los inputs,
   * incluyendo los hidden. Si llega con valor, la request no se procesa.
   * Debe ser opcional para que un humano legítimo no falle si por alguna razón
   * el input existe pero está vacío.
   */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  honeypot?: string;
}
