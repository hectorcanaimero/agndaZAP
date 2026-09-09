import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright — smoke E2E de la página pública de agendamiento.
 *
 * NO levanta servidores (`webServer` deshabilitado): tanto en local
 * (`scripts/e2e-local.sh`) como en CI (job `e2e`) el backend y el web ya
 * están arriba antes de correr los tests. Motivo: el web necesita
 * `NEXT_PUBLIC_API_URL` horneado en `next build`, y el backend necesita
 * db+redis migrados y seedeados — orquestarlo desde acá duplicaría lógica.
 *
 * Env:
 * - `E2E_WEB_URL` (default http://localhost:3102) — baseURL del web.
 * - `E2E_API_URL` (default http://localhost:4102) — backend, para los tests
 *   que pegan directo al API vía `request` (sin navegador).
 *
 * Sólo chromium: es el único browser instalado en el VPS
 * (`~/.cache/ms-playwright/chromium-1243` ↔ @playwright/test 1.63.0).
 */
export default defineConfig({
  testDir: './e2e',
  // Serial: los tests crean citas reales contra el mismo seed; en paralelo
  // podrían pelear por el mismo slot y ensuciar el 201/409 esperado.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: process.env.CI
    ? [['list'], ['html', { open: 'never' }]]
    : [['list']],
  use: {
    baseURL: process.env.E2E_WEB_URL ?? 'http://localhost:3102',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    locale: 'es-VE',
    timezoneId: 'America/Caracas',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
