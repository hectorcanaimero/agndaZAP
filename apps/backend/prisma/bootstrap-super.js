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

const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcrypt');

const prisma = new PrismaClient();

// Passwords hardcoded para el ambiente demo/piloto. Rotarlos si el
// ambiente pasa a ser real y sensible (login del panel, no del SaaS admin).
const PLAIN_PASSWORDS = {
  super: 'super1234',
  demo: 'demo1234',
  suspended: 'demo1234',
};

async function main() {
  console.log('bootstrap-super: hasheando passwords...');
  const hashes = {};
  for (const [key, plain] of Object.entries(PLAIN_PASSWORDS)) {
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
  console.log('Bootstrap OK. Credenciales del panel https://showly.us:');
  console.log('=================================================');
  console.log('  super@showly.us         / super1234    (SUPERADMIN, sin clinica)');
  console.log('  admin@demo.showly.us    / demo1234     (CLINIC_ADMIN, clinica demo)');
  console.log('  admin@demo-2.showly.us  / demo1234     (CLINIC_ADMIN, clinica SUSPENDED)');
  console.log('=================================================');
  console.log('Rotar los passwords desde el panel si el ambiente es real.');
}

main()
  .then(() => prisma.$disconnect())
  .catch((e) => {
    console.error('bootstrap-super failed:', e);
    prisma.$disconnect().finally(() => process.exit(1));
  });
