import { expect, test } from '@playwright/test';
import { CLINIC_SLUG, SEED, uniquePhone, waitForFreshRateLimitBucket } from './helpers';

/**
 * E2E de la gestión de cita por link (M2-b): crear una cita, sacar el link de
 * gestión de `/gracias`, cambiar el horario y cancelar.
 *
 * Cubre los endpoints de M2-a (`GET/POST …/appointments/manage/:token`), ya en
 * `main` desde el merge de #55.
 *
 * El link lleva un token bearer y por eso NO viaja en la query string: el web
 * lo pasa por `sessionStorage` (`agz.thanks.manageUrl`), igual que el nombre
 * del paciente. El spec lo lee de ahí, que es justamente el contrato que
 * queremos cubrir.
 */
test.describe('Gestión de cita por link', () => {
  test('crea la cita, cambia el horario y la cancela desde el link', async ({
    page,
  }) => {
    // `waitForFreshRateLimitBucket` puede esperar hasta 60 s (lo que falte
    // para el siguiente minuto), y el presupuesto por test son 60 s: con el
    // timeout por defecto el test se agotaba ANTES de la primera acción.
    // El trace del run 34646321521 lo enseña sin ambigüedad — el primer clic
    // sale en el segundo 60,3. El mensaje que se veía ("element is not
    // stable") era sólo dónde pilló el reloj, no la causa.
    test.setTimeout(150_000);

    await waitForFreshRateLimitBucket();

    // ── 1) Crear una cita por la página pública ──
    await page.goto(`/es/agendar/${CLINIC_SLUG}`);
    // Esperar a que la página esté pintada antes de tocarla, igual que
    // `agendar.spec.ts`: si se hace clic mientras el layout todavía se asienta,
    // Radix abre el desplegable y la opción no llega a estar "stable".
    await expect(page.getByText('Clínica Demo', { exact: true })).toBeVisible();

    await page.locator('#serviceId').click();
    await page.getByRole('option', { name: new RegExp(SEED.service) }).click();
    await page.locator('#professionalId').click();
    await page.getByRole('option', { name: SEED.professionalUi }).click();

    const firstSlot = page.locator('button[data-slot]').first();
    await expect(firstSlot).toBeVisible();
    const originalTime = (await firstSlot.innerText()).trim();
    await firstSlot.click();

    await page.locator('#name').fill('Paciente Gestión E2E');
    await page.locator('#phone').fill(uniquePhone());
    await page.locator('#consent').check();
    await page.getByRole('button', { name: /confirmar/i }).click();

    await expect(page).toHaveURL(/\/gracias/);

    // ── 2) El link de gestión ──
    //
    // Se lee del enlace pintado, NO de `sessionStorage`: `ThanksManageLink`
    // consume la clave al montarse (para no dejar un token bearer ahí
    // indefinidamente), así que cuando el test miraba ya no estaba y el
    // `manageUrl` salía `null`. Además, leer el href prueba lo que el paciente
    // ve de verdad en vez de un detalle de implementación.
    const manageLink = page.getByRole('link', { name: /ver o cambiar mi cita/i });
    await expect(manageLink).toBeVisible();
    const manageUrl = await manageLink.getAttribute('href');
    expect(manageUrl, 'el backend debe devolver manageUrl').toBeTruthy();

    // El token es una credencial: no puede acabar en la URL de /gracias, que
    // se queda en el historial y en el Referer. Se comprueba el VALOR concreto
    // del token, no un patrón: buscar `t=` matchea `star t=` de `start=`, que
    // es un parámetro legítimo de esa página.
    const token = new URL(manageUrl!, page.url()).searchParams.get('t');
    expect(token, 'el manageUrl debe llevar el token en `t`').toBeTruthy();
    expect(page.url(), 'el token no puede ir en la query de /gracias').not.toContain(
      token!,
    );

    // ── 3) La página de gestión muestra la cita ──
    await page.goto(manageUrl!);
    await expect(page.getByRole('heading', { name: 'Tu cita' })).toBeVisible();
    await expect(page.getByText(SEED.service)).toBeVisible();

    // ── 4) Cambiar horario: elegimos uno distinto al actual ──
    await page.getByRole('button', { name: /cambiar horario/i }).click();
    // La disponibilidad no devuelve el slot propio (está ocupado por esta
    // cita), así que el primero ya es distinto del actual.
    const newSlot = page.locator('button[data-slot]').first();
    await expect(newSlot).toBeVisible();
    const newTime = (await newSlot.innerText()).trim();
    expect(newTime).not.toBe(originalTime);
    await newSlot.click();

    // Mover la cita es irreversible desde el lado del paciente: se confirma.
    await page.getByRole('button', { name: /sí, cambiar/i }).click();

    await expect(page.getByText(/cambiamos tu cita/i)).toBeVisible();
    // Scopeado al resumen: `getByText(newTime)` a secas casaría también con el
    // botón del slot.
    await expect(page.locator('dd').filter({ hasText: newTime })).toBeVisible();

    // El token viejo se invalida al reagendar: la URL tiene que haber quedado
    // con el nuevo, o un refresh mataría la página.
    //
    // Con `expect(page).toHaveURL`, que reintenta, y NO con un `page.url()`
    // leído una sola vez: el aviso de éxito lo pinta el estado de React, pero
    // la URL la cambia `router.replace` un instante después. Leyéndolo de
    // golpe, el test pasaba aislado y fallaba en la suite completa — la
    // diferencia era sólo la carga de la máquina.
    await expect(page).toHaveURL(/\?t=/);
    await expect(page).not.toHaveURL(manageUrl!);

    // ── 5) Cancelar, con confirmación ──
    await page.getByRole('button', { name: /cancelar cita/i }).click();
    await page.getByRole('button', { name: /sí, cancelar/i }).click();

    await expect(page.getByText(/cancelamos tu cita/i)).toBeVisible();
    // Ya cancelada: no se ofrecen más acciones.
    await expect(
      page.getByRole('button', { name: /cambiar horario/i }),
    ).toHaveCount(0);
  });

});

/**
 * Estos dos NO dependen de M2-a: la pantalla de link vencido se pinta cuando
 * el GET devuelve 404, y eso ya pasa hoy (la ruta ni existe). Corren siempre.
 */
test.describe('Gestión de cita — link inválido', () => {
  test('un token inválido muestra la pantalla de link vencido, sin filtrar el motivo', async ({
    page,
  }) => {
    await page.goto(`/es/agendar/${CLINIC_SLUG}/cita?t=token-que-no-existe`);
    await expect(
      page.getByRole('heading', { name: /link ya no es válido/i }),
    ).toBeVisible();
    await expect(page.getByRole('link', { name: /agendar una cita/i })).toBeVisible();
  });

  test('sin token muestra la misma pantalla que con token inválido', async ({
    page,
  }) => {
    await page.goto(`/es/agendar/${CLINIC_SLUG}/cita`);
    await expect(
      page.getByRole('heading', { name: /link ya no es válido/i }),
    ).toBeVisible();
  });
});
