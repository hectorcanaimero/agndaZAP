import { IsEnum } from 'class-validator';
import { AppointmentStatus } from '@prisma/client';

/**
 * `reason` fue removido en el post-audit del bloque Panel (M4).
 * Motivo: no había persistencia (log-only) y el logueo abría riesgo PII
 * (el operador podía escribir síntomas del paciente). El campo se re-integra
 * cuando exista la tabla `AuditEvent` post-piloto. Ver ADR 0006 §Deuda.
 */
export class PatchStatusDto {
  @IsEnum(AppointmentStatus)
  status!: AppointmentStatus;
}
