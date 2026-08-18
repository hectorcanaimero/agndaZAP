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

  // --- Headers exactos ---
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["set-cookie"]',
  'req.headers["x-api-key"]',

  // --- Auth request body exactos ---
  'req.body.password',
  'req.body.currentPassword',
  'req.body.newPassword',
  'req.body.token',
  'req.body.refreshToken',

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
