import { Module } from '@nestjs/common';
import { ProfessionalsController } from './professionals.controller';

@Module({
  controllers: [ProfessionalsController],
})
export class ProfessionalsModule {}
