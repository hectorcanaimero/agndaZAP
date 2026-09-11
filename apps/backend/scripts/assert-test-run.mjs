#!/usr/bin/env node
/**
 * Falla si la corrida de Jest fue verde pero incompleta.
 *
 * El código de salida de Jest ya cubre lo evidente —un suite que no arranca o
 * un fichero sin tests dan exit 1— pero **no cubre los tests que no se
 * ejecutaron**:
 *
 *   - `it.only` deja el resto del fichero sin correr y Jest sale 0 diciendo
 *     "1 passed". Es el caso peligroso: alguien depura en local, commitea el
 *     `.only` sin querer, y desactiva en silencio todos los demás tests de ese
 *     fichero — incluidos los que fallarían.
 *   - `it.skip` / `describe.skip` hacen lo mismo de forma más explícita, pero
 *     igual de silenciosa para CI.
 *
 * Verificado contra esta versión de Jest antes de escribir el script: un suite
 * entero saltado sale con código 0.
 *
 * Uso: `node scripts/assert-test-run.mjs <ruta del --outputFile de jest>`
 */
import { readFileSync } from 'node:fs';

const ruta = process.argv[2];
if (!ruta) {
  console.error('uso: assert-test-run.mjs <jest-results.json>');
  process.exit(2);
}

let r;
try {
  r = JSON.parse(readFileSync(ruta, 'utf8'));
} catch (e) {
  console.error(`no se pudo leer el resultado de Jest (${ruta}): ${e.message}`);
  process.exit(2);
}

const problemas = [];

// Suites que ni siquiera arrancaron. Jest ya devuelve exit 1, pero si algún día
// se corre con un reporter que se lo trague, acá queda cubierto.
const noArrancaron = (r.testResults ?? []).filter(
  (s) => s.testExecError || (s.failureMessage && s.assertionResults?.length === 0),
);
for (const s of noArrancaron) {
  problemas.push(`el suite no arrancó: ${s.name}`);
}

// Ficheros de test sin ningún test dentro: casi siempre un describe que se
// quedó vacío tras un refactor.
const vacios = (r.testResults ?? []).filter(
  (s) => !s.testExecError && (s.assertionResults?.length ?? 0) === 0,
);
for (const s of vacios) {
  problemas.push(`el suite no tiene ningún test: ${s.name}`);
}

// Lo que de verdad se escapa hoy: tests que existen y no se ejecutaron.
if ((r.numPendingTests ?? 0) > 0 || (r.numTodoTests ?? 0) > 0) {
  const saltados = (r.testResults ?? []).flatMap((s) =>
    (s.assertionResults ?? [])
      .filter((t) => t.status === 'pending' || t.status === 'todo')
      .map((t) => `  ${s.name.replace(process.cwd() + '/', '')} › ${t.fullName}`),
  );
  problemas.push(
    `hay ${r.numPendingTests + r.numTodoTests} test(s) sin ejecutar ` +
      `(it.only / it.skip / it.todo):\n${saltados.join('\n')}`,
  );
}

if (problemas.length > 0) {
  console.error('\n✖ La corrida de tests fue verde pero incompleta:\n');
  for (const p of problemas) console.error(`  - ${p}`);
  console.error(
    '\nSi el skip es intencional y temporal, quítalo antes de mergear o ' +
      'documenta por qué en el PR. Un test que no corre no protege nada, y ' +
      'en verde nadie se entera.\n',
  );
  process.exit(1);
}

console.log(
  `✔ corrida completa: ${r.numTotalTests} tests en ${r.numTotalTestSuites} suites, ninguno saltado`,
);
