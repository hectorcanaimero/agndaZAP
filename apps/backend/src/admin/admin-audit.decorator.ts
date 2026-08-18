import { SetMetadata } from '@nestjs/common';
import { AdminAction } from '@prisma/client';

/**
 * Clave de metadata que el interceptor lee para saber qué persistir.
 * Se mantiene como constante exportada para que el interceptor no dependa
 * del string literal y sea renombrable sin romper nada.
 */
export const ADMIN_AUDIT_KEY = 'admin_audit';

export interface AdminAuditMeta {
  action: AdminAction;
  targetType: string;
  /**
   * Ruta punto-a-punto dentro del contexto de la request para extraer el
   * targetId. Soporta tres orígenes:
   *  - `'params.id'`    → req.params.id   (típico en PATCH /admin/clinics/:id)
   *  - `'body.id'`      → req.body.id     (típico en POST cuando el id viene en el body)
   *  - `'response.id'`  → resultado del handler (típico en CREATE — el id se conoce post-handler)
   */
  targetIdFrom: 'params.id' | 'body.id' | 'response.id';
}

/**
 * `@AdminAudit(...)` — marca un handler como auditable por `AdminAuditInterceptor`.
 *
 * Sólo tiene efecto en rutas donde el interceptor está activo. Su sola presencia
 * no audita nada; es el interceptor quien lee la metadata y persiste el registro.
 *
 * Ejemplo:
 * ```ts
 * @Patch(':id/suspend')
 * @AdminAudit({ action: AdminAction.SUSPEND_CLINIC, targetType: 'Clinic', targetIdFrom: 'params.id' })
 * suspend(@Param('id') id: string) { ... }
 * ```
 */
export const AdminAudit = (meta: AdminAuditMeta) =>
  SetMetadata(ADMIN_AUDIT_KEY, meta);
