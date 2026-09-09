import { expect, test } from '@playwright/test';
import {
  API_URL,
  CLINIC_SLUG,
  SEED,
  todayInClinicTZ,
  uniquePhone,
  waitForFreshRateLimitBucket,
} from './helpers';

interface PublicClinic {
  services: Array<{ id: string; name: string }>;
  professionals: Array<{ id: string; name: string; serviceIds: string[] }>;
}

/**
 * Doble booking del mismo slot vía API pública (sin navegador). Usa un
 * profesional distinto al del spec de UI para no competir por el mismo slot.
 * El backend responde 409 (`ConflictException`) en la segunda creación.
 */
test('POST appointments dos veces en el mismo slot → 201 y luego 409', async ({
  request,
}) => {
  // La espera del bucket puede tardar hasta 60 s; ampliamos el timeout.
  test.setTimeout(120_000);
  // Contador de rate-limit limpio: ver `waitForFreshRateLimitBucket`.
  await waitForFreshRateLimitBucket();

  const clinicRes = await request.get(
    `${API_URL}/api/public/clinics/${CLINIC_SLUG}`,
  );
  expect(clinicRes.status()).toBe(200);
  const clinic = (await clinicRes.json()) as PublicClinic;

  const service = clinic.services.find((s) => s.name === SEED.service);
  const professional = clinic.professionals.find(
    (p) => p.name === SEED.professionalApi,
  );
  expect(service, `seed sin servicio "${SEED.service}"`).toBeTruthy();
  expect(professional, `seed sin profesional "${SEED.professionalApi}"`).toBeTruthy();

  const qs = new URLSearchParams({
    serviceId: service!.id,
    professionalId: professional!.id,
    from: todayInClinicTZ(),
    days: '7',
  });
  const availRes = await request.get(
    `${API_URL}/api/public/clinics/${CLINIC_SLUG}/availability?${qs}`,
  );
  expect(availRes.status()).toBe(200);
  const slots = (await availRes.json()) as Array<{ startAt: string }>;
  expect(slots.length, 'sin slots disponibles en 7 días').toBeGreaterThan(0);

  // Último slot de la lista: el spec de UI toma el primero del otro
  // profesional; acá vamos al otro extremo por si algún día comparten agenda.
  const startAtISO = slots[slots.length - 1]!.startAt;
  const payload = {
    name: 'Paciente E2E API',
    phone: uniquePhone(),
    consent: true,
    serviceId: service!.id,
    professionalId: professional!.id,
    startAtISO,
  };

  const first = await request.post(
    `${API_URL}/api/public/clinics/${CLINIC_SLUG}/appointments`,
    { data: payload },
  );
  expect(first.status()).toBe(201);
  const created = (await first.json()) as { id: string; startAt: string };
  expect(created.id).toBeTruthy();
  expect(new Date(created.startAt).toISOString()).toBe(
    new Date(startAtISO).toISOString(),
  );

  const second = await request.post(
    `${API_URL}/api/public/clinics/${CLINIC_SLUG}/appointments`,
    { data: { ...payload, phone: uniquePhone() } },
  );
  expect(second.status()).toBe(409);
});
