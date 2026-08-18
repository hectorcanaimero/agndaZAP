import { IsString, MaxLength, MinLength } from 'class-validator';

/**
 * Body para `POST /api/admin/clinics/:id/suspend`.
 *
 * El `reason` queda persistido en `Clinic.suspendedReason` y en el
 * trail de `AdminAudit.metadata` — sirve como evidencia ante auditorías
 * o reclamos del cliente.
 */
export class SuspendClinicDto {
  @IsString()
  @MinLength(3, { message: 'reason debe tener al menos 3 caracteres' })
  @MaxLength(500, { message: 'reason no puede superar 500 caracteres' })
  reason!: string;
}
