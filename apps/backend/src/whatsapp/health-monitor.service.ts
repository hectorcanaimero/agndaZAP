import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { WahaService } from './waha.service';

/**
 * WahaHealthMonitor — lógica pura del health-check de sesiones WAHA.
 *
 * Itera todas las clínicas con `wahaSession` y consulta su estado. Loguea
 * `warn` cuando encuentra `FAILED`. Se llama desde un job BullMQ periódico
 * (T8) o manualmente en tests / smoke.
 *
 * Reglas:
 *  - `STOPPED` y `UNKNOWN` no generan warn (estados válidos / transitorios).
 *  - Si `getSessionStatus` tira, se loguea `error` y el loop continúa.
 *  - CERO PII: sólo se loguea `{ clinicId, session }`. Nunca `name`, `phone`,
 *    `address` u otro dato de la clínica o pacientes.
 *
 * Referencia: docs/notas/2026-08-09-bloque-waha-panel-conexion.md §Observabilidad.
 */
@Injectable()
export class WahaHealthMonitor {
  private readonly logger = new Logger(WahaHealthMonitor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly waha: WahaService,
  ) {}

  async checkAll(): Promise<{ checked: number; failed: number }> {
    // `wahaSession` es NOT NULL + UNIQUE en el schema → todas las clínicas
    // tienen sesión. Filtramos igual por si algún seed dejara un string vacío.
    // Nunca seleccionar name/phone/address: cero PII en el resto del pipeline.
    const clinics = await this.prisma.clinic.findMany({
      where: { wahaSession: { not: '' } },
      select: { id: true, wahaSession: true },
    });

    this.logger.log({ event: 'waha.health.tick', count: clinics.length });

    let checked = 0;
    let failed = 0;

    for (const clinic of clinics) {
      checked += 1;
      try {
        const status = await this.waha.getSessionStatus(clinic.wahaSession);
        if (status === 'FAILED') {
          failed += 1;
          this.logger.warn({
            event: 'waha.health.failed',
            clinicId: clinic.id,
            session: clinic.wahaSession,
            status,
          });
        }
        // STOPPED (usuario desconectó) y UNKNOWN (WAHA transitorio) no warnean.
      } catch (err) {
        this.logger.error({
          event: 'waha.health.error',
          clinicId: clinic.id,
          session: clinic.wahaSession,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return { checked, failed };
  }
}
