import { IsObject, IsOptional, IsString } from 'class-validator';

/**
 * DTO del webhook entrante de WAHA.
 *
 * WAHA envía payloads con al menos `event` (nombre del evento, ej. "message",
 * "session.status") y `session` (nombre de la sesión que emite el evento).
 * `payload` es un objeto con la data específica del evento — su shape varía
 * según `event`, así que lo dejamos como `Record<string, unknown>`.
 *
 * Whitelist (ValidationPipe con `whitelist: true`, ver main.ts): propiedades
 * no declaradas se DESCARTAN. `forbidNonWhitelisted: true` incluso rechaza
 * el request si trae campos extra. Combinado, esto evita que un atacante
 * envíe payloads inflados intentando llenar RAM del proceso.
 */
export class WahaWebhookDto {
  @IsString()
  event!: string;

  @IsString()
  session!: string;

  @IsOptional()
  @IsObject()
  payload?: Record<string, unknown>;
}
