import { AsyncLocalStorage } from 'node:async_hooks';
import { Injectable } from '@nestjs/common';

// Datos del contexto de request que quedan disponibles en toda la cadena
// async del handler (services, repos, BullMQ producers). Se popula en el
// RequestContextInterceptor a partir del JWT decoded (req.user) y del
// requestId generado por pino-http.
export type RequestContextData = {
  requestId: string;
  clinicId?: string;
  userId?: string;
  impersonatedBy?: string;
};

// Store singleton — Node crea uno por proceso, no por request. El aislamiento
// per-request lo hace `als.run(store, fn)`: cualquier `getStore()` dentro de
// `fn` (o de sus descendientes async) devuelve ese store específico.
export const requestContext = new AsyncLocalStorage<RequestContextData>();

// Wrapper inyectable — evita que services importen el ALS directamente y
// tener que testear con mocks del module. Los tests que necesiten simular un
// request context envuelven la aserción en `requestContext.run(store, () => ...)`.
@Injectable()
export class RequestContextService {
  get<K extends keyof RequestContextData>(key: K): RequestContextData[K] | undefined {
    return requestContext.getStore()?.[key];
  }

  getAll(): RequestContextData | undefined {
    return requestContext.getStore();
  }

  // Uso raro — normalmente el context se setea en el interceptor y no cambia.
  // Solo útil si un service enriquece el contexto downstream (ej. resolvió el
  // clinicId dinámicamente desde un slug público que no viene en el JWT).
  set<K extends keyof RequestContextData>(key: K, value: RequestContextData[K]): void {
    const store = requestContext.getStore();
    if (store) {
      store[key] = value;
    }
  }
}
