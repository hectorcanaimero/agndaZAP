/**
 * Helpers de queryFn / mutationFn que envuelven el `fetcher` de auth.
 *
 * Motivo: `fetcher` devuelve un discriminated union `{ok:true,data} | {ok:false,status,message}`.
 * TanStack Query espera un `Promise<T>` que resuelva con la data o rechace con `Error`.
 * Estos wrappers hacen el bridge: si `ok:false`, tiran `ApiError` con `status`+`message`
 * para que `onError` de useMutation pueda discriminar por status (409/422/429/etc).
 *
 * Cero PII en logs — solo `status` viaja en el mensaje del Error, nunca body.
 */
import { fetcher, type FetcherOptions } from './auth';

/**
 * Error tipado con status HTTP + mensaje. Permite a los callers hacer
 * `if (err instanceof ApiError && err.status === 409)` en `onError`.
 */
export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

/**
 * queryFn genérico: devuelve la data o tira ApiError.
 */
export async function apiQuery<T = unknown>(
  path: string,
  options?: FetcherOptions,
): Promise<T> {
  const res = await fetcher<T>(path, options);
  if (!res.ok) {
    throw new ApiError(res.status, res.message);
  }
  return res.data;
}

/**
 * mutationFn helper para POST/PATCH/DELETE. Serializa el body como JSON.
 * Usa `undefined` body si no se pasa (útil para DELETE / POST sin payload).
 */
export async function apiMutation<TData = unknown, TVars = unknown>(
  path: string,
  method: 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  vars?: TVars,
): Promise<TData> {
  const res = await fetcher<TData>(path, {
    method,
    body: vars !== undefined ? JSON.stringify(vars) : undefined,
  });
  if (!res.ok) {
    throw new ApiError(res.status, res.message);
  }
  return res.data;
}
