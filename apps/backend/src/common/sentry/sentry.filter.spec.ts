import {
  ArgumentsHost,
  BadRequestException,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import * as Sentry from '@sentry/nestjs';
import { requestContext } from '../logger/request-context';
import { SentryFilter } from './sentry.filter';

jest.mock('@sentry/nestjs', () => ({
  captureException: jest.fn(),
}));

// Habilitamos el flag para que `isSentryEnabled()` devuelva true en tests.
process.env.SENTRY_ENABLED = 'true';
process.env.SENTRY_DSN = 'https://test@sentry.io/0';

// Mock del HttpAdapterHost — el BaseExceptionFilter necesita `httpAdapter` para
// reply(). Le damos un fake que no hace nada.
function makeAdapterHost(): HttpAdapterHost {
  return {
    httpAdapter: {
      getRequestUrl: () => '/',
      getRequestMethod: () => 'GET',
      reply: jest.fn(),
    },
  } as unknown as HttpAdapterHost;
}

// Contexto HTTP fake — el filter llama a switchToHttp().getRequest().
function makeHttpHost(req: Record<string, unknown> = {}): ArgumentsHost {
  return {
    getType: () => 'http',
    switchToHttp: () => ({
      getRequest: () => req,
      getResponse: () => ({ status: () => ({ json: jest.fn() }) }),
      getNext: () => undefined,
    }),
    getArgByIndex: jest.fn(),
    getArgs: jest.fn(),
    switchToRpc: jest.fn(),
    switchToWs: jest.fn(),
  } as unknown as ArgumentsHost;
}

describe('SentryFilter', () => {
  let filter: SentryFilter;
  const captureExceptionMock = Sentry.captureException as jest.Mock;

  beforeEach(() => {
    filter = new SentryFilter(makeAdapterHost());
    captureExceptionMock.mockClear();
    // Silenciar el super.catch() para que no intente escribir en response
    // en cada test. Los tests validan el reporte a Sentry, no la respuesta HTTP.
    jest
      .spyOn(Object.getPrototypeOf(Object.getPrototypeOf(filter)), 'catch')
      .mockImplementation(() => undefined);
  });

  describe('shouldReport', () => {
    it('NO envía HttpException 400', () => {
      filter.catch(new BadRequestException('bad'), makeHttpHost());
      expect(captureExceptionMock).not.toHaveBeenCalled();
    });

    it('NO envía HttpException 404', () => {
      filter.catch(new NotFoundException('nope'), makeHttpHost());
      expect(captureExceptionMock).not.toHaveBeenCalled();
    });

    it('envía HttpException 500', () => {
      filter.catch(new InternalServerErrorException('boom'), makeHttpHost());
      expect(captureExceptionMock).toHaveBeenCalledTimes(1);
    });

    it('envía Error nativo (no HttpException)', () => {
      filter.catch(new Error('unhandled'), makeHttpHost());
      expect(captureExceptionMock).toHaveBeenCalledTimes(1);
    });

    it('envía TypeError', () => {
      filter.catch(new TypeError('bug'), makeHttpHost());
      expect(captureExceptionMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('tags y user context', () => {
    it('incluye clinicId, userId, route cuando hay request context', () => {
      requestContext.run(
        {
          requestId: 'req-1',
          clinicId: 'clinic-abc',
          userId: 'user-xyz',
        },
        () => {
          filter.catch(
            new Error('boom'),
            makeHttpHost({ url: '/api/patients/x' }),
          );
        },
      );

      expect(captureExceptionMock).toHaveBeenCalledTimes(1);
      const [err, context] = captureExceptionMock.mock.calls[0];
      expect(err).toBeInstanceOf(Error);
      expect(context.tags.clinicId).toBe('clinic-abc');
      expect(context.tags.userId).toBe('user-xyz');
      expect(context.tags.route).toBe('/api/patients/x');
      expect(context.user).toEqual({ id: 'user-xyz' });
      expect(context.extra.requestId).toBe('req-1');
    });

    it('incluye impersonatedBy cuando es JWT de impersonation', () => {
      requestContext.run(
        {
          requestId: 'req-2',
          clinicId: 'clinic-target',
          userId: 'super-1',
          impersonatedBy: 'super-1',
        },
        () => {
          filter.catch(new Error('boom'), makeHttpHost({ url: '/api/x' }));
        },
      );

      const [, context] = captureExceptionMock.mock.calls[0];
      expect(context.tags.impersonatedBy).toBe('super-1');
    });

    it('funciona sin request context (endpoint público que crasheó)', () => {
      filter.catch(new Error('unauth boom'), makeHttpHost({ url: '/public' }));

      expect(captureExceptionMock).toHaveBeenCalledTimes(1);
      const [, context] = captureExceptionMock.mock.calls[0];
      expect(context.tags.clinicId).toBeUndefined();
      expect(context.tags.userId).toBeUndefined();
      expect(context.tags.route).toBe('/public');
      expect(context.user).toBeUndefined();
      expect(context.extra).toBeUndefined();
    });
  });

  describe('kill switch', () => {
    it('NO reporta si SENTRY_ENABLED=false', () => {
      const prev = process.env.SENTRY_ENABLED;
      process.env.SENTRY_ENABLED = 'false';
      try {
        filter.catch(new Error('boom'), makeHttpHost());
        expect(captureExceptionMock).not.toHaveBeenCalled();
      } finally {
        process.env.SENTRY_ENABLED = prev;
      }
    });
  });
});
