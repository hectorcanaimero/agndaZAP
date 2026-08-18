import { NotFoundException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import type { AuthUser } from '../auth/tenant-context.util';
import { PrismaService } from '../prisma/prisma.service';
import { ClinicsController } from './clinics.controller';
import {
  ALLOWED_CURRENCIES,
  UpdateClinicDto,
} from './dto/update-clinic.dto';

/**
 * Tests del ClinicsController — foco en:
 * - `GET /me` incluye `currency` en el select y en la respuesta.
 * - `PATCH /me` persiste `currency` cuando llega en el body.
 * - Validación del DTO: whitelist ISO 4217 rechaza códigos random.
 * - Multi-tenant: el helper `tenantWhere(user)` es el único punto donde se
 *   deriva el clinicId — verificamos vía el `where` del prisma call.
 */

type Deep<T> = { [K in keyof T]?: any } & Record<string, any>;

describe('ClinicsController', () => {
  let prisma: Deep<PrismaService>;
  let controller: ClinicsController;

  const adminA: AuthUser = {
    userId: 'user-A',
    clinicId: 'clinic-A',
    role: 'CLINIC_ADMIN',
  };

  beforeEach(() => {
    prisma = {
      clinic: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    controller = new ClinicsController(
      prisma as unknown as PrismaService,
    );
  });

  describe('GET /clinics/me', () => {
    it('devuelve la clínica del user con currency', async () => {
      const clinicRow = {
        id: 'clinic-A',
        name: 'Clínica A',
        slug: 'clinica-a',
        timezone: 'America/Caracas',
        locale: 'es',
        currency: 'VES',
        address: null,
        autoConfirm: false,
        reminderOffsetsH: [24, 3],
        confirmThresholdH: 6,
        botGreeting: null,
        botFallback: null,
        botHandoffMsg: null,
        botTone: null,
      };
      prisma.clinic.findUnique.mockResolvedValue(clinicRow);

      const result = await controller.me(adminA);
      expect(result).toMatchObject({ id: 'clinic-A', currency: 'VES' });

      // Multi-tenant: el where DEBE traer el clinicId del user.
      const call = prisma.clinic.findUnique.mock.calls[0][0];
      expect(call.where).toEqual({ id: 'clinic-A' });
      // El select expone `currency` — regresión guard.
      expect(call.select.currency).toBe(true);
    });

    it('tira 404 si la clínica no existe', async () => {
      prisma.clinic.findUnique.mockResolvedValue(null);
      await expect(controller.me(adminA)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('PATCH /clinics/me', () => {
    it('persiste `currency` cuando llega en el DTO', async () => {
      const dto = plainToInstance(UpdateClinicDto, { currency: 'VES' });
      prisma.clinic.findUnique.mockResolvedValue({ timezone: 'America/Caracas' });
      prisma.clinic.update.mockResolvedValue({
        id: 'clinic-A',
        currency: 'VES',
      });

      await controller.update(adminA, dto);

      const call = prisma.clinic.update.mock.calls[0][0];
      // Multi-tenant: sigue apuntando al clinicId del user.
      expect(call.where).toEqual({ id: 'clinic-A' });
      // Persistencia real.
      expect(call.data.currency).toBe('VES');
      // El select del response también trae currency (para que el frontend
      // pueda refrescar la UI sin re-fetch).
      expect(call.select.currency).toBe(true);
    });

    it('NO manda `currency` a Prisma cuando el DTO no lo incluye', async () => {
      const dto = plainToInstance(UpdateClinicDto, { name: 'Nuevo Nombre' });
      prisma.clinic.findUnique.mockResolvedValue({ timezone: 'America/Caracas' });
      prisma.clinic.update.mockResolvedValue({ id: 'clinic-A' });

      await controller.update(adminA, dto);

      const call = prisma.clinic.update.mock.calls[0][0];
      // Importante: `currency` NO debe aparecer en data si el DTO no lo trae
      // (patch parcial — no queremos overridear el valor existente con undefined).
      expect(call.data).not.toHaveProperty('currency');
      expect(call.data.name).toBe('Nuevo Nombre');
    });
  });

  describe('UpdateClinicDto — validación de currency (whitelist ISO 4217)', () => {
    async function validateCurrency(value: unknown) {
      const dto = plainToInstance(UpdateClinicDto, { currency: value });
      return validate(dto);
    }

    it('acepta USD (default de LATAM)', async () => {
      const errors = await validateCurrency('USD');
      expect(errors).toHaveLength(0);
    });

    it('acepta VES (Venezuela) — whitelist LATAM', async () => {
      const errors = await validateCurrency('VES');
      expect(errors).toHaveLength(0);
    });

    it('rechaza "XYZ" — 3 letras válidas pero fuera de la whitelist', async () => {
      const errors = await validateCurrency('XYZ');
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0].constraints).toBeDefined();
      // El error viene de @IsIn, no del regex (XYZ pasa el regex).
      expect(errors[0].constraints?.isIn).toBeDefined();
    });

    it('rechaza "usd" — minúsculas violan el regex antes del whitelist', async () => {
      const errors = await validateCurrency('usd');
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0].constraints?.matches).toBeDefined();
    });

    it('rechaza "US" — menos de 3 chars', async () => {
      const errors = await validateCurrency('US');
      expect(errors.length).toBeGreaterThan(0);
    });

    it('rechaza número — no es string', async () => {
      const errors = await validateCurrency(123);
      expect(errors.length).toBeGreaterThan(0);
    });

    it('permite ausencia del campo (patch parcial)', async () => {
      // Patch parcial válido: sólo autoConfirm, sin currency.
      const dto = plainToInstance(UpdateClinicDto, { autoConfirm: true });
      const errors = await validate(dto);
      expect(errors).toHaveLength(0);
    });

    it('la whitelist expone las 18 monedas LATAM + majors', () => {
      // Guard rail: si alguien agrega/quita una moneda, el frontend team
      // necesita saberlo (contrato compartido implícito).
      expect(ALLOWED_CURRENCIES).toHaveLength(18);
      expect(ALLOWED_CURRENCIES).toContain('USD');
      expect(ALLOWED_CURRENCIES).toContain('VES');
      expect(ALLOWED_CURRENCIES).toContain('BRL');
      expect(ALLOWED_CURRENCIES).toContain('ARS');
    });
  });
});
