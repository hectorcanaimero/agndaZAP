import { PII_REDACT_CENSOR } from './pii-redactor';
import { createRedactingLogger } from './testing/redaction-harness';

// El logger de prueba vive en `testing/redaction-harness.ts`, compartido con
// `redaction-events.spec.ts`, que comprueba que los eventos estructurados
// sobrevivan enteros a esta misma redacción.

describe('PII redactor', () => {
  it('redacta email en el primer nivel', () => {
    const { log, readLast } = createRedactingLogger();
    log.info({ email: 'alice@example.com', userId: 'u-1' }, 'user login');
    const entry = readLast();
    expect(entry.email).toBe(PII_REDACT_CENSOR);
    expect(entry.userId).toBe('u-1');
  });

  it('redacta phone en el primer nivel', () => {
    const { log, readLast } = createRedactingLogger();
    log.info({ phone: '+5491122334455', patientId: 'p-1' }, 'sms sent');
    const entry = readLast();
    expect(entry.phone).toBe(PII_REDACT_CENSOR);
    expect(entry.patientId).toBe('p-1');
  });

  it('redacta password en req.body.password (path exacto)', () => {
    const { log, readLast } = createRedactingLogger();
    log.info(
      { req: { body: { password: 'super-secret', email: 'x@y.com' } } },
      'login attempt',
    );
    const entry = readLast();
    const req = entry.req as { body: Record<string, string> };
    expect(req.body.password).toBe(PII_REDACT_CENSOR);
  });

  it('redacta authorization en req.headers', () => {
    const { log, readLast } = createRedactingLogger();
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
    const { log, readLast } = createRedactingLogger();
    log.info({ token: 'jwt-eyxxx', refreshToken: 'refresh-xxx', userId: 'u-1' }, 'auth');
    const entry = readLast();
    expect(entry.token).toBe(PII_REDACT_CENSOR);
    expect(entry.refreshToken).toBe(PII_REDACT_CENSOR);
    expect(entry.userId).toBe('u-1');
  });

  it('redacta name, firstName, lastName, notes', () => {
    const { log, readLast } = createRedactingLogger();
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


  it('redacta PII en req.body sin romper el objeto estructurado', () => {
    const { log, readLast } = createRedactingLogger();
    log.info(
      {
        req: {
          body: {
            name: 'Juan Pérez',
            email: 'juan@example.com',
            phone: '+5491122334455',
            serviceId: 'svc-1',
          },
        },
      },
      'patient request',
    );
    const entry = readLast();
    const req = entry.req as { body: Record<string, string> };
    expect(req.body.name).toBe(PII_REDACT_CENSOR);
    expect(req.body.email).toBe(PII_REDACT_CENSOR);
    expect(req.body.phone).toBe(PII_REDACT_CENSOR);
    expect(req.body.serviceId).toBe('svc-1');
  });

  it('redacta PII en arrays comunes conservando IDs para diagnóstico', () => {
    const { log, readLast } = createRedactingLogger();
    log.info(
      {
        patients: [
          {
            patientId: 'patient-1',
            name: 'Ana',
            phone: '+5491199988877',
          },
        ],
        req: {
          body: {
            patients: [
              {
                patientId: 'patient-2',
                email: 'ana@example.com',
                notes: 'alergia',
              },
            ],
          },
        },
      },
      'bulk patients',
    );
    const entry = readLast() as {
      patients: Array<Record<string, string>>;
      req: { body: { patients: Array<Record<string, string>> } };
    };
    expect(entry.patients[0].patientId).toBe('patient-1');
    expect(entry.patients[0].name).toBe(PII_REDACT_CENSOR);
    expect(entry.patients[0].phone).toBe(PII_REDACT_CENSOR);
    expect(entry.req.body.patients[0].patientId).toBe('patient-2');
    expect(entry.req.body.patients[0].email).toBe(PII_REDACT_CENSOR);
    expect(entry.req.body.patients[0].notes).toBe(PII_REDACT_CENSOR);
  });

  it('NO redacta identificadores (patientId, clinicId, userId)', () => {
    const { log, readLast } = createRedactingLogger();
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
    const { log, readLast } = createRedactingLogger();
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
    const { log, readLast } = createRedactingLogger();
    log.info({ apiKey: 'sk-live-xxx', secret: 'hs-xxx', service: 'openai' }, 'call');
    const entry = readLast();
    expect(entry.apiKey).toBe(PII_REDACT_CENSOR);
    expect(entry.secret).toBe(PII_REDACT_CENSOR);
    expect(entry.service).toBe('openai');
  });

  it('deja pasar el msg y level intactos', () => {
    const { log, readLast } = createRedactingLogger();
    log.info({ email: 'x@y.com' }, 'this is the message');
    const entry = readLast();
    expect(entry.msg).toBe('this is the message');
    expect(entry.level).toBe(30); // pino level info = 30
  });

});
