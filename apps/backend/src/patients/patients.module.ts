import { Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import { PrismaModule } from '../prisma/prisma.module';
import { PatientsController } from './patients.controller';

// `LoggerModule.forFeature` es requerido por nestjs-pino cuando el controller
// usa `@InjectPinoLogger(ControllerName)` — registra el proveedor scoped por
// contexto en este módulo. Sin esto, DI de Nest no lo encuentra aunque el
// LoggerModule global esté cargado (los contextos son locales per-módulo).
@Module({
  imports: [
    PrismaModule,
    LoggerModule.forFeature([{ name: PatientsController.name }]),
  ],
  controllers: [PatientsController],
})
export class PatientsModule {}
