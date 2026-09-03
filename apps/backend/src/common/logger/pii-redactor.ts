// Paths que Pino debe redactar antes de escribir un log.
//
// Sintaxis de Pino/fast-redact:
// - `field`         → campo directo en el objeto raíz del log entry
// - `path.to.field` → path exacto
// - `*.field`       → cualquier `field` en el segundo nivel (un hijo del root)
// - `path.*.field`  → wildcard en un nivel intermedio
//
// **IMPORTANTE:** Pino NO redacta recursivamente. Cuando hacemos
// `logger.info({ email, phone }, 'msg')`, esos campos aparecen en el ROOT del
// log entry — no cubiertos por `*.email`. Por eso necesitamos AMBOS: los
// root-level (sin prefix) y los first-level nested (`*.email`).
//
// Convención del proyecto: **loguear solo IDs**, nunca objetos anidados con
// datos personales. Este array es la red de seguridad.
export const PII_REDACT_PATHS: readonly string[] = [
  // --- Root level (log directo con campos sensibles al root del log entry) ---
  'password',
  'currentPassword',
  'newPassword',
  'token',
  'accessToken',
  'refreshToken',
  'secret',
  'apiKey',
  'authorization',
  'email',
  'phone',
  'name',
  'firstName',
  'lastName',
  'fullName',
  'notes',
  'reason',
  'address',
  'messageBody',

  // --- Arrays root-level comunes ---
  'patients[*].email',
  'patients[*].phone',
  'patients[*].name',
  'patients[*].firstName',
  'patients[*].lastName',
  'patients[*].fullName',
  'patients[*].notes',
  'appointments[*].notes',
  'messages[*].body',
  'messages[*].messageBody',

  // --- Headers exactos ---
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["set-cookie"]',
  'req.headers["x-api-key"]',

  // --- Auth / PII request body exactos ---
  'req.body.password',
  'req.body.currentPassword',
  'req.body.newPassword',
  'req.body.token',
  'req.body.accessToken',
  'req.body.refreshToken',
  'req.body.secret',
  'req.body.apiKey',
  'req.body.authorization',
  'req.body.email',
  'req.body.phone',
  'req.body.name',
  'req.body.firstName',
  'req.body.lastName',
  'req.body.fullName',
  'req.body.notes',
  'req.body.reason',
  'req.body.address',
  'req.body.messageBody',

  // --- Request body nested/arrays comunes ---
  'req.body.*.password',
  'req.body.*.token',
  'req.body.*.secret',
  'req.body.*.apiKey',
  'req.body.*.authorization',
  'req.body.*.email',
  'req.body.*.phone',
  'req.body.*.name',
  'req.body.*.firstName',
  'req.body.*.lastName',
  'req.body.*.fullName',
  'req.body.*.notes',
  'req.body.*.reason',
  'req.body.*.address',
  'req.body.*.messageBody',
  'req.body.patients[*].email',
  'req.body.patients[*].phone',
  'req.body.patients[*].name',
  'req.body.patients[*].firstName',
  'req.body.patients[*].lastName',
  'req.body.patients[*].fullName',
  'req.body.patients[*].notes',
  'req.body.appointments[*].notes',
  'req.body.messages[*].body',
  'req.body.messages[*].messageBody',

  // --- Response accidental leaks ---
  'res.body.token',
  'res.body.accessToken',
  'res.body.password',

  // --- WhatsApp payload (WAHA inbound) ---
  'payload.body',
  'payload.payload.body',

  // --- Wildcards nested primer nivel: cubren shapes como
  //     `{ user: { email, name } }` o `{ patient: { phone, notes } }` ---
  '*.password',
  '*.currentPassword',
  '*.newPassword',
  '*.token',
  '*.accessToken',
  '*.refreshToken',
  '*.secret',
  '*.apiKey',
  '*.authorization',
  '*.email',
  '*.phone',
  '*.name',
  '*.firstName',
  '*.lastName',
  '*.fullName',
  '*.notes',
  '*.reason',
  '*.address',
  '*.messageBody',
];

export const PII_REDACT_CENSOR = '[REDACTED]';

export const PII_REDACT_OPTIONS = {
  paths: [...PII_REDACT_PATHS],
  censor: PII_REDACT_CENSOR,
};
