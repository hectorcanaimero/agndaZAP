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
    /**
     * Cita a excluir del cálculo de ocupación. Usado por `rescheduleAppointment`
     * para que la cita que se está moviendo no bloquee su propio slot actual
     * (ni el nuevo si se está probando el mismo servicio+profesional).
     */
    excludeAppointmentId?: string;
  }): Promise<Slot[]> {
    const { clinicId, serviceId, professionalId, excludeAppointmentId } = params;
    const days = params.days ?? 7;
    const limit = params.limit ?? 20;

    const clinic = await this.prisma.clinic.findUniqueOrThrow({
      where: { id: clinicId },
    });
    // Tenant check: el servicio tiene que pertenecer a la clínica.
    const service = await this.prisma.service.findFirstOrThrow({
      where: { id: serviceId, clinicId },
    });

    const zone = clinic.timezone;
    const step = service.durationMin + service.bufferMin;

    const rangeStart = DateTime.fromISO(params.fromISO, { zone }).startOf('day');
    const rangeEnd = rangeStart.plus({ days });

    // Horarios de atención — semántica de OVERRIDE, no unión:
    // si el profesional definió CUALQUIER `BusinessHour` propio, ese conjunto
    // es su horario completo y descartamos el horario base de la clínica. Si
    // no tiene ninguno, hereda el de la clínica (`professionalId === null`).
    // Antes generábamos la unión y un profesional con horario propio recibía
    // slots dentro del horario clínica que no atendía (F1.2.T1, P0).
    const businessHoursRaw = await this.prisma.businessHour.findMany({
      where: {
        clinicId,
        OR: [{ professionalId }, { professionalId: null }],
      },
    });
    const hasProfessionalHours = businessHoursRaw.some(
      (bh) => bh.professionalId === professionalId,
    );
    const businessHours = hasProfessionalHours
      ? businessHoursRaw.filter((bh) => bh.professionalId === professionalId)
      : businessHoursRaw;

    // Bloqueos que intersecan el rango
    const timeOff = await this.prisma.timeOff.findMany({
      where: {
        clinicId,
        OR: [{ professionalId }, { professionalId: null }],
        startAt: { lt: rangeEnd.toJSDate() },
        endAt: { gt: rangeStart.toJSDate() },
      },
    });

    // Citas ocupadas (no canceladas) del profesional en el rango.
    // Excluimos la cita que se está reagendando (si aplica) para que su slot
    // actual no aparezca como "ocupado por sí misma".
    //
    // Traemos `service.bufferMin` de CADA cita: el buffer post-cita (limpieza,
    // notas) forma parte del tiempo ocupado. Sin esto un slot podía pegarse a
    // `endAt` de una cita ignorando su buffer.
    // Limitación conocida: el filtro `endAt > rangeStart` no suma el buffer,
    // así que una cita del día anterior cuyo buffer cruce la medianoche no
    // bloquea el primer slot del rango. Aceptable: los horarios de atención
    // no arrancan a las 00:00 y los buffers son de minutos.
    const taken = await this.prisma.appointment.findMany({
      where: {
        clinicId,
        professionalId,
        status: { notIn: ['CANCELADA', 'NO_SHOW'] },
        startAt: { lt: rangeEnd.toJSDate() },
        endAt: { gt: rangeStart.toJSDate() },
        ...(excludeAppointmentId ? { id: { not: excludeAppointmentId } } : {}),
      },
      select: {
        startAt: true,
        endAt: true,
        service: { select: { bufferMin: true } },
      },
    });

    // Intervalo ocupado = [startAt, endAt + bufferMin de esa cita).
    const takenIntervals = taken.map((a) =>
      Interval.fromDateTimes(
        DateTime.fromJSDate(a.startAt),
        DateTime.fromJSDate(a.endAt).plus({
          minutes: a.service?.bufferMin ?? 0,
        }),
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
          // El buffer de la cita NUEVA también es tiempo ocupado: contra las
          // citas existentes comparamos [slotStart, slotEnd + bufferMin).
          // Contra TimeOff y cierre sólo la duración (el buffer puede caer
          // en un bloqueo o fuera de horario sin problema).
          const slotInterval = Interval.fromDateTimes(slotStart, slotEnd);
          const slotWithBuffer = Interval.fromDateTimes(
            slotStart,
            slotEnd.plus({ minutes: service.bufferMin }),
          );

          const inPast = slotStart <= now;
          const overlapsTaken = takenIntervals.some((iv) =>
            iv.overlaps(slotWithBuffer),
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
