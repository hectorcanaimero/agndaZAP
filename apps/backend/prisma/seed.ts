/**
 * Prisma seed — Showly
 *
 * Datos mínimos y reproducibles para probar el flujo end-to-end del endpoint
 * público (`/api/public/clinics/demo/*`) y la FSM del bot en local, MÁS un
 * set de data histórica realista para que el dashboard tenga números vivos
 * cuando le mostremos el panel a una clínica piloto.
 *
 * ── Historia (v1) ─────────────────────────────────────────────────────────
 *  - Clínica demo + 2 servicios + 2 profesionales + BusinessHour L-V 9-18.
 *  - 8 pacientes con nombres realistas + phones E.164 venezolanos ficticios.
 *  - ~40 citas históricas en los últimos 30 días con distribución:
 *      55% ATENDIDA, 15% NO_SHOW, 15% CANCELADA, 10% CONFIRMADA (futuras),
 *      5% PENDIENTE (próximas 24h). +1-2 EN_RIESGO para mostrar la alerta.
 *  - 2 recordatorios por cita (24h + 3h) con status SENT (o CANCELED si la
 *    cita fue cancelada). Sin jobs BullMQ reales (data histórica ≠ runtime).
 *  - 2 conversaciones sample (una BOT idle, una NEEDS_HUMAN).
 *  - 4 FAQs para el RAG.
 *
 * ── Idempotencia ──────────────────────────────────────────────────────────
 * Todo el seed histórico marca las filas con el prefijo `[seed:v1]` en
 * `notes` (para appointments) o en `flowData.seed` (para conversations). Al
 * re-correr, borramos primero esas filas y las regeneramos con timestamps
 * frescos (los últimos 30 días son relativos a `DateTime.now()`).
 *
 * Ejecutar: `pnpm --filter @showly/backend prisma db seed`.
 */
import {
  PrismaClient,
  Role,
  AppointmentStatus,
  ReminderStatus,
  ConversationState,
  MessageDirection,
} from '@prisma/client';
import { DateTime } from 'luxon';
import { hashPassword } from '../src/auth/password.util';
import {
  KnowledgeService,
  KnowledgeUnavailableError,
} from '../src/knowledge/knowledge.service';

const prisma = new PrismaClient();

// Marca única para reconocer y limpiar la data histórica del seed.
const SEED_TAG = '[seed:v1]';

async function main() {
  // Guard duro: el seed crea usuarios dev con passwords conocidos y una
  // clínica "demo" cableada al bot. Correrlo en prod es un vector de
  // compromiso obvio. Preferimos crashear que resembrar credenciales.
  // Whitelist explícito: sólo `development` y `test` — cualquier otro valor
  // (`staging`, `production`, undefined en Docker, etc.) es error.
  //
  // Bypass INTENCIONAL: setear SEED_ALLOW_PROD=1 (típicamente para bootstrap
  // del primer SUPERADMIN + data demo en un ambiente nuevo). Genera warnings
  // explícitos en el log y NUNCA debería quedar activado por default.
  const env = process.env.NODE_ENV ?? 'development';
  const allowProdSeed = process.env.SEED_ALLOW_PROD === '1';
  if (!['development', 'test'].includes(env) && !allowProdSeed) {
    throw new Error(
      `seed sólo en development/test, actual: ${env}. Bypass explícito: SEED_ALLOW_PROD=1`,
    );
  }
  if (allowProdSeed && env === 'production') {
    console.warn('⚠️  BYPASS ACTIVO: seed corriendo en PRODUCCIÓN por SEED_ALLOW_PROD=1');
    console.warn('⚠️  Crea usuarios con passwords conocidos (super1234, demo1234).');
    console.warn('⚠️  Rotar los passwords después del bootstrap si el ambiente es real.');
  }

  // 1) Clínica demo (upsert por slug — idempotente).
  const clinic = await prisma.clinic.upsert({
    where: { slug: 'demo' },
    create: {
      slug: 'demo',
      name: 'Clínica Demo',
      timezone: 'America/Caracas',
      locale: 'es',
      wahaSession: 'demo-session',
      address: 'Av. Principal 123, Caracas',
    },
    update: {
      name: 'Clínica Demo',
      timezone: 'America/Caracas',
      locale: 'es',
      wahaSession: 'demo-session',
      address: 'Av. Principal 123, Caracas',
    },
  });
  console.log(`clinic ready: id=${clinic.id} slug=${clinic.slug}`);

  // 1b) Clínica de prueba en estado SUSPENDED — sirve para testear el gate de login
  // del ADR 0014 (Área SaaS Admin).
  const suspendedClinic = await prisma.clinic.upsert({
    where: { slug: 'demo-2' },
    create: {
      slug: 'demo-2',
      name: 'Clínica Demo Suspendida',
      timezone: 'America/Caracas',
      locale: 'es',
      wahaSession: 'demo-2-session',
      address: 'Av. Principal 456, Caracas',
      status: 'SUSPENDED',
      suspendedAt: new Date(),
      suspendedReason:
        'clínica de prueba — bloqueada intencionalmente para testear el gate de login',
    },
    update: {
      status: 'SUSPENDED',
      suspendedAt: new Date(),
      suspendedReason:
        'clínica de prueba — bloqueada intencionalmente para testear el gate de login',
    },
  });
  console.log(
    `suspended clinic ready: id=${suspendedClinic.id} slug=${suspendedClinic.slug}`,
  );

  // 2) Servicios activos.
  const serviceSpecs = [
    { name: 'Consulta general', durationMin: 30, bufferMin: 0 },
    { name: 'Control', durationMin: 20, bufferMin: 5 },
  ];
  const services = [] as { id: string; name: string; durationMin: number }[];
  for (const spec of serviceSpecs) {
    const existing = await prisma.service.findFirst({
      where: { clinicId: clinic.id, name: spec.name },
    });
    const svc = existing
      ? await prisma.service.update({
          where: { id: existing.id },
          data: {
            durationMin: spec.durationMin,
            bufferMin: spec.bufferMin,
            active: true,
          },
        })
      : await prisma.service.create({
          data: {
            clinicId: clinic.id,
            name: spec.name,
            durationMin: spec.durationMin,
            bufferMin: spec.bufferMin,
            active: true,
          },
        });
    services.push({
      id: svc.id,
      name: svc.name,
      durationMin: svc.durationMin,
    });
    console.log(`service ready: id=${svc.id} name=${svc.name}`);
  }

  // 3) Profesionales activos + relación many-to-many con TODOS los servicios.
  const professionalNames = ['Dra. Ana Ríos', 'Dr. Luis Pérez'];
  const professionals = [] as { id: string; name: string }[];
  for (const name of professionalNames) {
    const existing = await prisma.professional.findFirst({
      where: { clinicId: clinic.id, name },
    });
    const prof = existing
      ? await prisma.professional.update({
          where: { id: existing.id },
          data: {
            active: true,
            services: {
              set: services.map((s) => ({ id: s.id })),
            },
          },
        })
      : await prisma.professional.create({
          data: {
            clinicId: clinic.id,
            name,
            active: true,
            services: {
              connect: services.map((s) => ({ id: s.id })),
            },
          },
        });
    professionals.push({ id: prof.id, name: prof.name });
    console.log(`professional ready: id=${prof.id} name=${prof.name}`);
  }

  // 4) BusinessHour: lunes a viernes (1..5), 09:00 (540) a 18:00 (1080).
  // Idempotente: buscamos por (clinicId, professionalId, weekday) y creamos si no existe.
  for (const prof of professionals) {
    for (let weekday = 1; weekday <= 5; weekday++) {
      const existing = await prisma.businessHour.findFirst({
        where: {
          clinicId: clinic.id,
          professionalId: prof.id,
          weekday,
        },
      });
      if (existing) {
        await prisma.businessHour.update({
          where: { id: existing.id },
          data: { startMinutes: 540, endMinutes: 1080 },
        });
      } else {
        await prisma.businessHour.create({
          data: {
            clinicId: clinic.id,
            professionalId: prof.id,
            weekday,
            startMinutes: 540,
            endMinutes: 1080,
          },
        });
      }
    }
    console.log(`business hours ready for prof=${prof.id} (mon-fri 9-18)`);
  }

  // 5) Usuarios de dev — SÓLO para desarrollo local. NO usar en prod.
  const users: Array<{
    email: string;
    plain: string;
    name: string;
    role: Role;
    clinicId: string | null;
  }> = [
    {
      email: 'super@showly.dev',
      plain: 'super1234',
      name: 'Super Admin',
      role: 'SUPERADMIN',
      clinicId: null,
    },
    {
      email: 'admin@demo.dev',
      plain: 'demo1234',
      name: 'Recepción Demo',
      role: 'CLINIC_ADMIN',
      clinicId: clinic.id,
    },
    {
      email: 'admin@demo-2.dev',
      plain: 'demo1234',
      name: 'Admin Clínica Suspendida',
      role: 'CLINIC_ADMIN',
      clinicId: suspendedClinic.id,
    },
  ];
  for (const u of users) {
    const hash = await hashPassword(u.plain);
    await prisma.user.upsert({
      where: { email: u.email },
      create: {
        email: u.email,
        password: hash,
        name: u.name,
        role: u.role,
        clinicId: u.clinicId,
      },
      update: {
        password: hash,
        name: u.name,
        role: u.role,
        clinicId: u.clinicId,
      },
    });
    console.log(`user ready: email=${u.email} role=${u.role}`);
  }

  // 6) FAQs — idempotente por (clinicId, content).
  // `llm` solo se usa en answer() (RAG); el seed solo llama ingest(), que a lo
  // sumo toca embedText y ya tolera OPENAI_API_KEY ausente vía KnowledgeUnavailableError.
  const knowledge = new KnowledgeService(prisma as unknown as any, null as any);
  const faqSamples = [
    'Horarios de atención: L-V de 9:00 a 18:00. Sin atención sábados y domingos.',
    'Dirección: Av. Principal 123, Caracas. A 2 cuadras del metro Chacaíto.',
    'Formas de pago aceptadas: efectivo, transferencia bancaria y Zelle. No aceptamos tarjetas de crédito por el momento.',
    'La consulta general dura 30 minutos. Traé tu cédula y cualquier estudio previo relevante.',
  ];
  let embeddedCount = 0;
  let plainCount = 0;
  for (const content of faqSamples) {
    const existing = await prisma.faqChunk.findFirst({
      where: { clinicId: clinic.id, content },
      select: { id: true },
    });
    if (existing) {
      console.log(`faq ready: id=${existing.id} (existente, no re-embed)`);
      continue;
    }
    try {
      const chunk = await knowledge.ingest({
        clinicId: clinic.id,
        content,
      });
      embeddedCount++;
      console.log(`faq ready: id=${chunk.id} (con embedding)`);
    } catch (e) {
      if (e instanceof KnowledgeUnavailableError) {
        const chunk = await prisma.faqChunk.create({
          data: { clinicId: clinic.id, content },
          select: { id: true },
        });
        plainCount++;
        console.log(`faq ready: id=${chunk.id} (sin embedding)`);
      } else {
        throw e;
      }
    }
  }
  if (plainCount > 0) {
    console.log(
      `  → ${plainCount} FAQs sin embedding. Correr 'pnpm prisma:reindex-faq' cuando OPENAI_API_KEY esté disponible.`,
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 7) Data histórica (v1) — pacientes + citas + recordatorios + conversaciones.
  //
  // Limpieza previa: borramos SÓLO las filas marcadas con SEED_TAG. Deja
  // intactas las citas creadas por el bot o por el panel durante pruebas.
  // ─────────────────────────────────────────────────────────────────────────
  const {
    patientsCount,
    appointmentsCount,
    remindersCount,
    conversationsCount,
  } = await seedHistoricalData(clinic.id, clinic.timezone, services, professionals);

  console.log('\nseed v1 aplicado:');
  console.log(`  clínica: ${clinic.slug} (${clinic.id})`);
  console.log(
    `  suspended: ${suspendedClinic.slug} (${suspendedClinic.id}, admin=admin@demo-2.dev)`,
  );
  console.log('  users:   super@showly.dev · admin@demo.dev · admin@demo-2.dev');
  console.log(
    `  data:    ${services.length} services · ${professionals.length} professionals · ${patientsCount} patients · ${appointmentsCount} appointments · ${remindersCount} reminders · ${conversationsCount} conversations · ${faqSamples.length} FAQs`,
  );
  console.log(
    `  faqs breakdown: ${embeddedCount} con embedding, ${plainCount} sin embedding`,
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Historical data seeding
// ────────────────────────────────────────────────────────────────────────────

interface HistoricalCounts {
  patientsCount: number;
  appointmentsCount: number;
  remindersCount: number;
  conversationsCount: number;
}

async function seedHistoricalData(
  clinicId: string,
  timezone: string,
  services: Array<{ id: string; name: string; durationMin: number }>,
  professionals: Array<{ id: string; name: string }>,
): Promise<HistoricalCounts> {
  // 1) Purga la data marcada con SEED_TAG. Reminders bajan en cascada por
  //    onDelete: Cascade en Reminder.appointment.
  const purged = await prisma.appointment.deleteMany({
    where: { clinicId, notes: { contains: SEED_TAG } },
  });
  // Conversaciones marcadas también.
  const purgedConvs = await prisma.conversation.deleteMany({
    where: { clinicId, chatId: { startsWith: 'seedv1-' } },
  });
  console.log(
    `purge previous seed data: ${purged.count} appointments, ${purgedConvs.count} conversations`,
  );

  // 2) Pacientes ficticios (VE, E.164). Idempotente por (clinicId, phone).
  //    Los nombres son inventados; los prefijos +58414 / +58424 son válidos
  //    para operadoras VE (Movilnet / Movistar).
  const patientSpecs: Array<{ phone: string; name: string }> = [
    { phone: '+584141112233', name: 'María González' },
    { phone: '+584141223344', name: 'Carlos Rodríguez' },
    { phone: '+584141334455', name: 'Ana Martínez' },
    { phone: '+584241445566', name: 'Luis Hernández' },
    { phone: '+584241556677', name: 'Sofía Pérez' },
    { phone: '+584141667788', name: 'Diego Morales' },
    { phone: '+584241778899', name: 'Laura Blanco' },
    { phone: '+584141889900', name: 'Pedro Ramírez' },
  ];
  const patients = [] as { id: string; name: string; phone: string }[];
  for (const spec of patientSpecs) {
    const patient = await prisma.patient.upsert({
      where: {
        clinicId_phone: { clinicId, phone: spec.phone },
      },
      create: {
        clinicId,
        phone: spec.phone,
        name: spec.name,
        consent: true,
      },
      update: {
        name: spec.name,
        consent: true,
      },
    });
    patients.push({ id: patient.id, name: patient.name!, phone: patient.phone });
  }

  // 3) Distribución objetivo para ~40 citas:
  //    - 22 ATENDIDA (55%), 6 NO_SHOW (15%), 6 CANCELADA (15%),
  //      4 CONFIRMADA (10% — futuras), 2 PENDIENTE (5% — próximas 24h),
  //      2 EN_RIESGO extra (para tener alerta visible).
  //   El total pasa a 42, mejor: da un dashboard con números redondos y
  //   una alerta EN_RIESGO en el panel.
  type Bucket = {
    status: AppointmentStatus;
    count: number;
    // `daysOffset` respecto a hoy (negativo = pasado). Rango a repartir.
    dayRange: [number, number];
  };
  const buckets: Bucket[] = [
    { status: 'ATENDIDA', count: 22, dayRange: [-30, -1] },
    { status: 'NO_SHOW', count: 6, dayRange: [-28, -2] },
    { status: 'CANCELADA', count: 6, dayRange: [-25, -1] },
    { status: 'CONFIRMADA', count: 4, dayRange: [1, 7] }, // próximos 7 días
    { status: 'PENDIENTE', count: 2, dayRange: [0, 1] }, // próximas 24h
    { status: 'EN_RIESGO', count: 2, dayRange: [0, 3] }, // próximos 3 días sin confirmar
  ];

  // Generador determinístico: LCG estable para que los tests que dependan
  // de conteos exactos no se vuelvan flaky.
  let seedRng = 1337;
  const rand = () => {
    seedRng = (seedRng * 1664525 + 1013904223) % 2 ** 32;
    return seedRng / 2 ** 32;
  };
  const pick = <T>(arr: T[]): T => arr[Math.floor(rand() * arr.length)];

  const now = DateTime.now().setZone(timezone);
  // Horas del día laborales (9, 10, 11, 12, 14, 15, 16, 17) — dejamos las
  // 13 fuera (almuerzo típico, aunque el schema no lo prohíbe).
  const workHours = [9, 10, 11, 12, 14, 15, 16, 17];

  let appointmentsCreated = 0;
  let remindersCreated = 0;
  // Track de (professionalId + startAt ISO) para evitar chocar contra el
  // @@unique([professionalId, startAt]) del schema. Pre-cargamos las citas
  // NO borradas (creadas fuera del seed — smoke tests, panel, bot) para
  // no colisionar al re-seedear en una DB "sucia".
  const takenSlots = new Set<string>();
  const rangeStart = now.minus({ days: 35 }).toJSDate();
  const rangeEnd = now.plus({ days: 10 }).toJSDate();
  const preexisting = await prisma.appointment.findMany({
    where: {
      clinicId,
      startAt: { gte: rangeStart, lte: rangeEnd },
    },
    select: { professionalId: true, startAt: true },
  });
  for (const p of preexisting) {
    const iso = DateTime.fromJSDate(p.startAt).setZone(timezone).toISO();
    takenSlots.add(`${p.professionalId}@${iso}`);
  }

  // Distribución por profesional: alternamos para ~50/50.
  let profIdx = 0;
  const nextProfessional = () => {
    const p = professionals[profIdx % professionals.length];
    profIdx++;
    return p;
  };

  for (const bucket of buckets) {
    let created = 0;
    let attempts = 0;
    const maxAttempts = bucket.count * 20;
    while (created < bucket.count && attempts < maxAttempts) {
      attempts++;
      const dayOffset = randInt(rand, bucket.dayRange[0], bucket.dayRange[1]);
      const day = now.plus({ days: dayOffset });
      // Sólo L-V (weekday 1..5 en Luxon).
      if (day.weekday === 6 || day.weekday === 7) continue;

      const hour = pick(workHours);
      const professional = nextProfessional();
      const service = pick(services);

      const startAt = day.set({
        hour,
        minute: 0,
        second: 0,
        millisecond: 0,
      });

      // Guard adicional: dayOffset=0 y hora ya pasada → salteamos.
      if (dayOffset === 0 && startAt <= now) continue;

      const slotKey = `${professional.id}@${startAt.toISO()}`;
      if (takenSlots.has(slotKey)) continue;
      takenSlots.add(slotKey);

      const endAt = startAt.plus({ minutes: service.durationMin });
      const patient = pick(patients);

      const notes = `${SEED_TAG} ${bucket.status.toLowerCase()} sample`;
      const confirmedAt =
        bucket.status === 'CONFIRMADA' || bucket.status === 'ATENDIDA'
          ? startAt.minus({ hours: 20 }).toJSDate()
          : null;
      const canceledAt =
        bucket.status === 'CANCELADA'
          ? startAt.minus({ hours: 12 }).toJSDate()
          : null;
      const outcome =
        bucket.status === 'ATENDIDA'
          ? 'atendio'
          : bucket.status === 'NO_SHOW'
            ? 'no_show'
            : null;

      const appt = await prisma.appointment.create({
        data: {
          clinicId,
          patientId: patient.id,
          serviceId: service.id,
          professionalId: professional.id,
          startAt: startAt.toJSDate(),
          endAt: endAt.toJSDate(),
          status: bucket.status,
          notes,
          confirmedAt,
          canceledAt,
          outcome,
        },
      });
      appointmentsCreated++;
      created++;

      // Recordatorios: 2 por cita (24h + 3h). Status SENT (o CONFIRMED para
      // las ATENDIDAS que asumimos confirmaron por el reminder), CANCELED
      // para CANCELADAs. Los futuros PENDIENTE/EN_RIESGO también generan
      // filas SCHEDULED (con jobId null — data histórica, no runtime).
      for (const offsetH of [24, 3]) {
        const fireAt = startAt.minus({ hours: offsetH });
        let status: ReminderStatus;
        if (bucket.status === 'CANCELADA') status = 'CANCELED';
        else if (bucket.status === 'PENDIENTE' || bucket.status === 'EN_RIESGO')
          status = fireAt <= now ? 'SENT' : 'SCHEDULED';
        else if (bucket.status === 'CONFIRMADA')
          status = fireAt <= now ? 'CONFIRMED' : 'SCHEDULED';
        else status = 'SENT'; // ATENDIDA / NO_SHOW

        await prisma.reminder.create({
          data: {
            appointmentId: appt.id,
            offsetH,
            fireAt: fireAt.toJSDate(),
            status,
            sentAt: status === 'SENT' || status === 'CONFIRMED'
              ? fireAt.toJSDate()
              : null,
          },
        });
        remindersCreated++;
      }
    }
    if (created < bucket.count) {
      console.warn(
        `  ⚠ bucket ${bucket.status}: created ${created}/${bucket.count} (rango de días saturado)`,
      );
    }
  }

  // 4) Conversaciones sample para la bandeja del panel. Dos escenarios:
  //    - una en BOT con un intercambio corto (idle, sin acción pendiente),
  //    - una en NEEDS_HUMAN con la pregunta que disparó el handoff.
  const conv1 = await prisma.conversation.create({
    data: {
      clinicId,
      chatId: 'seedv1-bot-idle@c.us',
      phone: '+584141112233',
      state: ConversationState.BOT,
      messages: {
        create: [
          {
            direction: MessageDirection.IN,
            body: 'hola',
          },
          {
            direction: MessageDirection.OUT,
            body: 'Hola 👋 soy el asistente de Clínica Demo. ¿En qué te puedo ayudar? Podés agendar una cita o consultar información.',
          },
        ],
      },
    },
  });
  const conv2 = await prisma.conversation.create({
    data: {
      clinicId,
      chatId: 'seedv1-needs-human@c.us',
      phone: '+584241778899',
      state: ConversationState.NEEDS_HUMAN,
      messages: {
        create: [
          {
            direction: MessageDirection.IN,
            body: '¿ustedes atienden urgencias de fin de semana?',
          },
          {
            direction: MessageDirection.OUT,
            body: 'Déjame verificar esa información y en breve te responde una persona del equipo. 🙏',
          },
        ],
      },
    },
  });
  const conversationsCreated = 2;
  void conv1;
  void conv2;

  return {
    patientsCount: patients.length,
    appointmentsCount: appointmentsCreated,
    remindersCount: remindersCreated,
    conversationsCount: conversationsCreated,
  };
}

function randInt(rand: () => number, min: number, max: number): number {
  return Math.floor(rand() * (max - min + 1)) + min;
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (e) => {
    console.error('seed failed:', e);
    await prisma.$disconnect();
    process.exit(1);
  });
