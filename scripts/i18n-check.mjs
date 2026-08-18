#!/usr/bin/env node
// @ts-check

/**
 * i18n-check — validador de traducciones de `apps/web`.
 *
 * Corre 2 chequeos:
 *
 * 1. **Paridad estricta** de paths escalares entre `es.json` (source of truth)
 *    y todos los demás locales (`pt.json`). Falla si:
 *    - Un locale tiene keys que el source no tiene (huérfanas).
 *    - El source tiene keys que un locale no tiene (faltantes).
 *    - El shape difiere en algún path (ej. string vs object).
 *
 * 2. **Missing keys por consumidor** — para cada archivo `.tsx` que usa
 *    `useTranslations('namespace')`, verifica que cada `t('key')` /
 *    `t.rich('key')` corresponda a un path existente en el source.
 *
 * Ambos chequeos son load-bearing: el patrón de MISSING_MESSAGE apareció 3+
 * veces en agosto 2026, y el type-safe next-intl (PR #11) cubre la mayoría
 * pero no todos los casos (templates dinámicos `t(\`status.\${x}\`)` requieren
 * castings que el chequeo estructural atrapa).
 *
 * Uso:
 *   node scripts/i18n-check.mjs
 *
 * Exit codes:
 *   0 — todo OK
 *   1 — errores de paridad o missing keys
 *   2 — error de configuración / archivos ausentes
 */

import { readFile, readdir } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const MESSAGES_DIR = join(REPO_ROOT, 'apps/web/messages');
const SRC_DIR = join(REPO_ROOT, 'apps/web/src');
const SOURCE_LOCALE = 'es';

/** ANSI colors sin dependencias. */
const c = {
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
};

/**
 * Devuelve todos los paths escalares (a strings) de un objeto JSON, en formato
 * dotted (`panel.settings.tabs.general`).
 */
function collectPaths(obj, prefix = '') {
  const paths = new Set();
  for (const [k, v] of Object.entries(obj)) {
    const full = prefix ? `${prefix}.${k}` : k;
    if (typeof v === 'string') {
      paths.add(full);
    } else if (v !== null && typeof v === 'object') {
      for (const p of collectPaths(v, full)) paths.add(p);
    }
  }
  return paths;
}

/**
 * Verifica que `full` (path dotted) existe como string en `obj`.
 * Devuelve `true` si existe, `false` si no.
 */
function pathExists(obj, full) {
  const parts = full.split('.');
  let cur = obj;
  for (const p of parts) {
    if (cur === null || typeof cur !== 'object' || !(p in cur)) return false;
    cur = cur[p];
  }
  return typeof cur === 'string';
}

/** Walker recursivo de archivos por extensión. Sin deps externas. */
async function walk(dir, exts) {
  const out = [];
  async function inner(d) {
    let entries;
    try {
      entries = await readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = join(d, e.name);
      if (e.isDirectory()) {
        if (e.name === 'node_modules' || e.name === '.next') continue;
        await inner(full);
      } else if (exts.some((x) => e.name.endsWith(x))) {
        out.push(full);
      }
    }
  }
  await inner(dir);
  return out;
}

async function main() {
  if (!existsSync(MESSAGES_DIR) || !statSync(MESSAGES_DIR).isDirectory()) {
    console.error(c.red(`✗ No existe ${MESSAGES_DIR}`));
    process.exit(2);
  }

  const files = (await readdir(MESSAGES_DIR)).filter((f) => f.endsWith('.json'));
  if (!files.includes(`${SOURCE_LOCALE}.json`)) {
    console.error(c.red(`✗ Falta el source ${SOURCE_LOCALE}.json`));
    process.exit(2);
  }

  const locales = {};
  for (const f of files) {
    const raw = await readFile(join(MESSAGES_DIR, f), 'utf8');
    locales[f.replace('.json', '')] = JSON.parse(raw);
  }

  const source = locales[SOURCE_LOCALE];
  const sourcePaths = collectPaths(source);

  let hasErrors = false;

  /* ─────────── 1. Paridad entre locales ─────────── */

  console.log(c.bold(`\n▸ Paridad de locales (source: ${SOURCE_LOCALE}.json)`));
  for (const [locale, obj] of Object.entries(locales)) {
    if (locale === SOURCE_LOCALE) continue;
    const otherPaths = collectPaths(obj);
    const missingInLocale = [...sourcePaths].filter((p) => !otherPaths.has(p));
    const extraInLocale = [...otherPaths].filter((p) => !sourcePaths.has(p));

    if (missingInLocale.length === 0 && extraInLocale.length === 0) {
      console.log(c.green(`  ✓ ${locale}.json — paridad OK`));
      continue;
    }
    hasErrors = true;
    console.log(c.red(`  ✗ ${locale}.json`));
    if (missingInLocale.length > 0) {
      console.log(c.dim(`    Faltan (${missingInLocale.length}):`));
      for (const p of missingInLocale.slice(0, 10)) console.log(`      - ${p}`);
      if (missingInLocale.length > 10)
        console.log(c.dim(`      … y ${missingInLocale.length - 10} más`));
    }
    if (extraInLocale.length > 0) {
      console.log(c.dim(`    Sobran (${extraInLocale.length}):`));
      for (const p of extraInLocale.slice(0, 10)) console.log(`      + ${p}`);
      if (extraInLocale.length > 10)
        console.log(c.dim(`      … y ${extraInLocale.length - 10} más`));
    }
  }

  /* ─────────── 2. Missing keys por consumidor ─────────── */

  console.log(c.bold(`\n▸ Missing keys por archivo cliente`));
  const tsxFiles = await walk(SRC_DIR, ['.tsx', '.ts']);
  const NS_RE = /useTranslations\(\s*['"`]([^'"`]+)['"`]\s*\)/g;
  const T_RE = /\bt(?:\.rich)?\(\s*['"]([^'"$\\`]+)['"]/g;

  let totalMissing = 0;
  for (const file of tsxFiles) {
    const content = await readFile(file, 'utf8');
    const namespaces = [...content.matchAll(NS_RE)].map((m) => m[1]);
    if (namespaces.length === 0) continue;
    if (namespaces.length > 1) {
      // Múltiples namespaces en el archivo — el matcher heurístico no puede
      // decidir a cuál pertenece cada t(). Chequeamos que la key concatenada
      // con ALGÚN namespace exista; si no, es candidato a missing.
    }
    const tCalls = [...content.matchAll(T_RE)].map((m) => m[1]);
    const missing = [];
    for (const call of tCalls) {
      // ¿Existe con al menos uno de los namespaces?
      const found = namespaces.some((ns) => pathExists(source, `${ns}.${call}`));
      if (!found) {
        // Reportamos usando el PRIMER namespace del archivo (mejor guess).
        missing.push(`${namespaces[0]}.${call}`);
      }
    }
    if (missing.length > 0) {
      totalMissing += missing.length;
      hasErrors = true;
      console.log(c.red(`  ✗ ${relative(REPO_ROOT, file)}`));
      for (const m of missing) console.log(`      - ${m}`);
    }
  }
  if (totalMissing === 0) {
    console.log(c.green(`  ✓ Sin missing keys`));
  }

  /* ─────────── Resultado final ─────────── */

  if (hasErrors) {
    console.log(c.red(`\n✗ i18n check falló`));
    process.exit(1);
  }
  console.log(c.green(`\n✓ i18n check OK`));
}

main().catch((e) => {
  console.error(c.red(`✗ Error inesperado: ${e.message}`));
  process.exit(2);
});
