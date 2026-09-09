import { expect, test } from '@playwright/test';
import { CLINIC_SLUG, SEED, uniquePhone } from './helpers';

/**
 * Smoke de la página pública `/es/agendar/demo` — replica el Escenario 3 de
 * `docs/smoke-e2e.md`. Selectores por id/rol/texto i18n (es.json) para no
 * depender de `data-testid` en `ScheduleForm.tsx`.
 */
test.describe('Página pública de agendamiento', () => {
  test('agenda una cita y llega a /gracias con fecha y hora', async ({
    page,
  }) => {
    await page.goto(`/es/agendar/${CLINIC_SLUG}`);
    await expect(page.getByText('Clínica Demo', { exact: true })).toBeVisible();

    // 1) Servicio (Radix Select: trigger por id, opción por rol+texto).
    await page.locator('#serviceId').click();
    await page
      .getByRole('option', { name: new RegExp(SEED.service) })
      .click();

    // 2) Profesional — obligatorio; recién ahí se cargan los slots.
    await page.locator('#professionalId').click();
    await page.getByRole('option', { name: SEED.professionalUi }).click();

    // 3) Primer slot disponible. Guardamos la hora para validarla en /gracias.
    const firstSlot = page.locator('button[data-slot]').first();
    await expect(firstSlot).toBeVisible();
    const slotTime = (await firstSlot.innerText()).trim();
    expect(slotTime).toMatch(/^\d{2}:\d{2}$/);
    await firstSlot.click();
    await expect(firstSlot).toHaveAttribute('aria-pressed', 'true');

    // 4) Datos del paciente + consentimiento.
    await page.locator('#name').fill('Paciente E2E');
    await page.locator('#phone').fill(uniquePhone());
    await page.locator('#consent').click();
    await expect(page.locator('#consent')).toHaveAttribute(
      'aria-checked',
      'true',
    );

    // 5) Submit → redirect a /gracias con ?date=&time=.
    await page.getByRole('button', { name: 'Confirmar cita' }).click();
    await page.waitForURL(
      new RegExp(`/es/agendar/${CLINIC_SLUG}/gracias\\?`),
    );

    const url = new URL(page.url());
    expect(url.searchParams.get('date')).toBeTruthy();
    expect(url.searchParams.get('time')).toBe(slotTime);

    // Copy de `thanks.subtitle` en es.json: "Tu cita quedó agendada para el
    // {date} a las {time}."
    await expect(
      page.getByText(/Tu cita quedó agendada para el .+ a las \d{2}:\d{2}\./),
    ).toBeVisible();
    await expect(
      page.getByRole('heading', { name: /¡Listo, Paciente!/ }),
    ).toBeVisible();
  });

  test('clínica inexistente responde 404 con "Clínica no encontrada"', async ({
    page,
  }) => {
    const response = await page.goto('/es/agendar/no-existe-e2e');
    expect(response?.status()).toBe(404);
    await expect(
      page.getByRole('heading', { name: 'Clínica no encontrada' }),
    ).toBeVisible();
  });
});
