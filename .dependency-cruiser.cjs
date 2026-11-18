/**
 * Package boundaries (CLAUDE.md §8, plan milestone M0). `npm run check:boundaries` cruises packages/;
 * tools/boundaries proves these rules still catch a core file that imports a UI library or a Node module.
 * Paths are matched anywhere in the tree (`(^|/)packages/…`) so that the probe fixtures, which mirror the
 * packages layout under tools/boundaries/fixtures/, fall under the same rules.
 */
const UI_LIBRARIES = '(three|react|react-dom|uplot|@react-three/[^/]+)';
const UI = `(^|/)node_modules/${UI_LIBRARIES}(/|$)|^${UI_LIBRARIES}$`;

module.exports = {
  forbidden: [
    {
      name: 'core-no-ui',
      comment: 'The core never imports a rendering or UI library, nor another package of this repo.',
      severity: 'error',
      from: { path: '(^|/)packages/core/src/' },
      to: { path: `${UI}|(^|/)packages/(app|worker|cli)/` },
    },
    {
      name: 'core-only-zod',
      comment: 'zod is the only npm dependency of the core.',
      severity: 'error',
      from: { path: '(^|/)packages/core/src/' },
      to: {
        dependencyTypes: ['npm', 'npm-dev', 'npm-optional', 'npm-peer', 'npm-no-pkg', 'npm-unknown'],
        pathNot: '(^|/)node_modules/zod/',
      },
    },
    {
      name: 'core-no-node-builtins',
      comment: 'The core runs in a Web Worker too: no Node built-in modules.',
      severity: 'error',
      from: { path: '(^|/)packages/core/src/' },
      to: { dependencyTypes: ['core'] },
    },
    {
      name: 'worker-no-ui',
      comment: 'The worker drives the core; it never renders and never reaches the app or the CLI.',
      severity: 'error',
      from: { path: '(^|/)packages/worker/src/' },
      to: { path: `${UI}|(^|/)packages/(app|cli)/` },
    },
    {
      name: 'browser-no-node-builtins',
      comment: 'App and worker run in the browser: Node built-ins only in the CLI and the repo tools.',
      severity: 'error',
      from: { path: '(^|/)packages/(app|worker)/' },
      to: { dependencyTypes: ['core'] },
    },
    {
      name: 'app-no-cli',
      severity: 'error',
      from: { path: '(^|/)packages/app/' },
      to: { path: '(^|/)packages/cli/' },
    },
    {
      name: 'no-circular',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
    {
      name: 'not-to-unresolvable',
      severity: 'error',
      from: {},
      to: { couldNotResolve: true },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    // node_modules must stay in the graph (only not followed), or the rules never see an npm import.
    exclude: { path: '(^|/)(dist|coverage)/' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.base.json' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default', 'types'],
      extensions: ['.ts', '.tsx', '.js', '.mjs', '.cjs', '.json'],
    },
  },
};
