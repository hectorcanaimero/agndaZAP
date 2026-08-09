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
});
