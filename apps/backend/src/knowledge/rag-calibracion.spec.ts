import {
  DEFAULT_MAX_DISTANCE,
  DEFAULT_MIN_LEXICAL_SIMILARITY,
  LEXICAL_FALLBACK_MAX_WORDS,
} from './knowledge.service';

/**
 * Calibración del RAG con mediciones REALES, sin llamar a OpenAI.
 *
 * Qué prueba y qué no: **no** re-embebe nada ni valida el modelo. Lo que fija
 * es la **frontera de decisión** — dado lo que `text-embedding-3-small` produjo
 * de verdad contra las FAQ de la demo, qué preguntas pasan el umbral y cuáles
 * no. Si alguien mueve `DEFAULT_MAX_DISTANCE`, este spec le dice exactamente
 * qué preguntas reales empieza a romper, en vez de dejarlo descubrirlo en
 * producción con un paciente delante.
 *
 * Las distancias salen de la medición documentada en
 * `docs/notas/2026-09-10-rag-umbral-distancia.md` (embed de las preguntas +
 * `<=>` contra los chunks de la demo en prod). Las similitudes léxicas se
 * midieron con `word_similarity` contra las FAQ de la base de desarrollo.
 *
 * Si se re-mide con datos nuevos, se actualiza esta tabla y el spec dirá si la
 * decisión sigue en pie.
 */

interface CasoMedido {
  pregunta: string;
  /** Distancia coseno al mejor chunk. */
  distancia: number;
  /** Si el mejor chunk era el correcto para la pregunta. */
  chunkCorrecto: boolean;
  /** Qué esperamos: que el RAG conteste o que derive. */
  deberiaResponder: boolean;
}

/** Medición 2026-09-10, prod, chunks de la demo dental. */
const MEDICIONES: CasoMedido[] = [
  { pregunta: 'atienden niños', distancia: 0.454, chunkCorrecto: true, deberiaResponder: true },
  { pregunta: 'me duele una muela', distancia: 0.467, chunkCorrecto: true, deberiaResponder: true },
  { pregunta: 'cuánto cuesta una limpieza', distancia: 0.488, chunkCorrecto: true, deberiaResponder: true },
  { pregunta: 'qué horario tienen', distancia: 0.515, chunkCorrecto: true, deberiaResponder: true },
  { pregunta: 'tienen estacionamiento', distancia: 0.608, chunkCorrecto: true, deberiaResponder: true },
  { pregunta: 'Donde están ubicados', distancia: 0.619, chunkCorrecto: true, deberiaResponder: true },
  // Ajenas: tienen que quedar fuera. Son las que impiden subir el umbral.
  { pregunta: 'quiero comprar un carro', distancia: 0.723, chunkCorrecto: false, deberiaResponder: false },
  { pregunta: 'hola que tal', distancia: 0.730, chunkCorrecto: false, deberiaResponder: false },
  // El caso que la nota dejó anotado como pendiente: pasa el umbral pero
  // contra el chunk equivocado. El segundo filtro es el LLM (NULL_ANSWER).
  { pregunta: 'dónde queda la clínica', distancia: 0.583, chunkCorrecto: false, deberiaResponder: true },
];

const pasaUmbral = (d: number) => d <= DEFAULT_MAX_DISTANCE;

describe('calibración del RAG — umbral de distancia', () => {
  it.each(MEDICIONES)(
    '"$pregunta" (dist $distancia) → responder=$deberiaResponder',
    ({ distancia, deberiaResponder }) => {
      expect(pasaUmbral(distancia)).toBe(deberiaResponder);
    },
  );

  it('el umbral separa TODAS las preguntas de clínica de TODAS las ajenas', () => {
    // La propiedad que de verdad importa, más allá de caso a caso: existe un
    // corte limpio. Si un cambio de modelo o de FAQ la rompe, hay que
    // recalibrar, no mover el número hasta que pasen los tests.
    const propias = MEDICIONES.filter((m) => m.deberiaResponder);
    const ajenas = MEDICIONES.filter((m) => !m.deberiaResponder);

    const peorPropia = Math.max(...propias.map((m) => m.distancia));
    const mejorAjena = Math.min(...ajenas.map((m) => m.distancia));

    expect(peorPropia).toBeLessThan(mejorAjena);
    expect(DEFAULT_MAX_DISTANCE).toBeGreaterThanOrEqual(peorPropia);
    expect(DEFAULT_MAX_DISTANCE).toBeLessThan(mejorAjena);
  });

  it('bajar el umbral a 0.5 rompería 4 preguntas reales de pacientes', () => {
    // Documenta por qué NO se vuelve al valor original: no es una preferencia,
    // son preguntas concretas que dejarían de funcionar.
    const rotas = MEDICIONES.filter(
      (m) => m.deberiaResponder && m.distancia > 0.5,
    ).map((m) => m.pregunta);

    expect(rotas).toEqual([
      'qué horario tienen',
      'tienen estacionamiento',
      'Donde están ubicados',
      'dónde queda la clínica',
    ]);
  });

  it('subir el umbral a 0.75 dejaría entrar "quiero comprar un carro"', () => {
    const ajenasQuePasarian = MEDICIONES.filter(
      (m) => !m.deberiaResponder && m.distancia <= 0.75,
    );

    expect(ajenasQuePasarian).toHaveLength(2);
  });

  it('el margen es estrecho: 0.619 pasa y 0.723 no, con 0.65 en medio', () => {
    // Deja constancia de que no hay mucho aire. Un cambio de modelo de
    // embeddings obliga a re-medir, no a ajustar a ojo.
    const margen = 0.723 - 0.619;
    expect(margen).toBeLessThan(0.15);
  });
});

/**
 * Fallback léxico. Medido con `word_similarity` contra las FAQ de la base de
 * desarrollo (4 chunks del seed genérico), que es lo que había disponible.
 * Muestra pequeña: por eso el umbral se eligió conservador.
 */
const MEDICIONES_LEXICAS = [
  { pregunta: 'aceptan tarjeta', similitud: 0.65, chunkCorrecto: true },
  { pregunta: 'cuanto dura la consulta', similitud: 0.548, chunkCorrecto: true },
  { pregunta: 'que horario tienen', similitud: 0.368, chunkCorrecto: true },
  { pregunta: 'donde estan ubicados', similitud: 0.217, chunkCorrecto: false },
  { pregunta: 'atienden niños', similitud: 0.167, chunkCorrecto: false },
  { pregunta: 'hola que tal', similitud: 0.154, chunkCorrecto: false },
  { pregunta: 'quiero comprar un carro', similitud: 0.148, chunkCorrecto: false },
];

describe('calibración del RAG — fallback léxico', () => {
  it('deja pasar los aciertos inequívocos', () => {
    const aceptados = MEDICIONES_LEXICAS.filter(
      (m) => m.similitud >= DEFAULT_MIN_LEXICAL_SIMILARITY,
    );

    expect(aceptados.map((m) => m.pregunta)).toEqual([
      'aceptan tarjeta',
      'cuanto dura la consulta',
    ]);
  });

  it('NINGÚN match aceptado apunta al chunk equivocado', () => {
    // La propiedad que justifica el umbral conservador: preferimos no
    // responder a responder desde el chunk equivocado.
    const aceptados = MEDICIONES_LEXICAS.filter(
      (m) => m.similitud >= DEFAULT_MIN_LEXICAL_SIMILARITY,
    );

    expect(aceptados.every((m) => m.chunkCorrecto)).toBe(true);
  });

  it('bajar el umbral a 0.2 metería ruido con el chunk equivocado', () => {
    const conUmbralLaxo = MEDICIONES_LEXICAS.filter((m) => m.similitud >= 0.2);

    expect(conUmbralLaxo.some((m) => !m.chunkCorrecto)).toBe(true);
  });

  it('"quiero comprar un carro" queda fuera por mucho margen', () => {
    const ajena = MEDICIONES_LEXICAS.find(
      (m) => m.pregunta === 'quiero comprar un carro',
    )!;

    expect(DEFAULT_MIN_LEXICAL_SIMILARITY - ajena.similitud).toBeGreaterThan(0.3);
  });

  it('el tope de palabras cubre las preguntas cortas de WhatsApp', () => {
    // Las que el embedding falla son las de 2-4 palabras; el tope deja margen
    // sin abrir la puerta a frases largas donde el ruido léxico crece.
    for (const { pregunta } of MEDICIONES_LEXICAS) {
      expect(pregunta.split(/\s+/).length).toBeLessThanOrEqual(
        LEXICAL_FALLBACK_MAX_WORDS,
      );
    }
  });
});
