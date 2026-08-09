import * as bcrypt from 'bcrypt';

/**
 * password.util — helpers de hashing.
 *
 * Usamos bcrypt con **10 rounds**: es el sweet-spot para MVP entre resistencia
 * a fuerza bruta y costo por login (~100 ms en hardware moderno). Subir a 12+
 * cuando/si el volumen de logins simultáneos lo permita sin degradar UX.
 *
 * NUNCA imprimir el hash en logs ni en respuestas HTTP.
 */
const BCRYPT_ROUNDS = 10;

export function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, BCRYPT_ROUNDS);
}

export function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

/**
 * Hash "dummy" precomputado usado para mitigar timing attacks en el login:
 * si el email no existe, igual comparamos contra este hash para que el
 * tiempo de respuesta sea consistente con el caso email-existe-password-mala.
 *
 * Generado con bcrypt.hash('dummy', 10) en dev. El valor concreto no importa
 * (nunca autentica a nadie porque `verifyPassword('*', dummyHash)` es siempre
 * false salvo colisión imposible con 'dummy', y el AuthService nunca deja
 * pasar por esta rama).
 */
export const DUMMY_HASH =
  '$2b$10$C6UzMDM.H6dfI/f/IKcEeuJj9EHRPP6O0K1G9Ei8kZzGSb0hn0iVW';
