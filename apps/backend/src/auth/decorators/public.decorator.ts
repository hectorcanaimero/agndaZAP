import { SetMetadata } from '@nestjs/common';

/**
 * `@Public()` — opt-out del `JwtAuthGuard` global.
 *
 * El guard global corre en TODAS las rutas por defecto. Este decorator marca
 * una ruta (o controller) como no-autenticada y el guard la deja pasar sin
 * validar Bearer token.
 *
 * Usar en: `/auth/login`, `/webhooks/*`, y todo el `PublicController`.
 */
export const IS_PUBLIC_KEY = 'isPublic';
export const Public = (): MethodDecorator & ClassDecorator =>
  SetMetadata(IS_PUBLIC_KEY, true);
