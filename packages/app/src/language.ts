/**
 * The language of the page. There is no access check: the simulator opens for everyone. The language is the one `?lng=`
 * names when it is a supported one, then the browser's when it is, and English otherwise.
 */
import { resolveLanguage, supportedLanguage, type Language } from './i18n/index.ts';

export function readLanguage(
  search: string = window.location.search,
  browserLanguage: string = navigator.language,
): Language {
  return supportedLanguage(new URLSearchParams(search).get('lng')) ?? resolveLanguage(browserLanguage);
}
