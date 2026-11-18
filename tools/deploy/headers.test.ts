/**
 * The deployment's headers (deploy/): the policy for the hosting (Phase 5), no WebAssembly, and the two ways an nginx
 * file loses a header or leaks something without anyone noticing: a location that sets a header of its own drops the
 * inherited ones, and a log line can carry the query string, where something private may travel.
 */
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const read = (name: string): string => readFileSync(new URL(`../../deploy/${name}`, import.meta.url), 'utf8');

const headers = read('security-headers.conf');
const server = read('nginx.conf');
const SHARED = 'include /etc/nginx/snippets/security-headers.conf;';

function header(name: string): string {
  const match = new RegExp(`^add_header ${name} "([^"]*)" always;$`, 'm').exec(headers);
  if (!match?.[1]) throw new Error(`deploy/security-headers.conf has no ${name} header`);
  return match[1];
}

/** The directives of the Content-Security-Policy, each with its sources. */
function policy(): Map<string, string[]> {
  const directives = new Map<string, string[]>();
  for (const part of header('Content-Security-Policy').split(';')) {
    const [name, ...sources] = part.trim().split(/\s+/);
    if (name) directives.set(name, sources);
  }
  return directives;
}

/** The `location` blocks of nginx.conf, with their text between the braces. */
function locations(): { head: string; body: string }[] {
  return [...server.matchAll(/location\s+([^{]+)\{([^}]*)\}/g)].map((match) => ({
    head: (match[1] ?? '').trim(),
    body: match[2] ?? '',
  }));
}

describe('Content-Security-Policy', () => {
  it('lets scripts, styles, fonts, models and workers come from the page’s own origin only', () => {
    const directives = policy();
    for (const name of ['script-src', 'style-src', 'font-src', 'connect-src', 'worker-src']) {
      expect(directives.get(name), name).toEqual(["'self'"]);
    }
  });

  it('allows no inline or evaluated code, and no WebAssembly compilation', () => {
    expect(header('Content-Security-Policy')).not.toMatch(/unsafe-inline|unsafe-eval|wasm-unsafe-eval/);
  });

  it('names no outside origin', () => {
    const allowed = new Set(["'self'", "'none'", 'data:']);
    for (const [name, sources] of policy()) {
      for (const source of sources) expect(allowed.has(source), `${name} ${source}`).toBe(true);
    }
  });

  it('allows data: for images only', () => {
    for (const [name, sources] of policy()) {
      expect(sources.includes('data:'), name).toBe(name === 'img-src');
    }
  });

  it('denies by default, and forbids embedding, plug-ins, a base element and forms', () => {
    const directives = policy();
    for (const name of ['default-src', 'frame-ancestors', 'object-src', 'base-uri', 'form-action']) {
      expect(directives.get(name), name).toEqual(["'none'"]);
    }
  });
});

describe('the other headers', () => {
  it('stop sniffing, embedding and referrers, and keep the site out of search results', () => {
    expect(header('X-Content-Type-Options')).toBe('nosniff');
    expect(header('X-Frame-Options')).toBe('DENY');
    expect(header('Referrer-Policy')).toBe('no-referrer');
    expect(header('X-Robots-Tag')).toMatch(/^noindex/);
  });
});

describe('nginx.conf', () => {
  it('includes the shared headers in the server block', () => {
    const outside = server.replace(/location\s+[^{]+\{[^}]*\}/g, '');
    expect(outside).toContain(SHARED);
  });

  it('includes the shared headers in every location that sets a header of its own', () => {
    const own = locations().filter(({ body }) => body.includes('add_header'));
    expect(own.length).toBeGreaterThan(0);
    for (const { head, body } of own) expect(body, `location ${head}`).toContain(SHARED);
  });

  it('keeps the query string, the referrer and the cookie out of the access log', () => {
    const format = /log_format\s+noquery\s+([^;]+);/.exec(server)?.[1];
    expect(format).toBeDefined();
    expect(format).not.toMatch(/\$request\b|\$request_uri|\$args|\$query_string|\$http_referer|\$http_cookie/);
    expect(server).toMatch(/access_log\s+\/dev\/stdout\s+noquery;/);
  });

  it('keeps a long cache for a successful answer only, never for a 404', () => {
    const long = [...server.matchAll(/add_header Cache-Control "([^"]*)"( always)?;/g)].filter((match) =>
      /max-age=(\d{4,})/.test(match[1] ?? ''),
    );
    expect(long.length).toBeGreaterThan(0);
    for (const match of long) expect(match[2], `Cache-Control ${match[1]}`).toBeUndefined();
  });

  it('answers reads only', () => {
    expect(server).toMatch(/if \(\$request_method !~ \^\(GET\|HEAD\)\$\) \{\s*return 405;/);
  });
});
