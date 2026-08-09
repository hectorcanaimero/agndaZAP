import { JwtService } from '@nestjs/jwt';

/**
 * Pin del algoritmo del JWT — defensa contra "algorithm confusion" a nivel
 * verify: aunque un atacante conociera el `JWT_SECRET`, si firma con otro
 * algoritmo simétrico (HS384/HS512) queremos que el token quede rechazado.
 *
 * `JwtStrategy` fuerza `algorithms: ['HS256']` en el super. Este spec valida
 * ese contrato reproduciendo lo que hace passport-jwt por debajo: `verify`
 * con `algorithms: ['HS256']` sobre un token HS512 debe tirar.
 *
 * Sin `algorithms` en `verify`, `jsonwebtoken` intenta con TODOS los soportados
 * — que es el default inseguro que estamos evitando.
 */
describe('JWT algorithm pinning (HS256 only)', () => {
  const secret = 'test-secret-shared-32-bytes-please-xxx';

  it('token firmado con HS512 usando el MISMO secret es rechazado al verificar con algorithms=[HS256]', async () => {
    const attackerSigner = new JwtService({
      secret,
      signOptions: { algorithm: 'HS512', expiresIn: '1h' },
    });
    const verifier = new JwtService({ secret });
    const token = await attackerSigner.signAsync({
      sub: 'user-1',
      clinicId: 'clinic-A',
      role: 'CLINIC_ADMIN',
    });
    // Espejo de la config de JwtStrategy: `algorithms: ['HS256']`.
    expect(() =>
      verifier.verify(token, { secret, algorithms: ['HS256'] }),
    ).toThrow();
  });

  it('token firmado con HS256 usando el mismo secret sí valida', async () => {
    const legit = new JwtService({
      secret,
      signOptions: { algorithm: 'HS256', expiresIn: '1h' },
    });
    const token = await legit.signAsync({
      sub: 'user-1',
      clinicId: 'clinic-A',
      role: 'CLINIC_ADMIN',
    });
    const decoded = legit.verify<{ sub: string }>(token, {
      secret,
      algorithms: ['HS256'],
    });
    expect(decoded.sub).toBe('user-1');
  });
});
