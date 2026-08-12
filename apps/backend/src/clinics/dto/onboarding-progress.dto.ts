import {
  IsBoolean,
  IsInt,
  IsObject,
  IsOptional,
  Max,
  Min,
} from 'class-validator';

/**
 * DTO para `PATCH /api/clinics/me/onboarding`.
 *
 * Los tres campos son opcionales:
 * - `progress`: merge shallow sobre el JSON existente. NO reemplaza el objeto
 *   entero — el cliente manda solo las keys que cambiaron.
 * - `step`: número del step actual (1-6). Solo para telemetría/logs.
 * - `completed`: si true, setea `onboardingCompletedAt = NOW()` (idempotente).
 *   No hay forma de volver a "pending" desde el DTO — reset manual solo por
 *   SUPERADMIN via SQL para casos de re-onboarding intencional.
 *
 * Con `forbidNonWhitelisted: true` en el ValidationPipe global, keys extra son
 * rechazadas. `progress` es un objeto libre — validamos la shape en el shell
 * del wizard (frontend), no acá.
 */
export class OnboardingProgressDto {
  @IsOptional()
  @IsObject()
  progress?: Record<string, unknown>;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(6)
  step?: number;

  @IsOptional()
  @IsBoolean()
  completed?: boolean;
}
