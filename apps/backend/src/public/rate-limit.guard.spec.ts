import type { ExecutionContext } from '@nestjs/common';
import type Redis from 'ioredis';
import { RateLimit } from './rate-limit.guard';

/**
 * La clave Redis debe separar scope, slug e IP: si dos endpoints públicos
 * comparten bucket, el POST de reserva (límite 5) cuenta también los GET de
 * la misma página y el paciente recibe 429 al confirmar.
 */
function makeRedis(count = 1) {
  const incr = jest.fn().mockReturnThis();
  const expire = jest.fn().mockReturnThis();
  const exec = jest.fn().mockResolvedValue([
    [null, count],
    [null, 1],
  ]);
  const pipeline = jest.fn(() => ({ incr, expire, exec }));
  return { redis: { pipeline } as unknown as Redis, incr };
}

function makeContext(params: Record<string, string>, ip = '203.0.113.7') {
  const req = { params, ip, headers: {}, socket: { remoteAddress: ip } };
  const res = { setHeader: jest.fn() };
  return {
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
  } as unknown as ExecutionContext;
}

describe('RateLimit guard — clave por scope + slug + ip', () => {
  const keyOf = (incr: jest.Mock): string => incr.mock.calls[0][0] as string;

  it('dos endpoints con scope distinto y mismo slug/ip usan claves distintas', async () => {
    const a = makeRedis();
    const b = makeRedis();
    const GuardA = RateLimit(30, 'public-availability');
    const GuardB = RateLimit(5, 'public-book');
    await new GuardA(a.redis).canActivate(makeContext({ slug: 'demo' }));
    await new GuardB(b.redis).canActivate(makeContext({ slug: 'demo' }));
    expect(keyOf(a.incr)).toMatch(/^ratelimit:public-availability:demo:203\.0\.113\.7:\d+$/);
    expect(keyOf(b.incr)).toMatch(/^ratelimit:public-book:demo:203\.0\.113\.7:\d+$/);
    expect(keyOf(a.incr)).not.toBe(keyOf(b.incr));
  });

  it('el mismo scope con slugs distintos no comparte bucket', async () => {
    const a = makeRedis();
    const b = makeRedis();
    const Guard = RateLimit(5, 'public-book');
    await new Guard(a.redis).canActivate(makeContext({ slug: 'demo' }));
    await new Guard(b.redis).canActivate(makeContext({ slug: 'otra' }));
    expect(keyOf(a.incr)).not.toBe(keyOf(b.incr));
  });

  it('sin scope ni slug cae a "default"', async () => {
    const a = makeRedis();
    const Guard = RateLimit(10);
    await new Guard(a.redis).canActivate(makeContext({}));
    expect(keyOf(a.incr)).toMatch(/^ratelimit:default:/);
  });

  it('devuelve 429 al superar el límite', async () => {
    const a = makeRedis(6);
    const Guard = RateLimit(5, 'public-book');
    await expect(
      new Guard(a.redis).canActivate(makeContext({ slug: 'demo' })),
    ).rejects.toMatchObject({ status: 429 });
  });
});
