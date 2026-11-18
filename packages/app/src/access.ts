/**
 * Who may open the simulator, and in which language. The access token (Phase 5, not built yet) decides
 * both: signed by the landing, verified in the browser, its `lng` the language. Until it exists:
 *
 * - the development server (`npm run dev`) grants access, in the language of `?lng=` (Italian by default), and
 *   `?access=missing` or `?access=expired` shows the permission state;
 * - the production build never grants it: it shows the permission state, in the browser's language, so nothing
 *   opens before the token check can stand in front of it. `import.meta.env.DEV` is a constant in a build, so the
 *   development branch is not in the bundle.
 *
 * Phase 5 replaces `readAccess` and nothing else.
 */
import { resolveLanguage, type Language } from './i18n/index.ts';

/** The landing: where the permission state sends a visitor without a valid link, and the contact action. */
export const LANDING_URL = 'https://mative.ai';

export interface Access {
  readonly status: 'granted' | 'missing' | 'expired';
  readonly language: Language;
}

export function readAccess(
  search: string = window.location.search,
  browserLanguage: string = navigator.language,
): Access {
  if (!import.meta.env.DEV) return { status: 'missing', language: resolveLanguage(browserLanguage) };
  const params = new URLSearchParams(search);
  const asked = params.get('access');
  return {
    status: asked === 'missing' || asked === 'expired' ? asked : 'granted',
    language: resolveLanguage(params.get('lng')),
  };
}
