import { INestApplication, Injectable, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

/**
 * PrismaClient integrado al lifecycle de Nest.
 * Se conecta al arrancar el módulo. `enableShutdownHooks` conecta el cierre de la
 * app al evento `beforeExit` de Node para cerrar Prisma limpio.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit {
  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  async enableShutdownHooks(app: INestApplication): Promise<void> {
    // Nest maneja SIGTERM en su lifecycle; delegamos a onModuleDestroy si hace falta.
    process.on('beforeExit', async () => {
      await app.close();
    });
  }
}
