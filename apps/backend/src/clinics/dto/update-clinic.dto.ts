import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
  MaxLength,
  MinLength,
  IsIn,
} from 'class-validator';
import { Transform } from 'class-transformer';

/**
 * DTO para `PATCH /api/clinics/me`.
 *
 * NO exponemos `slug` acá — cambiar el slug rompe URLs públicas del
 * agendamiento + WAHA session name + links repartidos. Se cambia por CLI/DB.
 * `wahaSession`, `wahaConnected` también quedan fuera — se gestionan desde
 * `/panel/whatsapp`.
 *
 * TODOS los campos son opcionales (`@IsOptional`) — el operador puede
 * mandar patches parciales por sección (General / Recordatorios / Bot).
 * Con `forbidNonWhitelisted: true` en el ValidationPipe global, cualquier
 * campo extra (ej. `slug`, `id`) es rechazado.
 */
export class UpdateClinicDto {
  /* ─── General ─── */

  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  address?: string;

  /**
   * IANA timezone (ej. "America/Caracas", "America/Sao_Paulo"). Validamos
   * con `Intl.supportedValuesOf('timeZone')` en el pipe custom — pero el
   * runtime Node no siempre trae esa lista completa. Fallback simple:
   * comprobar que `Intl.DateTimeFormat` no explote con el value.
   */
  @IsOptional()
  @IsString()
  @MaxLength(60)
  @Transform(({ value }: { value: unknown }) => {
    if (typeof value !== 'string') return value;
    try {
      new Intl.DateTimeFormat('en', { timeZone: value });
      return value;
    } catch {
      throw new Error('timezone inválida (usar formato IANA, ej. America/Caracas)');
    }
  })
  timezone?: string;

  @IsOptional()
  @IsIn(['es', 'pt'], { message: 'locale debe ser "es" o "pt"' })
  locale?: string;

  @IsOptional()
  @IsBoolean()
  autoConfirm?: boolean;

  /* ─── Recordatorios ─── */

  /**
   * Horas antes de la cita en las que dispara cada recordatorio.
   * Máx 5 offsets, entre 1h y 168h (7 días). Enteros positivos.
   */
  @IsOptional()
  @IsArray()
  @ArrayMinSize(0)
  @ArrayMaxSize(5)
  @IsInt({ each: true })
  @Min(1, { each: true })
  @Max(168, { each: true })
  reminderOffsetsH?: number[];

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(72)
  confirmThresholdH?: number;

  /* ─── Bot ─── */

  @IsOptional()
  @IsString()
  @MaxLength(500)
  botGreeting?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  botFallback?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  botHandoffMsg?: string;

  /** "formal" | "cercano" | "tecnico" — inyectado al system prompt del LLM. */
  @IsOptional()
  @IsIn(['formal', 'cercano', 'tecnico'], {
    message: 'botTone debe ser "formal", "cercano" o "tecnico"',
  })
  botTone?: string;
}
