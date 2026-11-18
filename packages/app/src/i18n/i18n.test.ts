/**
 * The dictionaries (Phase 4; CLAUDE.md §7): Italian, English and Spanish have the same keys, none
 * empty, the same `{marks}` in each string, and no string left in another language's words; the tools that choose a
 * language and fill a string behave.
 */
import { describe, expect, it } from 'vitest';

import { SCENARIOS } from '../sim/scenarios.ts';
import {
  DICTIONARIES,
  format,
  LANGUAGES,
  marksOf,
  numberFormatter,
  resolveLanguage,
  supportedLanguage,
} from './index.ts';

type Leaves = Map<string, string>;

/** Every string of a dictionary by its path. */
function leaves(value: unknown, path = '', into: Leaves = new Map()): Leaves {
  if (typeof value === 'string') into.set(path, value);
  else if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) leaves(child, path ? `${path}.${key}` : key, into);
  }
  return into;
}

const byLanguage = Object.fromEntries(LANGUAGES.map((l) => [l, leaves(DICTIONARIES[l])])) as Record<
  (typeof LANGUAGES)[number],
  Leaves
>;

/** Strings that are the same word in the languages listed (a name, a symbol, a cognate), by path. */
const SAME_IN: Record<string, readonly string[]> = {
  'view.ego': ['it', 'en', 'es'],
  'events.who.ego': ['it', 'en', 'es'],
  'report.columns.ego': ['it', 'en', 'es'],
  'view.zone': ['it', 'en', 'es'],
  'view.mode3d': ['it', 'en', 'es'],
  'view.mode': ['it', 'es'],
  'theme.label': ['it', 'es'],
  'report.none': ['it', 'en', 'es'],
  'scenario.heading': ['it', 'en'],
  'controls.reset': ['it', 'en'],
  'controls.pause': ['it', 'es'],
  'controls.ghost': ['it', 'es'],
  'view.ghost': ['it', 'es'],
  'events.who.ghost': ['it', 'es'],
  'report.columns.ghost': ['it', 'es'],
  'events.obstacles.moose': ['it', 'es'],
};

describe('the dictionaries', () => {
  it('have the same keys in every language, and no empty string', () => {
    const keys = [...byLanguage.it.keys()];
    expect(keys.length).toBeGreaterThan(80);
    for (const language of LANGUAGES) {
      expect([...byLanguage[language].keys()]).toEqual(keys);
      for (const [path, text] of byLanguage[language]) expect(text.trim(), `${language} ${path}`).not.toBe('');
    }
  });

  it('carry the same {marks} in every language of a string', () => {
    for (const [path, text] of byLanguage.en) {
      for (const language of LANGUAGES) {
        expect(marksOf(byLanguage[language].get(path) ?? ''), `${language} ${path}`).toEqual(marksOf(text));
      }
    }
  });

  it('are translated: languages with the same string are those that spell that word alike', () => {
    const untranslated: string[] = [];
    for (const path of byLanguage.en.keys()) {
      const groups = new Map<string, string[]>();
      for (const language of LANGUAGES) {
        const text = byLanguage[language].get(path) ?? '';
        groups.set(text, [...(groups.get(text) ?? []), language]);
      }
      const same = SAME_IN[path] ?? [];
      for (const group of groups.values()) {
        if (group.length > 1 && !group.every((language) => same.includes(language))) {
          untranslated.push(`${group.join(' = ')}: ${path}`);
        }
      }
    }
    expect(untranslated).toEqual([]);
  });

  it('name every scenario and every obstacle of the v1 scenarios', () => {
    for (const language of LANGUAGES) {
      const t = DICTIONARIES[language];
      expect(Object.keys(t.scenario.names).sort()).toEqual(SCENARIOS.map((s) => s.id).sort());
      expect(Object.keys(t.scenario.summaries).sort()).toEqual(SCENARIOS.map((s) => s.id).sort());
      for (const { json } of SCENARIOS) {
        for (const o of json.obstacles) expect(t.events.obstacles[o.id], `${language} ${o.id}`).toBeTruthy();
      }
    }
  });

  it('state that the simulator is educational and not for homologation, and that the result is a simulation', () => {
    expect(DICTIONARIES.it.disclaimer).toBe('Simulazione didattica, non omologativa');
    expect(DICTIONARIES.it.simulation).toBe('Simulazione');
    expect(DICTIONARIES.en.disclaimer).toMatch(/educational/i);
    expect(DICTIONARIES.es.disclaimer).toMatch(/didáctica/i);
  });
});

describe('the language tools', () => {
  it('choose a supported language from a tag, English by default', () => {
    expect(resolveLanguage('es-MX')).toBe('es');
    expect(resolveLanguage('EN')).toBe('en');
    expect(resolveLanguage('it-IT')).toBe('it');
    expect(resolveLanguage('de-DE')).toBe('en');
    expect(resolveLanguage(null)).toBe('en');
    expect(resolveLanguage('')).toBe('en');
  });

  it('say whether a tag names a supported language at all', () => {
    expect(supportedLanguage('es-MX')).toBe('es');
    expect(supportedLanguage('de-DE')).toBeUndefined();
    expect(supportedLanguage('')).toBeUndefined();
    expect(supportedLanguage(undefined)).toBeUndefined();
  });

  it('fill the marks of a string, leaving one without a value as written', () => {
    expect(format('{time} s · {who}', { time: '2,95', who: 'MPC' })).toBe('2,95 s · MPC');
    expect(format('a {x} b {y}', { x: 1 })).toBe('a 1 b {y}');
  });

  it('write numbers as the language does, with fixed decimals and no "-0"', () => {
    expect(numberFormatter('it')(3.456, 2)).toBe('3,46');
    expect(numberFormatter('en')(3.456, 2)).toBe('3.46');
    expect(numberFormatter('es')(1234.5, 1)).toBe('1234,5');
    expect(numberFormatter('en')(-0.004, 2)).toBe('0.00');
    expect(numberFormatter('en')(-0.4, 1)).toBe('-0.4');
  });
});
