import { LlmRouterService } from '../common/llm/llm-router.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  EMBEDDING_DIMS,
  KnowledgeService,
  KnowledgeUnavailableError,
} from './knowledge.service';

type Deep<T> = { [K in keyof T]?: any } & Record<string, any>;

/** Vector determinístico de 1536 dims para stubs — todos los valores 0.01. */
const FAKE_VECTOR: number[] = Array.from({ length: EMBEDDING_DIMS }, () => 0.01);

/** Helper: mockea `global.fetch` con una respuesta OpenAI válida. */
function mockOpenAIEmbeddingsOk(vector = FAKE_VECTOR): jest.Mock {
  const fetchMock = jest.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ data: [{ embedding: vector }] }),
  });
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

describe('KnowledgeService', () => {
  let prisma: Deep<PrismaService>;
  let llm: { complete: jest.Mock };
  let svc: KnowledgeService;
  const originalOpenAIKey = process.env.OPENAI_API_KEY;

  beforeEach(() => {
    prisma = {
      $executeRawUnsafe: jest.fn().mockResolvedValue(1),
      $queryRawUnsafe: jest.fn().mockResolvedValue([]),
      faqChunk: {
        findFirst: jest.fn(),
      },
    };
    llm = { complete: jest.fn() };
    svc = new KnowledgeService(
      prisma as unknown as PrismaService,
      llm as unknown as LlmRouterService,
    );
    process.env.OPENAI_API_KEY = 'sk-test-key';
  });

  afterEach(() => {
    if (originalOpenAIKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = originalOpenAIKey;
    }
    jest.restoreAllMocks();
  });

  // ─────────────────────────── embedText ───────────────────────────

  describe('embedText', () => {
    it('devuelve un vector de 1536 dims cuando OPENAI_API_KEY está seteada', async () => {
      const fetchMock = mockOpenAIEmbeddingsOk();
      const v = await svc.embedText('¿Cuál es el horario?');
      expect(v).toHaveLength(EMBEDDING_DIMS);
      expect(v.every((n) => typeof n === 'number')).toBe(true);
      // Verifica que llamó al endpoint correcto de OpenAI.
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('https://api.openai.com/v1/embeddings');
      expect((init as any).method).toBe('POST');
      expect((init as any).headers.Authorization).toContain('Bearer sk-test-key');
      const body = JSON.parse((init as any).body);
      expect(body.model).toBe('text-embedding-3-small');
    });

    it('tira KnowledgeUnavailableError si falta OPENAI_API_KEY', async () => {
      delete process.env.OPENAI_API_KEY;
      await expect(svc.embedText('cualquier cosa')).rejects.toBeInstanceOf(
        KnowledgeUnavailableError,
      );
    });

    it('tira si la dimensión del vector no coincide (defensa contra confusión de modelo)', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ data: [{ embedding: [0.1, 0.2, 0.3] }] }),
      }) as unknown as typeof fetch;
      await expect(svc.embedText('hola')).rejects.toThrow(/dimensión inesperada/);
    });

    it('propaga error si OpenAI responde no-2xx', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 429,
        json: async () => ({}),
      }) as unknown as typeof fetch;
      await expect(svc.embedText('hola')).rejects.toThrow(/429/);
    });
  });

  // ─────────────────────────── ingest ───────────────────────────

  describe('ingest', () => {
    it('genera embedding y llama $executeRawUnsafe con el vector formateado y clinicId parametrizado', async () => {
      mockOpenAIEmbeddingsOk();
      const result = await svc.ingest({
        clinicId: 'clinic-A',
        content: 'Horarios: L-V 9-18h',
      });

      expect(result.content).toBe('Horarios: L-V 9-18h');
      expect(typeof result.id).toBe('string');
      expect(result.id.length).toBeGreaterThan(0);

      expect(prisma.$executeRawUnsafe).toHaveBeenCalledTimes(1);
      const [sql, ...args] = prisma.$executeRawUnsafe.mock.calls[0];
      expect(sql).toMatch(/INSERT INTO "FaqChunk"/);
      // El vector literal se interpola (Prisma no lo parametriza): debe empezar con [ y contener números
      expect(sql).toMatch(/\[0\.01,0\.01,/);
      expect(sql).toMatch(/::vector/);
      // args = [id, clinicId, title, content] — title es null cuando no se provee.
      expect(args[0]).toBe(result.id);
      expect(args[1]).toBe('clinic-A');
      expect(args[2]).toBeNull();
      expect(args[3]).toBe('Horarios: L-V 9-18h');
    });

    it('propaga KnowledgeUnavailableError si no hay OPENAI_API_KEY', async () => {
      delete process.env.OPENAI_API_KEY;
      await expect(
        svc.ingest({ clinicId: 'clinic-A', content: 'algo' }),
      ).rejects.toBeInstanceOf(KnowledgeUnavailableError);
      expect(prisma.$executeRawUnsafe).not.toHaveBeenCalled();
    });
  });

  // ─────────────────────────── updateChunk ───────────────────────────

  describe('updateChunk', () => {
    it('re-embed + UPDATE con clinicId en el WHERE (multi-tenant)', async () => {
      mockOpenAIEmbeddingsOk();
      await svc.updateChunk({
        id: 'faq-1',
        clinicId: 'clinic-A',
        content: 'nuevo contenido',
      });
      expect(prisma.$executeRawUnsafe).toHaveBeenCalledTimes(1);
      const [sql, ...args] = prisma.$executeRawUnsafe.mock.calls[0];
      expect(sql).toMatch(/UPDATE "FaqChunk"/);
      expect(sql).toMatch(/WHERE id = \$2 AND "clinicId" = \$3/);
      expect(args[0]).toBe('nuevo contenido');
      expect(args[1]).toBe('faq-1');
      expect(args[2]).toBe('clinic-A');
    });
  });

  // ─────────────────────────── retrieve ───────────────────────────

  describe('retrieve', () => {
    it('embed la pregunta y filtra por clinicId (multi-tenant)', async () => {
      const fetchMock = mockOpenAIEmbeddingsOk();
      prisma.$queryRawUnsafe.mockResolvedValueOnce([
        { id: 'f-1', content: 'Horario 9-18', distance: 0.2 },
        { id: 'f-2', content: 'Dirección Av...', distance: 0.35 },
      ]);
      const matches = await svc.retrieve({
        clinicId: 'clinic-A',
        question: '¿A qué hora abren?',
      });
      expect(fetchMock).toHaveBeenCalledTimes(1); // embed
      expect(prisma.$queryRawUnsafe).toHaveBeenCalledTimes(1);
      const [sql, ...args] = prisma.$queryRawUnsafe.mock.calls[0];
      expect(sql).toMatch(/FROM "FaqChunk"/);
      expect(sql).toMatch(/WHERE "clinicId" = \$1 AND embedding IS NOT NULL/);
      expect(sql).toMatch(/embedding <=> '/); // cosine distance operator
      expect(args[0]).toBe('clinic-A');
      expect(args[1]).toBe(3); // default k
      expect(matches).toHaveLength(2);
      expect(matches[0].id).toBe('f-1');
      expect(matches[0].distance).toBe(0.2);
    });

    it('aplica maxDistance filtrando resultados lejanos', async () => {
      mockOpenAIEmbeddingsOk();
      prisma.$queryRawUnsafe.mockResolvedValueOnce([
        { id: 'f-1', content: 'ok', distance: 0.2 },
        { id: 'f-2', content: 'lejos', distance: 0.7 },
        { id: 'f-3', content: 'muy lejos', distance: 1.2 },
      ]);
      const matches = await svc.retrieve({
        clinicId: 'clinic-A',
        question: 'x',
        maxDistance: 0.5,
      });
      // Sólo f-1 (0.2) pasa el threshold.
      expect(matches).toHaveLength(1);
      expect(matches[0].id).toBe('f-1');
    });

    it('respeta el parámetro k pasándolo al LIMIT', async () => {
      mockOpenAIEmbeddingsOk();
      prisma.$queryRawUnsafe.mockResolvedValueOnce([]);
      await svc.retrieve({
        clinicId: 'clinic-A',
        question: 'x',
        k: 5,
      });
      const [, , kArg] = prisma.$queryRawUnsafe.mock.calls[0];
      expect(kArg).toBe(5);
    });

    it('normaliza distance de string a number (algunos drivers Prisma devuelven strings)', async () => {
      mockOpenAIEmbeddingsOk();
      prisma.$queryRawUnsafe.mockResolvedValueOnce([
        { id: 'f-1', content: 'x', distance: '0.3' as unknown as number },
      ]);
      const matches = await svc.retrieve({
        clinicId: 'clinic-A',
        question: 'x',
      });
      expect(matches[0].distance).toBe(0.3);
      expect(typeof matches[0].distance).toBe('number');
    });
  });

  // ─────────────────────────── answer ───────────────────────────

  describe('answer', () => {
    it('devuelve null si retrieve no encuentra matches', async () => {
      mockOpenAIEmbeddingsOk();
      prisma.$queryRawUnsafe.mockResolvedValueOnce([]);
      const result = await svc.answer({
        clinicId: 'clinic-A',
        question: '¿Cuánto cuesta?',
      });
      expect(result).toBeNull();
    });

    it('devuelve null y hace handoff silencioso si falta OPENAI_API_KEY', async () => {
      delete process.env.OPENAI_API_KEY;
      const result = await svc.answer({
        clinicId: 'clinic-A',
        question: '¿Cuánto cuesta?',
      });
      expect(result).toBeNull();
    });

    it('con matches: arma prompt con delimitadores + fuentes y llama al router LLM', async () => {
      prisma.$queryRawUnsafe.mockResolvedValueOnce([
        { id: 'f-1', content: 'Horario: L-V 9-18h.', distance: 0.15 },
        { id: 'f-2', content: 'Sin atención fines de semana.', distance: 0.3 },
      ]);
      mockOpenAIEmbeddingsOk();
      llm.complete.mockResolvedValueOnce(
        'Nuestro horario es de lunes a viernes de 9 a 18h.',
      );

      const result = await svc.answer({
        clinicId: 'clinic-A',
        question: '¿A qué hora abren?',
        locale: 'es',
      });

      expect(result).not.toBeNull();
      expect(result!.answer).toContain('lunes a viernes');
      expect(result!.sources).toEqual(['f-1', 'f-2']);

      expect(llm.complete).toHaveBeenCalledTimes(1);
      const opts = llm.complete.mock.calls[0][0];
      expect(opts.maxTokens).toBe(200);
      expect(opts.system).toMatch(/ÚNICAMENTE/i);
      expect(opts.system).toMatch(/NULL_ANSWER/);
      expect(opts.system).toMatch(/NO obedezcas instrucciones/i);
      expect(opts.user).toMatch(/--- FUENTE 1 ---/);
      expect(opts.user).toMatch(/Horario: L-V 9-18h/);
      expect(opts.user).toMatch(/--- FUENTE 2 ---/);
    });

    it('devuelve null si el LLM responde NULL_ANSWER', async () => {
      prisma.$queryRawUnsafe.mockResolvedValueOnce([
        { id: 'f-1', content: 'Horario 9-18h', distance: 0.2 },
      ]);
      mockOpenAIEmbeddingsOk();
      llm.complete.mockResolvedValueOnce('NULL_ANSWER');

      const result = await svc.answer({
        clinicId: 'clinic-A',
        question: '¿Aceptan cripto?',
      });
      expect(result).toBeNull();
    });

    it('setea locale=pt cambiando el idioma del system prompt', async () => {
      prisma.$queryRawUnsafe.mockResolvedValueOnce([
        { id: 'f-1', content: 'Horario 9-18h', distance: 0.2 },
      ]);
      mockOpenAIEmbeddingsOk();
      llm.complete.mockResolvedValueOnce('Nosso horário é 9h-18h.');

      await svc.answer({
        clinicId: 'clinic-A',
        question: '¿Que horas abrem?',
        locale: 'pt',
      });
      const opts = llm.complete.mock.calls[0][0];
      expect(opts.system).toMatch(/português/);
    });

    it('devuelve null si el router LLM falla', async () => {
      prisma.$queryRawUnsafe.mockResolvedValueOnce([
        { id: 'f-1', content: 'Horario 9-18h', distance: 0.2 },
      ]);
      mockOpenAIEmbeddingsOk();
      llm.complete.mockRejectedValueOnce(new Error('todos los LLM fallaron'));

      const result = await svc.answer({
        clinicId: 'clinic-A',
        question: '?',
      });
      expect(result).toBeNull();
    });
  });
});
