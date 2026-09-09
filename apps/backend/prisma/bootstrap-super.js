// Bootstrap standalone del primer SUPERADMIN + clinica demo + CLINIC_ADMIN.
//
// Corre desde el container backend en produccion (donde ts-node NO esta
// disponible en runtime). Usa unicamente deps que YA estan en el runtime:
// @prisma/client + bcrypt.
//
// Uso (via Coolify Terminal o docker exec):
//   node /repo/apps/backend/prisma/bootstrap-super.js
//
// Es idempotente: reejecutarlo no rompe nada, actualiza los passwords
// si cambiaron.
//
// Contraseñas: se leen de las env vars
//   BOOTSTRAP_SUPER_PASSWORD      (super@showly.us, SUPERADMIN)
//   BOOTSTRAP_DEMO_PASSWORD       (admin@demo.showly.us, CLINIC_ADMIN)
//   BOOTSTRAP_SUSPENDED_PASSWORD  (admin@demo-2.showly.us, clinica SUSPENDED)
// Minimo 12 caracteres. En produccion (NODE_ENV=production) son obligatorias:
// si falta alguna el script termina con error antes de tocar la DB. Fuera de
// produccion, si faltan, se usan los defaults de dev (super1234 / demo1234)
// con un warning. El script nunca imprime las contraseñas.

const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcrypt');

const MIN_PASSWORD_LENGTH = 12;
const IS_PROD = process.env.NODE_ENV === 'production';

// Defaults SOLO para dev/local. En prod no existen: hay que pasar las env.
const DEV_DEFAULTS = {
  super: 'super1234',
  demo: 'demo1234',
  suspended: 'demo1234',
};

const PASSWORD_ENV = {
  super: 'BOOTSTRAP_SUPER_PASSWORD',
  demo: 'BOOTSTRAP_DEMO_PASSWORD',
  suspended: 'BOOTSTRAP_SUSPENDED_PASSWORD',
};

/**
 * Resuelve las contraseñas desde env. Devuelve `{ key: plain }` o lanza un
 * Error con TODOS los problemas juntos (para no iterar env por env).
 */
function resolvePasswords() {
  const plain = {};
  const errors = [];
  const usingDefaults = [];

  for (const [key, envName] of Object.entries(PASSWORD_ENV)) {
    const value = process.env[envName];
    if (value === undefined || value === '') {
      if (IS_PROD) {
        errors.push(`${envName} es obligatoria en produccion`);
      } else {
        plain[key] = DEV_DEFAULTS[key];
        usingDefaults.push(envName);
      }
      continue;
    }
    if (value.length < MIN_PASSWORD_LENGTH) {
      errors.push(
        `${envName} debe tener al menos ${MIN_PASSWORD_LENGTH} caracteres`,
      );
      continue;
    }
    plain[key] = value;
  }

  if (errors.length > 0) {
    throw new Error(
      'bootstrap-super: configuracion invalida:\n  - ' + errors.join('\n  - '),
    );
  }
  if (usingDefaults.length > 0) {
    console.warn(
      `bootstrap-super: AVISO — usando defaults de dev para ${usingDefaults.join(', ')} ` +
        '(NODE_ENV != production). No usar en un ambiente real.',
    );
  }
  return plain;
}

const prisma = new PrismaClient();

async function main() {
  // Falla ANTES de conectar a la DB si faltan las env en prod.
  const plainPasswords = resolvePasswords();

  console.log('bootstrap-super: hasheando passwords...');
  const hashes = {};
  for (const [key, plain] of Object.entries(plainPasswords)) {
    hashes[key] = await bcrypt.hash(plain, 10);
  }

  console.log('bootstrap-super: upserting clinicas...');
  const demoClinic = await prisma.clinic.upsert({
    where: { slug: 'demo' },
    create: {
      slug: 'demo',
      name: 'Clinica Demo',
      timezone: 'America/Caracas',
      locale: 'es',
      wahaSession: 'demo-session',
      address: 'Av. Principal 123, Caracas',
    },
    update: {},
  });
  console.log('  clinic demo:', demoClinic.id);

  const suspendedClinic = await prisma.clinic.upsert({
    where: { slug: 'demo-2' },
    create: {
      slug: 'demo-2',
      name: 'Clinica Demo Suspendida',
      timezone: 'America/Caracas',
      locale: 'es',
      wahaSession: 'demo-2-session',
      address: 'Av. Principal 456, Caracas',
      status: 'SUSPENDED',
      suspendedAt: new Date(),
      suspendedReason:
        'clinica de prueba - bloqueada para testear gate de login del ADR 0014',
    },
    update: {
      status: 'SUSPENDED',
      suspendedAt: new Date(),
    },
  });
  console.log('  clinic suspended:', suspendedClinic.id);

  console.log('bootstrap-super: upserting users...');
  const users = [
    {
      email: 'super@showly.us',
      hash: hashes.super,
      name: 'Super Admin',
      role: 'SUPERADMIN',
      clinicId: null,
    },
    {
      email: 'admin@demo.showly.us',
      hash: hashes.demo,
      name: 'Recepcion Demo',
      role: 'CLINIC_ADMIN',
      clinicId: demoClinic.id,
    },
    {
      email: 'admin@demo-2.showly.us',
      hash: hashes.suspended,
      name: 'Admin Clinica Suspendida',
      role: 'CLINIC_ADMIN',
      clinicId: suspendedClinic.id,
    },
  ];

  for (const u of users) {
    const user = await prisma.user.upsert({
      where: { email: u.email },
      create: {
        email: u.email,
        password: u.hash,
        name: u.name,
        role: u.role,
        clinicId: u.clinicId,
      },
      update: {
        password: u.hash,
        name: u.name,
        role: u.role,
        clinicId: u.clinicId,
      },
    });
    console.log('  user:', user.email, '/', user.role);
  }

  console.log('\n=================================================');
  console.log('Bootstrap OK. Usuarios del panel (password = el de su env var):');
  console.log('=================================================');
  console.log('  super@showly.us         BOOTSTRAP_SUPER_PASSWORD      (SUPERADMIN, sin clinica)');
  console.log('  admin@demo.showly.us    BOOTSTRAP_DEMO_PASSWORD       (CLINIC_ADMIN, clinica demo)');
  console.log('  admin@demo-2.showly.us  BOOTSTRAP_SUSPENDED_PASSWORD  (CLINIC_ADMIN, clinica SUSPENDED)');
  console.log('=================================================');
  if (!IS_PROD) {
    console.log('Ambiente no productivo: las env que faltaban usaron los defaults de dev.');
  }
}

main()
  .then(() => prisma.$disconnect())
  .catch((e) => {
    console.error('bootstrap-super failed:', e);
    prisma.$disconnect().finally(() => process.exit(1));
  });
