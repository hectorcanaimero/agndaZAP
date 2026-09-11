import { Queue } from 'bullmq';
import type Redis from 'ioredis';
import { flushPrefix, makeIntRedis } from '../common/redis/redis.int-helper';

/**
 * Semántica de `jobId` en BullMQ, contra Redis real.
 *
 * No está aquí para probar BullMQ, sino para fijar el comportamiento del que
 * dependemos y que ya nos mordió: **un `add` con un `jobId` que ya existe es un
 * NO-OP silencioso**. No lanza, no reemplaza, no avisa.
 *
 * Por eso el `check-risk` podía quedarse rancio: `cancelForAppointment` borra el
 * job viejo con `.catch(() => undefined)` y `scheduleForAppointment` reencola
 * con el MISMO id; si el borrado fallaba, el `add` posterior no reemplazaba
 * nada y el job conservaba el delay del horario anterior. Ese es el motivo de
 * que ahora el job lleve `startAtMs` y el processor descarte los obsoletos.
 *
 * Un mock de BullMQ no puede enseñar esto: devolvería el job nuevo tan feliz.
 */
describe('[int] BullMQ: dedup por jobId', () => {
  const QUEUE = 'itest-jobid';
  let redis: Redis;
  let queue: Queue;

  beforeAll(() => {
    redis = makeIntRedis();
    const url = new URL(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379');
    queue = new Queue(QUEUE, {
      connection: { host: url.hostname, port: Number(url.port || 6379) },
    });
  });

  beforeEach(async () => {
    await queue.obliterate({ force: true });
  });

  afterAll(async () => {
    await queue.obliterate({ force: true }).catch(() => undefined);
    await queue.close();
    await flushPrefix(redis, `bull:${QUEUE}`);
    await redis.quit();
  });

  it('añadir dos veces el mismo jobId NO crea un segundo job', async () => {
    await queue.add('tarea', { v: 1 }, { jobId: 'mismo-id', delay: 60_000 });
    await queue.add('tarea', { v: 2 }, { jobId: 'mismo-id', delay: 5_000 });

    const jobs = await queue.getDelayed();

    expect(jobs).toHaveLength(1);
  });

  it('y el segundo add NO actualiza los datos ni el delay: gana el primero', async () => {
    // Este es el detalle peligroso. Quien escribe `add` cree que reprograma, y
    // en realidad no pasa nada: el job conserva el delay viejo.
    await queue.add('tarea', { v: 'original' }, { jobId: 'mismo-id', delay: 60_000 });
    await queue.add('tarea', { v: 'nuevo' }, { jobId: 'mismo-id', delay: 1_000 });

    const [job] = await queue.getDelayed();

    expect((job.data as { v: string }).v).toBe('original');
    expect(job.opts.delay).toBe(60_000);
  });

  it('el add duplicado tampoco lanza: falla en silencio', async () => {
    await queue.add('tarea', {}, { jobId: 'mismo-id', delay: 60_000 });

    await expect(
      queue.add('tarea', {}, { jobId: 'mismo-id', delay: 60_000 }),
    ).resolves.toBeDefined();
  });

  it('borrando el job primero, el add SÍ reprograma — que es el camino correcto', async () => {
    await queue.add('tarea', { v: 'original' }, { jobId: 'mismo-id', delay: 60_000 });

    const viejo = await queue.getJob('mismo-id');
    await viejo?.remove();
    await queue.add('tarea', { v: 'nuevo' }, { jobId: 'mismo-id', delay: 1_000 });

    const [job] = await queue.getDelayed();
    expect((job.data as { v: string }).v).toBe('nuevo');
  });

  it('jobIds distintos conviven', async () => {
    await queue.add('tarea', {}, { jobId: 'id-a', delay: 60_000 });
    await queue.add('tarea', {}, { jobId: 'id-b', delay: 60_000 });

    expect(await queue.getDelayed()).toHaveLength(2);
  });
});
