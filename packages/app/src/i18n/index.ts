/**
 * The dictionaries and the small tools that fill them (Phase 4). The language comes from the access
 * token; until the token exists (Phase 5) see access.ts.
 */
import { en } from './en.ts';
import { es } from './es.ts';
import { it } from './it.ts';
import { LANGUAGES, type Dictionary, type Language } from './types.ts';

export { LANGUAGES, type Dictionary, type Language };

export const DICTIONARIES: Readonly<Record<Language, Dictionary>> = { it, en, es };

/** The supported language a tag like `es-MX` or `EN` names; Italian, the first language, otherwise. */
export function resolveLanguage(tag: string | null | undefined): Language {
  const base = tag?.toLowerCase().split('-')[0];
  return LANGUAGES.find((language) => language === base) ?? 'it';
}

/** `template` with each `{name}` replaced by its value; a mark without a value stays as written. */
export function format(template: string, values: Readonly<Record<string, string | number>>): string {
  return template.replace(/\{(\w+)\}/g, (mark, key: string) => (key in values ? String(values[key]) : mark));
}

/** The marks of a template, for the check that the three languages carry the same. */
export const marksOf = (template: string): string[] =>
  [...template.matchAll(/\{(\w+)\}/g)].map((m) => m[1] ?? '').sort();

export type NumberFormatter = (value: number, digits: number) => string;

/** Numbers as the language writes them (comma or point), with a fixed count of decimals and no "-0". */
export function numberFormatter(language: Language): NumberFormatter {
  const formats = new Map<number, Intl.NumberFormat>();
  return (value, digits) => {
    let f = formats.get(digits);
    if (!f) {
      f = new Intl.NumberFormat(language, { minimumFractionDigits: digits, maximumFractionDigits: digits });
      formats.set(digits, f);
    }
    return f.format(Math.abs(value) < 0.5 * 10 ** -digits ? 0 : value);
  };
}
