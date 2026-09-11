import { LlmRouterService } from '../common/llm/llm-router.service';
import { Intent, IntentService } from './intent.service';

describe('IntentService', () => {
  let svc: IntentService;
  let llm: { complete: jest.Mock };

  beforeEach(() => {
    llm = { complete: jest.fn() };
    svc = new IntentService(llm as unknown as LlmRouterService);
  });

  it('happy path: "agendar" → Intent.AGENDAR', async () => {
    llm.complete.mockResolvedValueOnce('agendar');
    await expect(svc.detect('quiero un turno')).resolves.toBe(Intent.AGENDAR);
    expect(llm.complete).toHaveBeenCalledTimes(1);
    const args = llm.complete.mock.calls[0][0];
    expect(args.maxTokens).toBe(5);
    expect(args.user).toBe('quiero un turno');
  });

  it('case-insensitive con whitespace: "AGENDAR\\n" → Intent.AGENDAR', async () => {
    llm.complete.mockResolvedValueOnce('AGENDAR\n');
    await expect(svc.detect('X')).resolves.toBe(Intent.AGENDAR);
  });

  it('respuesta con match por includes: "quiero pedir turno agendar hoy" → Intent.AGENDAR', async () => {
    llm.complete.mockResolvedValueOnce('quiero pedir turno agendar hoy');
    await expect(svc.detect('X')).resolves.toBe(Intent.AGENDAR);
  });

  it('respuesta sin match: "xyz" → Intent.OTRO', async () => {
    llm.complete.mockResolvedValueOnce('xyz');
    await expect(svc.detect('X')).resolves.toBe(Intent.OTRO);
  });

  it('LLM tira excepción → Intent.OTRO (no propaga)', async () => {
    llm.complete.mockRejectedValueOnce(new Error('todos los LLM fallaron: ...'));
    await expect(svc.detect('X')).resolves.toBe(Intent.OTRO);
  });

  // ── B2: "sí/ok/dale" solo confirman en mensajes cortos ──
  describe('detectDeterministic: confirmación (B2)', () => {
    it.each(['sí', 'si', 'ok', 'Dale', 'sí gracias'])(
      '"%s" (≤ 2 palabras) → CONFIRMAR sin llamar al LLM',
      async (text) => {
        await expect(svc.detect(text)).resolves.toBe(Intent.CONFIRMAR);
        expect(llm.complete).not.toHaveBeenCalled();
      },
    );

    it.each(['ok gracias', 'muchas gracias', 'listo gracias'])(
      '"%s" es un cierre de cortesía, no CONFIRMAR',
      async (text) => {
        await expect(svc.detect(text)).resolves.toBe(Intent.OTRO);
        expect(llm.complete).not.toHaveBeenCalled();
      },
    );

    it('"sí, quiero agendar una cita" NO es confirmación: va al LLM', async () => {
      llm.complete.mockResolvedValueOnce('agendar');

      await expect(svc.detect('sí, quiero agendar una cita')).resolves.toBe(
        Intent.AGENDAR,
      );
      expect(llm.complete).toHaveBeenCalledTimes(1);
    });

    it.each(['confirmo', 'confirmo que voy a ir mañana'])(
      '"%s" es un verbo explícito → CONFIRMAR aunque sea largo',
      async (text) => {
        await expect(svc.detect(text)).resolves.toBe(Intent.CONFIRMAR);
        expect(llm.complete).not.toHaveBeenCalled();
      },
    );
  });

  // ── B3: "persona" suelta no es un pedido de humano ──
  describe('detectDeterministic: escape a humano (B3)', () => {
    it('"es para otra persona" NO es hablar_humano: va al LLM', async () => {
      llm.complete.mockResolvedValueOnce('agendar');

      await expect(svc.detect('es para otra persona')).resolves.toBe(
        Intent.AGENDAR,
      );
      expect(llm.complete).toHaveBeenCalledTimes(1);
    });

    it.each([
      'quiero hablar con una persona',
      'humano',
      'necesito que me atienda una persona',
      'quiero una persona real',
    ])('"%s" → HABLAR_HUMANO sin LLM', async (text) => {
      await expect(svc.detect(text)).resolves.toBe(Intent.HABLAR_HUMANO);
      expect(llm.complete).not.toHaveBeenCalled();
    });
  });
});
