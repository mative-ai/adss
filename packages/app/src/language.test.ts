/**
 * The language of the page (language.ts): the one `?lng=` names when it is a supported one, then the browser's when it
 * is, and English otherwise.
 */
import { describe, expect, it } from 'vitest';

import { readLanguage } from './language.ts';

describe('the language of the page', () => {
  it('is the one ?lng= names, whatever the browser says', () => {
    expect(readLanguage('?lng=es', 'it-IT')).toBe('es');
    expect(readLanguage('?lng=IT', 'en-US')).toBe('it');
    expect(readLanguage('?x=1&lng=en', 'es')).toBe('en');
  });

  it('is the browser’s when ?lng= is missing, empty or names a language that is not supported', () => {
    expect(readLanguage('', 'es-MX')).toBe('es');
    expect(readLanguage('?lng=', 'it-IT')).toBe('it');
    expect(readLanguage('?lng=xx', 'it-IT')).toBe('it');
  });

  it('is English when neither names a supported language', () => {
    expect(readLanguage('', 'de-DE')).toBe('en');
    expect(readLanguage('?lng=fr', 'ja')).toBe('en');
    expect(readLanguage('', '')).toBe('en');
  });
});
