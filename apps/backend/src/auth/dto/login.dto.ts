import { IsEmail, IsString, MinLength } from 'class-validator';
import { Transform } from 'class-transformer';

/**
 * LoginDto — payload de `POST /api/auth/login`.
 *
 * - Email normalizado (lowercase + trim) en el DTO para que el `findUnique`
 *   siempre matchee con el hash guardado. El schema tiene `email @unique`
 *   pero no fuerza case; nuestro contrato es "todo email vive lowercased".
 * - Password mínimo 8 caracteres — el mismo umbral que va a exigir el flujo
 *   de creación/reset cuando llegue. No revelamos las reglas exactas en el
 *   response porque no ayudan a un atacante durante login (sólo importan al crear).
 */
export class LoginDto {
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsEmail({}, { message: 'email inválido' })
  email!: string;

  @IsString()
  @MinLength(8, { message: 'password debe tener al menos 8 caracteres' })
  password!: string;
}
