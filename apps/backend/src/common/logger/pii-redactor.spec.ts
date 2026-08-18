import { PassThrough } from 'node:stream';
import pino from 'pino';
import { PII_REDACT_CENSOR, PII_REDACT_OPTIONS } from './pii-redactor';

// Helper: crea un logger Pino que escribe a un buffer y devuelve el último
// JSON escrito. Simula el pipeline real de nuestra config.
function createTestLogger(): { log: pino.Logger; readLast: () => Record<string, unknown> } {
  const stream = new PassThrough();
  const chunks: string[] = [];
  stream.on('data', (chunk: Buffer) => chunks.push(chunk.toString()));

  const log = pino({ redact: PII_REDACT_OPTIONS, level: 'info' }, stream);

  return {
    log,
    readLast: () => {
      const raw = chunks.join('').trim().split('\n').pop() ?? '{}';
      return JSON.parse(raw) as Record<string, unknown>;
    },
  };
}

describe('PII redactor', () => {
  it('redacta email en el primer nivel', () => {
    const { log, readLast } = createTestLogger();
    log.info({ email: 'alice@example.com', userId: 'u-1' }, 'user login');
    const entry = readLast();
    expect(entry.email).toBe(PII_REDACT_CENSOR);
    expect(entry.userId).toBe('u-1');
  });

  it('redacta phone en el primer nivel', () => {
    const { log, readLast } = createTestLogger();
    log.info({ phone: '+5491122334455', patientId: 'p-1' }, 'sms sent');
    const entry = readLast();
    expect(entry.phone).toBe(PII_REDACT_CENSOR);
    expect(entry.patientId).toBe('p-1');
  });

  it('redacta password en req.body.password (path exacto)', () => {
    const { log, readLast } = createTestLogger();
    log.info(
      { req: { body: { password: 'super-secret', email: 'x@y.com' } } },
      'login attempt',
    );
    const entry = readLast();
    const req = entry.req as { body: Record<string, string> };
    expect(req.body.password).toBe(PII_REDACT_CENSOR);
  });

  it('redacta authorization en req.headers', () => {
    const { log, readLast } = createTestLogger();
    log.info(
      { req: { headers: { authorization: 'Bearer abc.def.ghi', host: 'x.com' } } },
      'request',
    );
    const entry = readLast();
    const req = entry.req as { headers: Record<string, string> };
    expect(req.headers.authorization).toBe(PII_REDACT_CENSOR);
    expect(req.headers.host).toBe('x.com');
  });

  it('redacta token en cualquier campo de primer nivel', () => {
    const { log, readLast } = createTestLogger();
    log.info({ token: 'jwt-eyxxx', refreshToken: 'refresh-xxx', userId: 'u-1' }, 'auth');
    const entry = readLast();
    expect(entry.token).toBe(PII_REDACT_CENSOR);
    expect(entry.refreshToken).toBe(PII_REDACT_CENSOR);
    expect(entry.userId).toBe('u-1');
  });

  it('redacta name, firstName, lastName, notes', () => {
    const { log, readLast } = createTestLogger();
    log.info(
      {
        name: 'Juan Pérez',
        firstName: 'Juan',
        lastName: 'Pérez',
        notes: 'alergia a penicilina',
        appointmentId: 'a-1',
      },
      'patient data',
    );
    const entry = readLast();
    expect(entry.name).toBe(PII_REDACT_CENSOR);
    expect(entry.firstName).toBe(PII_REDACT_CENSOR);
    expect(entry.lastName).toBe(PII_REDACT_CENSOR);
    expect(entry.notes).toBe(PII_REDACT_CENSOR);
    expect(entry.appointmentId).toBe('a-1');
  });

  it('NO redacta identificadores (patientId, clinicId, userId)', () => {
    const { log, readLast } = createTestLogger();
    log.info(
      { patientId: 'p-1', clinicId: 'c-1', userId: 'u-1', appointmentId: 'a-1' },
      'ids test',
    );
    const entry = readLast();
    expect(entry.patientId).toBe('p-1');
    expect(entry.clinicId).toBe('c-1');
    expect(entry.userId).toBe('u-1');
    expect(entry.appointmentId).toBe('a-1');
  });

  it('redacta payload.body (WhatsApp inbound WAHA)', () => {
    const { log, readLast } = createTestLogger();
    log.info(
      { payload: { body: 'Hola quiero un turno', from: '5491122334455@c.us' } },
      'waha message',
    );
    const entry = readLast();
    const payload = entry.payload as Record<string, string>;
    expect(payload.body).toBe(PII_REDACT_CENSOR);
    // from no está en la lista — permitido por diseño (necesario para trace).
    expect(payload.from).toBe('5491122334455@c.us');
  });

  it('redacta apiKey y secret en primer nivel', () => {
    const { log, readLast } = createTestLogger();
    log.info({ apiKey: 'sk-live-xxx', secret: 'hs-xxx', service: 'openai' }, 'call');
    const entry = readLast();
    expect(entry.apiKey).toBe(PII_REDACT_CENSOR);
    expect(entry.secret).toBe(PII_REDACT_CENSOR);
    expect(entry.service).toBe('openai');
  });

  it('deja pasar el msg y level intactos', () => {
    const { log, readLast } = createTestLogger();
    log.info({ email: 'x@y.com' }, 'this is the message');
    const entry = readLast();
    expect(entry.msg).toBe('this is the message');
    expect(entry.level).toBe(30); // pino level info = 30
  });
});
