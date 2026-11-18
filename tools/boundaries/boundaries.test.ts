/**
 * Milestone M0: the guards of packages/core still fire. Each probe under fixtures/ breaks one rule on
 * purpose; if a guard is loosened, its probe passes and this test fails. The fixtures are outside the
 * real cruise (`npm run check:boundaries` cruises packages/ only) and are ignored by ESLint and tsc.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ESLint } from 'eslint';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const FIXTURES = 'tools/boundaries/fixtures';
const CORE_FIXTURES = path.join(ROOT, FIXTURES, 'packages/core/src');

interface Violation {
  from: string;
  rule: { name: string };
}

function cruiseFixtures(): { errors: number; violations: Violation[] } {
  // One constant command string: the shell is needed for `npx` on Windows, and nothing here is user input.
  const run = spawnSync(`npx depcruise ${FIXTURES} --config .dependency-cruiser.cjs --output-type json`, {
    cwd: ROOT,
    encoding: 'utf8',
    shell: true,
  });
  if (!run.stdout) throw new Error(`depcruise produced no report: ${run.stderr}`);
  // The JSON reporter always exits 0; CI uses the default reporter, whose exit code is `summary.error`.
  const report = JSON.parse(run.stdout) as { summary: { error: number; violations: Violation[] } };
  return { errors: report.summary.error, violations: report.summary.violations };
}

describe('M0 package boundaries', () => {
  it('dependency-cruiser rejects UI libraries, other npm packages and Node built-ins in the core, and allows zod', () => {
    const { errors, violations } = cruiseFixtures();
    const brokenBy = (rule: string) => violations.filter((v) => v.rule.name === rule).map((v) => path.basename(v.from));

    expect(errors).toBeGreaterThan(0);
    expect(brokenBy('core-no-ui')).toEqual(expect.arrayContaining(['imports-three.ts', 'imports-react.ts']));
    expect(brokenBy('core-only-zod')).toContain('imports-npm.ts');
    expect(brokenBy('core-no-node-builtins')).toContain('imports-node.ts');
    expect(violations.map((v) => path.basename(v.from))).not.toContain('clean.ts');
  }, 60_000);

  it("the core's tsconfig has no DOM: `window` is a type error", () => {
    const parsed = ts.getParsedCommandLineOfConfigFile(
      path.join(ROOT, 'packages/core/tsconfig.json'),
      {},
      {
        ...ts.sys,
        onUnRecoverableConfigFileDiagnostic: (d) => {
          throw new Error(ts.flattenDiagnosticMessageText(d.messageText, '\n'));
        },
      },
    );
    if (!parsed) throw new Error('packages/core/tsconfig.json could not be read');

    const program = ts.createProgram([path.join(CORE_FIXTURES, 'uses-window.ts')], parsed.options);
    const messages = ts.getPreEmitDiagnostics(program).map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'));

    expect(messages).toEqual(expect.arrayContaining([expect.stringContaining("Cannot find name 'window'")]));
  });

  it('ESLint rejects wall-clock time, Math.random and browser globals in the core only', async () => {
    const source =
      'export const probes = [Math.random(), Date.now(), new Date(), performance.now(), window.innerWidth];\n';
    const eslint = new ESLint({ cwd: ROOT });
    const ruleIds = async (file: string) => {
      const [result] = await eslint.lintText(source, { filePath: path.join(ROOT, file) });
      return (result?.messages ?? []).map((m) => m.ruleId);
    };

    const core = await ruleIds('packages/core/src/probe.ts');
    expect(core.filter((id) => id === 'no-restricted-properties')).toHaveLength(2);
    expect(core.filter((id) => id === 'no-restricted-syntax')).toHaveLength(1);
    expect(core.filter((id) => id === 'no-restricted-globals')).toHaveLength(2);

    const cli = await ruleIds('packages/cli/src/probe.ts');
    for (const id of ['no-restricted-properties', 'no-restricted-syntax', 'no-restricted-globals']) {
      expect(cli).not.toContain(id);
    }
  }, 60_000);
});
