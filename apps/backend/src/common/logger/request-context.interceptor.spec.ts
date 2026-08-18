import { CallHandler, ExecutionContext } from '@nestjs/common';
import { firstValueFrom, of } from 'rxjs';
import { requestContext } from './request-context';
import { RequestContextInterceptor } from './request-context.interceptor';

// Helper: construye un ExecutionContext HTTP mínimo con el request pasado.
function mockHttpContext(req: Record<string, unknown>): ExecutionContext {
  return {
    getType: () => 'http',
    switchToHttp: () => ({
      getRequest: () => req,
      getResponse: () => ({}),
      getNext: () => ({}),
    }),
  } as unknown as ExecutionContext;
}

// CallHandler que, dentro de su handler, captura el snapshot del store.
function makeCaptureHandler(): {
  handler: CallHandler;
  getCaptured: () => Record<string, unknown> | undefined;
} {
  let captured: Record<string, unknown> | undefined;
  const handler: CallHandler = {
    handle: () => {
      captured = requestContext.getStore()
        ? { ...requestContext.getStore() }
        : undefined;
      return of('ok');
    },
  };
  return { handler, getCaptured: () => captured };
}

describe('RequestContextInterceptor', () => {
  let interceptor: RequestContextInterceptor;

  beforeEach(() => {
    interceptor = new RequestContextInterceptor();
  });

  it('propaga requestId desde req.id (populado por pino-http)', async () => {
    const req = { id: 'req-abc-123', headers: {} };
    const { handler, getCaptured } = makeCaptureHandler();

    await firstValueFrom(interceptor.intercept(mockHttpContext(req), handler));

    expect(getCaptured()).toEqual({ requestId: 'req-abc-123' });
  });

  it('cae al header x-request-id si req.id no está', async () => {
    const req = { headers: { 'x-request-id': 'header-xyz' } };
    const { handler, getCaptured } = makeCaptureHandler();

    await firstValueFrom(interceptor.intercept(mockHttpContext(req), handler));

    expect(getCaptured()?.requestId).toBe('header-xyz');
  });

  it('genera un UUID si no hay req.id ni header', async () => {
    const req = { headers: {} };
    const { handler, getCaptured } = makeCaptureHandler();

    await firstValueFrom(interceptor.intercept(mockHttpContext(req), handler));

    const captured = getCaptured();
    expect(captured?.requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it('extrae clinicId y userId cuando hay JWT autenticado (CLINIC_ADMIN)', async () => {
    const req = {
      id: 'req-1',
      headers: {},
      user: {
        userId: 'user-abc',
        clinicId: 'clinic-xyz',
        role: 'CLINIC_ADMIN',
      },
    };
    const { handler, getCaptured } = makeCaptureHandler();

    await firstValueFrom(interceptor.intercept(mockHttpContext(req), handler));

    expect(getCaptured()).toEqual({
      requestId: 'req-1',
      clinicId: 'clinic-xyz',
      userId: 'user-abc',
    });
  });

  it('incluye impersonatedBy cuando el JWT es de impersonation', async () => {
    const req = {
      id: 'req-2',
      headers: {},
      user: {
        userId: 'super-1',
        clinicId: 'clinic-target',
        impersonatedBy: 'super-1',
        role: 'CLINIC_ADMIN',
      },
    };
    const { handler, getCaptured } = makeCaptureHandler();

    await firstValueFrom(interceptor.intercept(mockHttpContext(req), handler));

    expect(getCaptured()).toEqual({
      requestId: 'req-2',
      clinicId: 'clinic-target',
      userId: 'super-1',
      impersonatedBy: 'super-1',
    });
  });

  it('deja el store SOLO con requestId cuando el endpoint es público (sin req.user)', async () => {
    const req = { id: 'req-public', headers: {} };
    const { handler, getCaptured } = makeCaptureHandler();

    await firstValueFrom(interceptor.intercept(mockHttpContext(req), handler));

    expect(getCaptured()).toEqual({ requestId: 'req-public' });
  });

  it('no toca el flujo cuando no es HTTP (retorna next.handle() directo)', async () => {
    const nonHttpContext = {
      getType: () => 'rpc',
    } as unknown as ExecutionContext;

    const { handler } = makeCaptureHandler();
    const value = await firstValueFrom(
      interceptor.intercept(nonHttpContext, handler),
    );

    expect(value).toBe('ok');
  });
});
