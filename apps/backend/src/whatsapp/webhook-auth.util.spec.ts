import { createHmac } from 'node:crypto';
import { ForbiddenException } from '@nestjs/common';
import { verifyWebhookAuth } from './webhook-auth.util';

const SECRET = 'test-secret-abc';
const TOKEN = 'shared-token-xyz';

// Body de test — el HMAC debe calcularse sobre estos bytes exactos.
const RAW_BODY = Buffer.from('{"event":"message","session":"clinic-1"}', 'utf-8');

function makeSig(secret: string, body: Buffer, prefix?: 'sha256=' | ''): string {
  const digest = createHmac('sha256', secret).update(body).digest('hex');
  return `${prefix ?? ''}${digest}`;
}

describe('verifyWebhookAuth', () => {
  describe('mecanismo 1: HMAC', () => {
    it('acepta HMAC válido sin prefijo', () => {
      const result = verifyWebhookAuth({
        rawBody: RAW_BODY,
        token: undefined,
        hmacHeader: makeSig(SECRET, RAW_BODY),
        hmacSecret: SECRET,
        requiredToken: undefined,
        allowNoAuth: false,
        isProd: true,
      });
      expect(result).toBe('hmac');
    });

    it('acepta HMAC válido con prefijo sha256=', () => {
      const result = verifyWebhookAuth({
        rawBody: RAW_BODY,
        token: undefined,
        hmacHeader: makeSig(SECRET, RAW_BODY, 'sha256='),
        hmacSecret: SECRET,
        requiredToken: undefined,
        allowNoAuth: false,
        isProd: true,
      });
      expect(result).toBe('hmac');
    });

    it('rechaza HMAC firmado con secret distinto', () => {
      expect(() =>
        verifyWebhookAuth({
          rawBody: RAW_BODY,
          token: undefined,
          hmacHeader: makeSig('secret-distinto', RAW_BODY),
          hmacSecret: SECRET,
          requiredToken: undefined,
          allowNoAuth: false,
          isProd: true,
        }),
      ).toThrow(ForbiddenException);
    });

    it('rechaza HMAC sobre body distinto', () => {
      const otherBody = Buffer.from('{"event":"tampered"}', 'utf-8');
      expect(() =>
        verifyWebhookAuth({
          rawBody: RAW_BODY,
          token: undefined,
          hmacHeader: makeSig(SECRET, otherBody),
          hmacSecret: SECRET,
          requiredToken: undefined,
          allowNoAuth: false,
          isProd: true,
        }),
      ).toThrow(ForbiddenException);
    });

    it('rechaza cuando HMAC secret está seteado pero falta el header', () => {
      expect(() =>
        verifyWebhookAuth({
          rawBody: RAW_BODY,
          token: undefined,
          hmacHeader: undefined,
          hmacSecret: SECRET,
          requiredToken: undefined,
          allowNoAuth: false,
          isProd: true,
        }),
      ).toThrow(/firma HMAC ausente/);
    });

    it('rechaza cuando el raw body no está disponible', () => {
      expect(() =>
        verifyWebhookAuth({
          rawBody: undefined,
          token: undefined,
          hmacHeader: makeSig(SECRET, RAW_BODY),
          hmacSecret: SECRET,
          requiredToken: undefined,
          allowNoAuth: false,
          isProd: true,
        }),
      ).toThrow(/raw body/);
    });

    it('con HMAC secret seteado, IGNORA token (evita downgrade attack)', () => {
      // Atacante manda token correcto pero SIN HMAC. Debe rechazar.
      expect(() =>
        verifyWebhookAuth({
          rawBody: RAW_BODY,
          token: TOKEN,
          hmacHeader: undefined,
          hmacSecret: SECRET,
          requiredToken: TOKEN,
          allowNoAuth: false,
          isProd: true,
        }),
      ).toThrow(/firma HMAC ausente/);
    });
  });

  describe('mecanismo 2: shared token', () => {
    it('acepta token correcto', () => {
      const result = verifyWebhookAuth({
        rawBody: RAW_BODY,
        token: TOKEN,
        hmacHeader: undefined,
        hmacSecret: undefined,
        requiredToken: TOKEN,
        allowNoAuth: false,
        isProd: true,
      });
      expect(result).toBe('token');
    });

    it('rechaza token incorrecto', () => {
      expect(() =>
        verifyWebhookAuth({
          rawBody: RAW_BODY,
          token: 'wrong',
          hmacHeader: undefined,
          hmacSecret: undefined,
          requiredToken: TOKEN,
          allowNoAuth: false,
          isProd: true,
        }),
      ).toThrow(/token de webhook inválido/);
    });

    it('rechaza cuando token requerido está seteado y no llega header', () => {
      expect(() =>
        verifyWebhookAuth({
          rawBody: RAW_BODY,
          token: undefined,
          hmacHeader: undefined,
          hmacSecret: undefined,
          requiredToken: TOKEN,
          allowNoAuth: false,
          isProd: true,
        }),
      ).toThrow(/token de webhook inválido/);
    });
  });

  describe('mecanismo 3: skip explícito', () => {
    it('acepta sin auth cuando ALLOW=true y NO es prod', () => {
      const result = verifyWebhookAuth({
        rawBody: RAW_BODY,
        token: undefined,
        hmacHeader: undefined,
        hmacSecret: undefined,
        requiredToken: undefined,
        allowNoAuth: true,
        isProd: false,
      });
      expect(result).toBe('skip-explicit');
    });

    it('IGNORA ALLOW=true en producción — fail-closed', () => {
      expect(() =>
        verifyWebhookAuth({
          rawBody: RAW_BODY,
          token: undefined,
          hmacHeader: undefined,
          hmacSecret: undefined,
          requiredToken: undefined,
          allowNoAuth: true,
          isProd: true,
        }),
      ).toThrow(/obligatorios en producción/);
    });
  });

  describe('fail-closed default', () => {
    it('rechaza en prod sin ningún mecanismo configurado', () => {
      expect(() =>
        verifyWebhookAuth({
          rawBody: RAW_BODY,
          token: undefined,
          hmacHeader: undefined,
          hmacSecret: undefined,
          requiredToken: undefined,
          allowNoAuth: false,
          isProd: true,
        }),
      ).toThrow(/obligatorios en producción/);
    });

    it('rechaza en dev sin auth y sin opt-in explícito', () => {
      expect(() =>
        verifyWebhookAuth({
          rawBody: RAW_BODY,
          token: undefined,
          hmacHeader: undefined,
          hmacSecret: undefined,
          requiredToken: undefined,
          allowNoAuth: false,
          isProd: false,
        }),
      ).toThrow(/setear WEBHOOK_HMAC_SECRET/);
    });

    it('rechaza staging (isProd=false) con ALLOW=false — cierra gap del review', () => {
      // Regression test del gap Medio #2 — staging con NODE_ENV=staging sin
      // opt-in explícito. Antes hacía fail-open silente. Ahora rechaza.
      expect(() =>
        verifyWebhookAuth({
          rawBody: RAW_BODY,
          token: undefined,
          hmacHeader: undefined,
          hmacSecret: undefined,
          requiredToken: undefined,
          allowNoAuth: false,
          isProd: false,
        }),
      ).toThrow(ForbiddenException);
    });
  });
});
