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
  Matches,
  ValidateIf,
} from 'class-validator';
import { Transform } from 'class-transformer';

/**
 * Whitelist de códigos ISO 4217 aceptados como `currency` para una clínica.
 * Cubre las monedas de LATAM + majors (USD, EUR) — el foco del producto es
 * LATAM, así que preferimos rechazar tipos como "BTC" o typos ("USDT") a
 * dejar entrar cualquier string de 3 letras.
 *
 * Nota: se exporta como const readonly para que el frontend eventualmente
 * pueda mirrorearla. NO se importa cross-package — es duplicación consciente.
 */
export const ALLOWED_CURRENCIES = [
  'ARS', // Argentina
  'BOB', // Bolivia
  'BRL', // Brasil
  'CLP', // Chile
  'COP', // Colombia
  'CRC', // Costa Rica
  'DOP', // República Dominicana
  'EUR', // Eurozona (fallback internacional)
  'GTQ', // Guatemala
  'HNL', // Honduras
  'MXN', // México
  'NIO', // Nicaragua
  'PAB', // Panamá (aunque usa USD de facto)
  'PEN', // Perú
  'PYG', // Paraguay
  'USD', // Estados Unidos + Ecuador + El Salvador + Venezuela (informal)
  'UYU', // Uruguay
  'VES', // Venezuela (bolívar)
] as const;

export type AllowedCurrency = (typeof ALLOWED_CURRENCIES)[number];

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

  /**
   * Código ISO 4217 (3 letras mayúsculas). Se valida contra
   * `ALLOWED_CURRENCIES` — LATAM + majors. El regex es defensa en profundidad:
   * si alguien mete "usd" (minúsculas) el `@Matches` corta ANTES del `@IsIn`
   * y devolvemos un error específico y accionable.
   */
  @IsOptional()
  @IsString()
  @Matches(/^[A-Z]{3}$/, {
    message: 'currency debe ser 3 letras mayúsculas (ej. USD, ARS, BRL)',
  })
  @IsIn(ALLOWED_CURRENCIES, {
    message: `currency debe ser uno de: ${ALLOWED_CURRENCIES.join(', ')}`,
  })
  currency?: AllowedCurrency;

  @IsOptional()
  @IsBoolean()
  autoConfirm?: boolean;

  /**
   * WhatsApp público de la clínica (opt-in). Se expone tal cual en
   * `GET /api/public/clinics/:slug` → `whatsappPhone` para el link wa.me de
   * /gracias. Acepta separadores visuales (espacios, guiones, paréntesis) que
   * el `@Transform` quita antes del regex E.164; el controller lo canoniza con
   * `normalizeE164`. String vacío = "borrar" (se persiste NULL y deja de
   * exponerse). Nunca es un teléfono de paciente ni de profesional.
   */
  @IsOptional()
  @IsString()
  @MaxLength(32)
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.replace(/[\s\-().]/g, '') : value,
  )
  @ValidateIf((o: UpdateClinicDto) => o.publicWhatsappPhone !== '')
  @Matches(/^(\+|00)?[1-9]\d{7,14}$/, {
    message:
      'publicWhatsappPhone debe ser un número internacional válido (ej. +5804121234567)',
  })
  publicWhatsappPhone?: string;

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
