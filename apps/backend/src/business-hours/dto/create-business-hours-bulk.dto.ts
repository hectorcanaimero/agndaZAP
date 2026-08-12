import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  ValidateNested,
} from 'class-validator';
import { CreateBusinessHourDto } from './create-business-hour.dto';

/**
 * DTO para `POST /api/business-hours/bulk` — creación atómica de N rows.
 *
 * Uso principal: el step 4 del wizard de onboarding manda 5-14 rows a la vez
 * (un preset genera L-V × 1-2 turnos). Sin transacción, un fallo parcial deja
 * la clínica con horarios rotos que el user no ve.
 *
 * Cota superior 14 = 7 días × 2 turnos (partido). Más que eso es sospechoso —
 * si aparece un preset con más rows, subir el máximo acá conscientemente.
 */
export class CreateBusinessHoursBulkDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(14)
  @ValidateNested({ each: true })
  @Type(() => CreateBusinessHourDto)
  hours!: CreateBusinessHourDto[];
}
