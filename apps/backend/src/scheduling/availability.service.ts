import { Injectable } from '@nestjs/common';
import { DateTime, Interval } from 'luxon';
import { PrismaService } from '../prisma/prisma.service';

export interface Slot {
  startAt: Date;
  endAt: Date;
}

/**
 * Motor de disponibilidad.
 * Calcula los slots libres para un servicio/profesional en un rango de fechas,
 * respetando: horario de atención, duración + buffer del servicio, feriados/bloqueos,
 * zona horaria de la clínica y citas ya tomadas.
 */
@Injectable()
export class AvailabilityService {
  constructor(private readonly prisma: PrismaService) {}

  async getSlots(params: {
    clinicId: string;
    serviceId: string;
    professionalId: string;
    fromISO: string; // fecha inicio (día)
    days?: number; // cuántos días mirar hacia adelante
    limit?: number; // máximo de slots a devolver
  }): Promise<Slot[]> {
    const { clinicId, serviceId, professionalId } = params;
    const days = params.days ?? 7;
    const limit = params.limit ?? 20;

    const clinic = await this.prisma.clinic.findUniqueOrThrow({
      where: { id: clinicId },
    });
    const service = await this.prisma.service.findUniqueOrThrow({
      where: { id: serviceId },
    });

    const zone = clinic.timezone;
    const step = service.durationMin + service.bufferMin;

    const rangeStart = DateTime.fromISO(params.fromISO, { zone }).startOf('day');
    const rangeEnd = rangeStart.plus({ days });

    // Horarios de atención (del profesional o, si no tiene, de la clínica)
    const businessHours = await this.prisma.businessHour.findMany({
      where: {
        clinicId,
        OR: [{ professionalId }, { professionalId: null }],
      },
    });

    // Bloqueos que intersecan el rango
    const timeOff = await this.prisma.timeOff.findMany({
      where: {
        clinicId,
        OR: [{ professionalId }, { professionalId: null }],
        startAt: { lt: rangeEnd.toJSDate() },
        endAt: { gt: rangeStart.toJSDate() },
      },
    });

    // Citas ocupadas (no canceladas) del profesional en el rango
    const taken = await this.prisma.appointment.findMany({
      where: {
        professionalId,
        status: { notIn: ['CANCELADA', 'NO_SHOW'] },
        startAt: { lt: rangeEnd.toJSDate() },
        endAt: { gt: rangeStart.toJSDate() },
      },
      select: { startAt: true, endAt: true },
    });

    const takenIntervals = taken.map((a) =>
      Interval.fromDateTimes(
        DateTime.fromJSDate(a.startAt),
        DateTime.fromJSDate(a.endAt),
      ),
    );
    const offIntervals = timeOff.map((t) =>
      Interval.fromDateTimes(
        DateTime.fromJSDate(t.startAt),
        DateTime.fromJSDate(t.endAt),
      ),
    );

    const now = DateTime.now().setZone(zone);
    const slots: Slot[] = [];

    for (let d = 0; d < days && slots.length < limit; d++) {
      const day = rangeStart.plus({ days: d });
      const weekday = day.weekday % 7; // luxon: 1=lun..7=dom → 0=dom..6=sáb

      const dayHours = businessHours.filter((h) => h.weekday === weekday);
      for (const bh of dayHours) {
        let cursor = day.set({
          hour: 0,
          minute: bh.startMinutes,
          second: 0,
          millisecond: 0,
        });
        const closeAt = day.set({
          hour: 0,
          minute: bh.endMinutes,
          second: 0,
          millisecond: 0,
        });

        while (cursor.plus({ minutes: service.durationMin }) <= closeAt) {
          const slotStart = cursor;
          const slotEnd = cursor.plus({ minutes: service.durationMin });
          const slotInterval = Interval.fromDateTimes(slotStart, slotEnd);

          const inPast = slotStart <= now;
          const overlapsTaken = takenIntervals.some((iv) =>
            iv.overlaps(slotInterval),
          );
          const overlapsOff = offIntervals.some((iv) =>
            iv.overlaps(slotInterval),
          );

          if (!inPast && !overlapsTaken && !overlapsOff) {
            slots.push({
              startAt: slotStart.toJSDate(),
              endAt: slotEnd.toJSDate(),
            });
            if (slots.length >= limit) break;
          }
          cursor = cursor.plus({ minutes: step });
        }
      }
    }

    return slots;
  }
}
