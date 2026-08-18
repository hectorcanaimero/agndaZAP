import { IsString, MaxLength, MinLength } from 'class-validator';

/**
 * Body para `POST /api/public/invitations/:token/accept`.
 *
 * `plainPassword` NUNCA se persiste en claro — el service la hashea con
 * bcrypt antes de escribir. La ruta es pública (sin JWT) pero el token en
 * el path es el gate: sin token válido, no se llega a mirar el body.
 */
export class AcceptInvitationDto {
  @IsString()
  @MinLength(8, { message: 'plainPassword debe tener al menos 8 caracteres' })
  @MaxLength(128, { message: 'plainPassword no puede superar 128 caracteres' })
  plainPassword!: string;
}
