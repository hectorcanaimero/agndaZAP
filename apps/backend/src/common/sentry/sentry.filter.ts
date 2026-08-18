import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import { BaseExceptionFilter, HttpAdapterHost } from '@nestjs/core';
import * as Sentry from '@sentry/nestjs';
import { requestContext } from '../logger/request-context';
import { isSentryEnabled } from './sentry.config';

// Filter global que reporta a Sentry TODA exception no controlada, mientras
// deja que el BaseExceptionFilter de Nest maneje la respuesta HTTP normal.
//
// Reglas:
// - HttpException con status < 500 (400/401/403/404/409/etc.) NO se envía a
//   Sentry — son errores de validación / negocio esperados. Los 500+ sí.
// - Errores no-HttpException (throw Error nativos, TypeError, etc.) SIEMPRE
//   se envían — indican bugs.
// - Tags: clinicId, userId, impersonatedBy, route → hacen filtrable el
//   dashboard de Sentry por tenant.
// - `user.id` (Sentry user context) se popula con userId — permite ver
//   cuántos usuarios distintos afectó un bug.
// - `extra.requestId` (no-indexed) permite cross-referenciar con logs de Axiom.
@Injectable()
@Catch()
export class SentryFilter extends BaseExceptionFilter implements ExceptionFilter {
  constructor(httpAdapterHost: HttpAdapterHost) {
    super(httpAdapterHost.httpAdapter);
  }

  catch(exception: unknown, host: ArgumentsHost): void {
    if (isSentryEnabled() && this.shouldReport(exception)) {
      this.reportToSentry(exception, host);
    }
    // Delega la respuesta HTTP al filter default de Nest — no cambiamos el
    // comportamiento visible al cliente.
    super.catch(exception, host);
  }

  private shouldReport(exception: unknown): boolean {
    if (exception instanceof HttpException) {
      // Errores de negocio esperados (400-499) no van a Sentry.
      return exception.getStatus() >= HttpStatus.INTERNAL_SERVER_ERROR;
    }
    // Errores nativos (Error, TypeError, ReferenceError, Prisma errors, etc.)
    // siempre se reportan.
    return true;
  }

  private reportToSentry(exception: unknown, host: ArgumentsHost): void {
    const store = requestContext.getStore();

    // Ruta desde el request (si es contexto HTTP). En jobs de BullMQ y otros
    // contextos no hay route — el reporte de esos casos vive en los workers.
    let route: string | undefined;
    if (host.getType() === 'http') {
      const req = host.switchToHttp().getRequest<{
        route?: { path?: string };
        url?: string;
      }>();
      route = req.route?.path ?? req.url;
    }

    const tags: Record<string, string> = {};
    if (store?.clinicId) tags.clinicId = store.clinicId;
    if (store?.userId) tags.userId = store.userId;
    if (store?.impersonatedBy) tags.impersonatedBy = store.impersonatedBy;
    if (route) tags.route = route;

    Sentry.captureException(exception, {
      tags,
      user: store?.userId ? { id: store.userId } : undefined,
      extra: store?.requestId ? { requestId: store.requestId } : undefined,
    });
  }
}
