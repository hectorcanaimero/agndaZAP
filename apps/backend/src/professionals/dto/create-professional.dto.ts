import {
  ArrayUnique,
  IsArray,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { ProfessionalProfileFieldsDto } from './professional-profile-fields.dto';

export class CreateProfessionalDto extends ProfessionalProfileFieldsDto {
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name!: string;

  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsString({ each: true })
  serviceIds?: string[];
}
