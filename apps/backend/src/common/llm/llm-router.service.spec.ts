import { LlmRouterService } from './llm-router.service';

/** Fabricante de respuestas fetch OK con shape OpenAI-compat. */
function okOpenAI(content: string) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content } }] }),
  };
}

/** Fabricante de respuestas fetch OK con shape Gemini. */
function okGemini(text: string) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      candidates: [{ content: { parts: [{ text }] } }],
    }),
  };
}

function httpErr(status: number) {
  return { ok: false, status, json: async () => ({}) };
}

describe('LlmRouterService', () => {
  let svc: LlmRouterService;

  const originalDeepSeek = process.env.DEEPSEEK_API_KEY;
  const originalGemini = process.env.GEMINI_API_KEY;
  const originalOpenCodeKey = process.env.OPENCODE_API_KEY;
  const originalOpenCodeUrl = process.env.OPENCODE_BASE_URL;
  const originalOpenCodePlan = process.env.OPENCODE_PLAN;
  const originalOrder = process.env.LLM_PROVIDER_ORDER;

  beforeEach(() => {
    svc = new LlmRouterService();
    process.env.DEEPSEEK_API_KEY = 'ds-test';
    process.env.GEMINI_API_KEY = 'gm-test';
    process.env.OPENCODE_API_KEY = 'oc-test';
    process.env.OPENCODE_BASE_URL = 'https://api.opencode.test/v1';
    process.env.OPENCODE_PLAN = 'gpt-4o-mini';
    delete process.env.LLM_PROVIDER_ORDER;
  });

  afterEach(() => {
    const restore = (name: string, value: string | undefined) => {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    };
    restore('DEEPSEEK_API_KEY', originalDeepSeek);
    restore('GEMINI_API_KEY', originalGemini);
    restore('OPENCODE_API_KEY', originalOpenCodeKey);
    restore('OPENCODE_BASE_URL', originalOpenCodeUrl);
    restore('OPENCODE_PLAN', originalOpenCodePlan);
    restore('LLM_PROVIDER_ORDER', originalOrder);
    jest.restoreAllMocks();
  });

  it('happy path: deepseek responde y no toca los demás providers', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(okOpenAI('hola desde deepseek'));
    global.fetch = fetchMock as unknown as typeof fetch;

    const out = await svc.complete({ system: 's', user: 'u' });
    expect(out).toBe('hola desde deepseek');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.deepseek.com/chat/completions');
  });

  it('fallback: deepseek 500 → opencode responde', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(httpErr(500))
      .mockResolvedValueOnce(okOpenAI('desde opencode'));
    global.fetch = fetchMock as unknown as typeof fetch;

    const out = await svc.complete({ system: 's', user: 'u' });
    expect(out).toBe('desde opencode');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][0]).toBe(
      'https://api.opencode.test/v1/chat/completions',
    );
  });

  it('cadena completa falla → throws con detalle de errores', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(httpErr(500))
      .mockResolvedValueOnce(httpErr(500))
      .mockResolvedValueOnce(httpErr(500));
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(svc.complete({ system: 's', user: 'u' })).rejects.toThrow(
      /todos los LLM fallaron/,
    );
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('provider sin API key se saltea silenciosamente (no cuenta como fallo del http)', async () => {
    delete process.env.OPENCODE_API_KEY;
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(httpErr(500))
      .mockResolvedValueOnce(okGemini('desde gemini'));
    global.fetch = fetchMock as unknown as typeof fetch;

    const out = await svc.complete({ system: 's', user: 'u' });
    expect(out).toBe('desde gemini');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][0]).toMatch(/generativelanguage/);
  });

  it('LLM_PROVIDER_ORDER respeta la config y saltea providers no listados', async () => {
    process.env.LLM_PROVIDER_ORDER = 'opencode,gemini';
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(okOpenAI('desde opencode first'));
    global.fetch = fetchMock as unknown as typeof fetch;

    const out = await svc.complete({ system: 's', user: 'u' });
    expect(out).toBe('desde opencode first');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toContain('opencode.test');
  });

  it('LLM_PROVIDER_ORDER vacío/inválido cae al default order', async () => {
    process.env.LLM_PROVIDER_ORDER = ' , foo , bar ';
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(okOpenAI('deepseek default'));
    global.fetch = fetchMock as unknown as typeof fetch;

    const out = await svc.complete({ system: 's', user: 'u' });
    expect(out).toBe('deepseek default');
    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://api.deepseek.com/chat/completions',
    );
  });

  it('timeout: aborta si el fetch no resuelve dentro de timeoutMs', async () => {
    // fetch respeta AbortSignal — simulamos rechazo por abort cuando signal se dispara.
    const fetchMock = jest.fn().mockImplementation((_url, init) => {
      return new Promise((_resolve, reject) => {
        const signal: AbortSignal = init.signal;
        signal.addEventListener('abort', () => {
          reject(new Error('The operation was aborted'));
        });
      });
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    // Timeout 50ms → deepseek aborta, opencode aborta, gemini aborta → throws.
    await expect(
      svc.complete({ system: 's', user: 'u', timeoutMs: 50 }),
    ).rejects.toThrow(/todos los LLM fallaron/);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('OpenCode URL con trailing slash se normaliza a /chat/completions', async () => {
    process.env.OPENCODE_BASE_URL = 'https://api.opencode.test/v1/';
    process.env.LLM_PROVIDER_ORDER = 'opencode';
    const fetchMock = jest.fn().mockResolvedValueOnce(okOpenAI('x'));
    global.fetch = fetchMock as unknown as typeof fetch;

    await svc.complete({ system: 's', user: 'u' });
    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://api.opencode.test/v1/chat/completions',
    );
  });

  it('OpenCode URL con /chat/completions ya incluido no se duplica', async () => {
    process.env.OPENCODE_BASE_URL =
      'https://api.opencode.test/v1/chat/completions';
    process.env.LLM_PROVIDER_ORDER = 'opencode';
    const fetchMock = jest.fn().mockResolvedValueOnce(okOpenAI('x'));
    global.fetch = fetchMock as unknown as typeof fetch;

    await svc.complete({ system: 's', user: 'u' });
    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://api.opencode.test/v1/chat/completions',
    );
  });

  it('OpenCode envía OPENCODE_PLAN como body.model', async () => {
    process.env.OPENCODE_PLAN = 'claude-3-5-sonnet';
    process.env.LLM_PROVIDER_ORDER = 'opencode';
    const fetchMock = jest.fn().mockResolvedValueOnce(okOpenAI('x'));
    global.fetch = fetchMock as unknown as typeof fetch;

    await svc.complete({ system: 's', user: 'u' });
    const body = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body);
    expect(body.model).toBe('claude-3-5-sonnet');
    expect(body.messages).toEqual([
      { role: 'system', content: 's' },
      { role: 'user', content: 'u' },
    ]);
  });
});
