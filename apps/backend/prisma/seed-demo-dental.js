// Demo: convierte la clínica `demo` en una clínica odontológica de Puerto Ordaz
// (Estado Bolívar, Venezuela) con datos realistas en español para mostrar el
// producto: servicios, profesionales, horarios, bloqueos, pacientes ficticios,
// citas de los últimos 30 días y de la próxima semana, recordatorios,
// feedback y conversaciones de ejemplo.
//
// Uso (dentro del contenedor del backend o con DATABASE_URL apuntando a la DB):
//   node prisma/seed-demo-dental.js
//
// Idempotente: las citas llevan `[demo-dental:v1]` en `notes` y las
// conversaciones el prefijo `demodental-` en `chatId`; al re-ejecutar se
// borran y regeneran. Servicios y profesionales se actualizan por nombre.
// Las FAQ NO se crean acá (necesitan embedding): usar `POST /api/faq`.
//
// Cero datos reales: nombres y teléfonos son ficticios (+58 4xx).

const { PrismaClient } = require('@prisma/client');
const { DateTime } = require('luxon');

const prisma = new PrismaClient();
const TAG = '[demo-dental:v1]';
const CHAT_PREFIX = 'demodental-';

const CLINIC = {
  name: 'Clínica Dental Sonrisa Guayana',
  timezone: 'America/Caracas',
  locale: 'es',
  currency: 'USD',
  address:
    'Av. Las Américas, C.C. Orinokia Mall, Torre A, piso 3, oficina 3-12, Puerto Ordaz, Estado Bolívar',
  reminderOffsetsH: [24, 3],
  confirmThresholdH: 6,
  botGreeting:
    '¡Hola! Soy el asistente de Clínica Dental Sonrisa Guayana, en Puerto Ordaz. Puedo agendarte una cita, reprogramarla o responder dudas sobre nuestros servicios. ¿En qué te ayudo?',
  botHandoffMsg:
    'Te paso con una persona del equipo. En horario de atención te respondemos en menos de 30 minutos.',
};

// [nombre, duración, buffer, precio USD]
const SERVICES = [
  ['Consulta de valoración', 30, 0, 20],
  ['Limpieza dental (profilaxis)', 45, 10, 35],
  ['Blanqueamiento dental', 60, 15, 120],
  ['Control de ortodoncia', 20, 5, 40],
  ['Endodoncia (tratamiento de conducto)', 90, 15, 180],
  ['Extracción simple', 45, 15, 60],
  ['Odontopediatría (niños)', 30, 10, 30],
  ['Urgencia por dolor', 30, 0, 25],
];

// nombre, especialidad, servicios que atiende (índices de SERVICES), color
const PROFESSIONALS = [
  {
    name: 'Dra. Valentina Rojas',
    specialty: 'Odontología general y estética',
    bio: 'Egresada de la UCV. 12 años de experiencia en rehabilitación y estética dental.',
    services: [0, 1, 2, 5, 7],
    color: '#28D9B9',
    followUpEnabled: true,
  },
  {
    name: 'Dr. Andrés Mendoza',
    specialty: 'Ortodoncia',
    bio: 'Especialista en ortodoncia convencional y alineadores. Atiende martes, jueves y sábados.',
    services: [0, 3],
    color: '#0F2A4A',
    followUpEnabled: false,
    // Override de horario: sólo martes, jueves (tarde) y sábado (mañana).
    hours: [
      [2, 14 * 60, 18 * 60],
      [4, 14 * 60, 18 * 60],
      [6, 8 * 60, 12 * 60],
    ],
  },
  {
    name: 'Dra. Camila Torres',
    specialty: 'Endodoncia',
    bio: 'Especialista en endodoncia microscópica. Urgencias por dolor el mismo día.',
    services: [0, 4, 7],
    color: '#B7770E',
    followUpEnabled: true,
  },
  {
    name: 'Dr. Luis Paredes',
    specialty: 'Odontopediatría',
    bio: 'Atención de niños y adolescentes con enfoque en prevención.',
    services: [0, 1, 6],
    color: '#1E8A5A',
    followUpEnabled: true,
  },
];

// Horario base de la clínica: L-V 8:00-12:30 y 14:00-18:00 · sábado 8:00-12:00.
const CLINIC_HOURS = [];
for (let d = 1; d <= 5; d++) {
  CLINIC_HOURS.push([d, 8 * 60, 12 * 60 + 30], [d, 14 * 60, 18 * 60]);
}
CLINIC_HOURS.push([6, 8 * 60, 12 * 60]);

const PATIENTS = [
  ['+584141230011', 'María Fernanda Gómez'],
  ['+584241230022', 'José Gregorio Salazar'],
  ['+584121230033', 'Andreína Pérez'],
  ['+584161230044', 'Carlos Eduardo Rivas'],
  ['+584141230055', 'Yusmary Bolívar'],
  ['+584241230066', 'Luis Alberto Marcano'],
  ['+584121230077', 'Génesis Marcano'],
  ['+584141230088', 'Rafael Antonio Mata'],
  ['+584241230099', 'Daniela Guerra'],
  ['+584161230100', 'Jesús Enrique Núñez'],
  ['+584141230111', 'Oriana Castellanos'],
  ['+584241230122', 'Miguel Ángel Briceño'],
  ['+584121230133', 'Rosa Elena Farías'],
  ['+584141230144', 'Samuel Aguilera'],
];

const COMMENTS = [
  'Excelente atención, la doctora explica todo con calma.',
  'Puntuales y muy amables. El recordatorio por WhatsApp me salvó.',
  'Mi hijo salió contento, cero miedo al dentista.',
  'Muy profesional. El precio fue el que me dijeron.',
  'Todo bien, sólo esperé 10 minutos.',
  null,
  null,
];

let rng = 20260910;
function rand() {
  rng = (rng * 1664525 + 1013904223) % 2 ** 32;
  return rng / 2 ** 32;
}
function randInt(min, max) {
  return min + Math.floor(rand() * (max - min + 1));
}
function pick(arr) {
  return arr[randInt(0, arr.length - 1)];
}

async function main() {
  const clinic = await prisma.clinic.update({
    where: { slug: 'demo' },
    data: CLINIC,
  });
  console.log('clinic:', clinic.name, '·', clinic.timezone);
  const zone = clinic.timezone;

  // ---- Servicios ------------------------------------------------------
  const services = [];
  for (const [name, durationMin, bufferMin, price] of SERVICES) {
    const existing = await prisma.service.findFirst({
      where: { clinicId: clinic.id, name },
    });
    const data = {
      durationMin,
      bufferMin,
      priceCents: price * 100,
      active: true,
    };
    const svc = existing
      ? await prisma.service.update({ where: { id: existing.id }, data })
      : await prisma.service.create({
          data: { clinicId: clinic.id, name, ...data },
        });
    services.push(svc);
  }
  // Servicios ajenos al demo dental quedan inactivos (no se borran: pueden
  // tener citas).
  await prisma.service.updateMany({
    where: {
      clinicId: clinic.id,
      name: { notIn: SERVICES.map((s) => s[0]) },
    },
    data: { active: false },
  });
  console.log('services:', services.length);

  // ---- Profesionales ----------------------------------------------------
  const professionals = [];
  for (const spec of PROFESSIONALS) {
    const existing = await prisma.professional.findFirst({
      where: { clinicId: clinic.id, name: spec.name },
    });
    const data = {
      specialty: spec.specialty,
      bio: spec.bio,
      color: spec.color,
      active: true,
      followUpEnabled: spec.followUpEnabled,
      followUpDelayHours: 2,
      services: { set: spec.services.map((i) => ({ id: services[i].id })) },
    };
    const prof = existing
      ? await prisma.professional.update({ where: { id: existing.id }, data })
      : await prisma.professional.create({
          data: {
            clinicId: clinic.id,
            name: spec.name,
            ...data,
            services: { connect: spec.services.map((i) => ({ id: services[i].id })) },
          },
        });
    professionals.push({ ...prof, spec });
  }
  await prisma.professional.updateMany({
    where: {
      clinicId: clinic.id,
      name: { notIn: PROFESSIONALS.map((p) => p.name) },
    },
    data: { active: false },
  });
  console.log('professionals:', professionals.length);

  // ---- Horarios ---------------------------------------------------------
  await prisma.businessHour.deleteMany({ where: { clinicId: clinic.id } });
  await prisma.businessHour.createMany({
    data: CLINIC_HOURS.map(([weekday, startMinutes, endMinutes]) => ({
      clinicId: clinic.id,
      professionalId: null,
      weekday,
      startMinutes,
      endMinutes,
    })),
  });
  for (const p of professionals) {
    if (!p.spec.hours) continue;
    await prisma.businessHour.createMany({
      data: p.spec.hours.map(([weekday, startMinutes, endMinutes]) => ({
        clinicId: clinic.id,
        professionalId: p.id,
        weekday,
        startMinutes,
        endMinutes,
      })),
    });
  }
  console.log('business hours: clínica L-V + sáb; override para', professionals[1].name);

  // ---- Bloqueos ---------------------------------------------------------
  const now = DateTime.now().setZone(zone);
  await prisma.timeOff.deleteMany({
    where: { clinicId: clinic.id, reason: { startsWith: TAG } },
  });
  const nextMonday = now.plus({ days: (8 - now.weekday) % 7 || 7 }).startOf('day');
  await prisma.timeOff.createMany({
    data: [
      {
        clinicId: clinic.id,
        professionalId: professionals[2].id,
        startAt: nextMonday.plus({ days: 7 }).toJSDate(),
        endAt: nextMonday.plus({ days: 9 }).toJSDate(),
        reason: `${TAG} Congreso de Endodoncia (Caracas)`,
      },
      {
        clinicId: clinic.id,
        professionalId: null,
        startAt: nextMonday.plus({ days: 4, hours: 14 }).toJSDate(),
        endAt: nextMonday.plus({ days: 4, hours: 18 }).toJSDate(),
        reason: `${TAG} Mantenimiento del equipo de rayos X`,
      },
    ],
  });

  // ---- Pacientes --------------------------------------------------------
  const patients = [];
  for (const [phone, name] of PATIENTS) {
    const p = await prisma.patient.upsert({
      where: { clinicId_phone: { clinicId: clinic.id, phone } },
      create: { clinicId: clinic.id, phone, name, consent: true },
      update: { name, consent: true },
    });
    patients.push(p);
  }
  console.log('patients:', patients.length);

  // ---- Citas + recordatorios + feedback --------------------------------
  const oldAppts = await prisma.appointment.findMany({
    where: { clinicId: clinic.id, notes: { startsWith: TAG } },
    select: { id: true },
  });
  await prisma.feedback.deleteMany({
    where: { appointmentId: { in: oldAppts.map((a) => a.id) } },
  });
  await prisma.appointment.deleteMany({
    where: { clinicId: clinic.id, notes: { startsWith: TAG } },
  });
  await prisma.conversation.deleteMany({
    where: { clinicId: clinic.id, chatId: { startsWith: CHAT_PREFIX } },
  });

  const taken = new Set();
  const pre = await prisma.appointment.findMany({
    where: { clinicId: clinic.id },
    select: { professionalId: true, startAt: true },
  });
  for (const a of pre) taken.add(`${a.professionalId}@${a.startAt.toISOString()}`);

  // Horas de inicio válidas por profesional (según horario base u override).
  function hoursFor(prof, weekday) {
    const rows = prof.spec.hours
      ? prof.spec.hours.filter((h) => h[0] === weekday)
      : CLINIC_HOURS.filter((h) => h[0] === weekday);
    const starts = [];
    for (const [, s, e] of rows) {
      for (let m = s; m + 30 <= e; m += 30) starts.push(m);
    }
    return starts;
  }

  const buckets = [
    // [días atrás min, max, cantidad, distribución de estados]
    { range: [-30, -1], count: 56, statuses: ['ATENDIDA', 'ATENDIDA', 'ATENDIDA', 'ATENDIDA', 'ATENDIDA', 'NO_SHOW', 'CANCELADA'] },
    { range: [0, 0], count: 6, statuses: ['CONFIRMADA', 'CONFIRMADA', 'ATENDIDA', 'PENDIENTE'] },
    { range: [1, 7], count: 16, statuses: ['CONFIRMADA', 'CONFIRMADA', 'PENDIENTE', 'PENDIENTE', 'EN_RIESGO'] },
  ];

  let apptCount = 0;
  let remCount = 0;
  let fbCount = 0;
  let profIdx = 0;
  for (const bucket of buckets) {
    let created = 0;
    let attempts = 0;
    while (created < bucket.count && attempts < bucket.count * 30) {
      attempts++;
      const day = now.plus({ days: randInt(bucket.range[0], bucket.range[1]) }).startOf('day');
      if (day.weekday === 7) continue; // domingo cerrado
      const prof = professionals[profIdx++ % professionals.length];
      const starts = hoursFor(prof, day.weekday % 7);
      if (starts.length === 0) continue;
      const svc = services[pick(prof.spec.services)];
      const startAt = day.plus({ minutes: pick(starts) });
      if (bucket.range[0] === 0 && bucket.range[1] === 0) {
        // hoy: pasadas → ATENDIDA, futuras → CONFIRMADA/PENDIENTE
      }
      const endAt = startAt.plus({ minutes: svc.durationMin });
      const key = `${prof.id}@${startAt.toUTC().toISO()}`;
      if (taken.has(key)) continue;
      taken.add(key);

      let status = pick(bucket.statuses);
      if (bucket.range[0] === 0 && bucket.range[1] === 0) {
        status = startAt < now ? (rand() < 0.85 ? 'ATENDIDA' : 'NO_SHOW') : (rand() < 0.7 ? 'CONFIRMADA' : 'PENDIENTE');
      }
      const patient = pick(patients);
      const appt = await prisma.appointment.create({
        data: {
          clinicId: clinic.id,
          patientId: patient.id,
          serviceId: svc.id,
          professionalId: prof.id,
          startAt: startAt.toJSDate(),
          endAt: endAt.toJSDate(),
          status,
          source: pick(['BOT', 'BOT', 'PUBLIC', 'BOT_WEB']),
          notes: `${TAG} ${svc.name}`,
          confirmedAt:
            status === 'CONFIRMADA' || status === 'ATENDIDA'
              ? startAt.minus({ hours: randInt(4, 30) }).toJSDate()
              : null,
          canceledAt: status === 'CANCELADA' ? startAt.minus({ hours: randInt(2, 40) }).toJSDate() : null,
          outcome: status === 'ATENDIDA' ? 'atendio' : status === 'NO_SHOW' ? 'no_show' : null,
        },
      });
      apptCount++;

      // Recordatorios 24h y 3h coherentes con el estado.
      for (const offsetH of clinic.reminderOffsetsH) {
        const fireAt = startAt.minus({ hours: offsetH });
        let rStatus = 'SCHEDULED';
        if (fireAt < now) rStatus = status === 'CANCELADA' ? 'CANCELED' : 'SENT';
        if (status === 'CANCELADA' && fireAt >= now) rStatus = 'CANCELED';
        await prisma.reminder.create({
          data: {
            appointmentId: appt.id,
            offsetH,
            fireAt: fireAt.toJSDate(),
            status: rStatus,
            sentAt: rStatus === 'SENT' ? fireAt.plus({ minutes: 1 }).toJSDate() : null,
          },
        });
        remCount++;
      }

      // Feedback en ~60% de las atendidas de profesionales con follow-up.
      if (status === 'ATENDIDA' && prof.spec.followUpEnabled && rand() < 0.6) {
        await prisma.feedback.create({
          data: {
            clinicId: clinic.id,
            appointmentId: appt.id,
            score: pick([5, 5, 5, 4, 4, 3]),
            comment: pick(COMMENTS),
            respondedAt: endAt.plus({ hours: 2, minutes: randInt(1, 90) }).toJSDate(),
          },
        });
        fbCount++;
      }
      created++;
    }
  }
  console.log('appointments:', apptCount, '· reminders:', remCount, '· feedback:', fbCount);

  // ---- Conversaciones de ejemplo -------------------------------------
  const convoSpecs = [
    {
      chatId: `${CHAT_PREFIX}${PATIENTS[0][0].slice(1)}@c.us`,
      patient: patients[0],
      state: 'BOT',
      messages: [
        ['IN', 'Hola, quiero una limpieza dental'],
        ['OUT', '¡Hola María Fernanda! Con gusto. ¿Preferís con la Dra. Valentina Rojas o con el Dr. Luis Paredes?'],
        ['IN', 'Con la Dra. Rojas'],
        ['OUT', 'Perfecto. Tengo estos horarios para limpieza dental (45 min):\n1) Jue 10:00\n2) Jue 15:30\n3) Vie 09:00\nRespondé con el número.'],
        ['IN', '2'],
        ['OUT', 'Listo ✅ Limpieza dental con la Dra. Rojas el jueves a las 15:30. Te recuerdo 24 h y 3 h antes. Estamos en Orinokia Mall, Torre A, piso 3.'],
      ],
    },
    {
      chatId: `${CHAT_PREFIX}${PATIENTS[3][0].slice(1)}@c.us`,
      patient: patients[3],
      state: 'NEEDS_HUMAN',
      messages: [
        ['IN', 'Buenas, me quedó una molestia después de la endodoncia de ayer, ¿es normal?'],
        ['OUT', 'Entiendo la preocupación, Carlos. Esa consulta la responde directamente el equipo clínico. Te paso con una persona; en horario de atención respondemos en menos de 30 minutos.'],
      ],
    },
    {
      chatId: `${CHAT_PREFIX}${PATIENTS[6][0].slice(1)}@c.us`,
      patient: patients[6],
      state: 'HUMAN',
      messages: [
        ['IN', '¿Aceptan pago móvil o sólo efectivo?'],
        ['OUT', 'Aceptamos pago móvil, Zelle, efectivo en dólares y bolívares al cambio del día. Las tarjetas nacionales también.'],
        ['IN', 'Perfecto, ¿y para ortodoncia dan presupuesto en la primera consulta?'],
        ['OUT', 'Sí: la consulta de valoración incluye el presupuesto del tratamiento completo. ¿Te agendo con el Dr. Mendoza?'],
      ],
    },
  ];
  for (const spec of convoSpecs) {
    const convo = await prisma.conversation.create({
      data: {
        clinicId: clinic.id,
        chatId: spec.chatId,
        phone: spec.patient.phone,
        contactName: spec.patient.name,
        patientId: spec.patient.id,
        state: spec.state,
      },
    });
    let t = now.minus({ hours: randInt(2, 30) });
    for (const [direction, body] of spec.messages) {
      await prisma.message.create({
        data: { conversationId: convo.id, direction, body, createdAt: t.toJSDate() },
      });
      t = t.plus({ minutes: randInt(1, 4) });
    }
  }
  console.log('conversations:', convoSpecs.length);

  const byStatus = await prisma.appointment.groupBy({
    by: ['status'],
    where: { clinicId: clinic.id, notes: { startsWith: TAG } },
    _count: true,
  });
  console.log('por estado:', byStatus.map((r) => `${r.status}=${r._count}`).join(' '));
  console.log('\nDemo dental OK. Página pública: /es/agendar/demo');
}

main()
  .catch((e) => {
    console.error('seed-demo-dental failed:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
