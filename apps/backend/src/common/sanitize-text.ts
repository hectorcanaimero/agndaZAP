/**
 * Sanitización de strings de entrada — remueve control chars ASCII y
 * unicode invisibles (zero-width, RTL overrides). Ver audit M5/N1.
 *
 * Uso típico en DTOs (class-validator + class-transformer):
 *
 * ```ts
 * import { Transform } from 'class-transformer';
 * import { stripControlChars } from '../../common/sanitize-text';
 *
 * @Transform(({ value }) =>
 *   typeof value === 'string' ? stripControlChars(value) : value,
 * )
 * name!: string;
 * ```
 *
 * Nota: NO tocamos `\n` ni `\t` en `reason`/`notes` porque son legítimos.
 * Este helper SÍ los stripea — usarlo sólo en campos donde no queremos
 * saltos de línea (nombres, títulos cortos). Para textos multi-línea,
 * escribir un helper aparte con whitelist de `\n`/`\t`.
 */
export function stripControlChars(input: string): string {
  return (
    input
      // Control chars ASCII (0x00-0x1F + DEL 0x7F): incluye \n, \t, \r. Correcto
      // para nombres cortos. NO usar en campos multi-línea.
      // eslint-disable-next-line no-control-regex
      .replace(/[\x00-\x1F\x7F]/g, '')
      // Zero-width chars + RTL overrides + BOM (invisibles usados para spoofing).
      .replace(
        /[​‌‍‎‏‪‫‬‭‮﻿]/g,
        '',
      )
      .trim()
  );
}
