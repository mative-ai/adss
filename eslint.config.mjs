/**
 * ESLint flat config.
 *
 * `mpc/core-determinism` is one of the three guards of packages/core (CLAUDE.md §8): the core runs the same
 * in a worker and in Node, and a run must replay bit-identical from its seed. The other two guards are the
 * core's tsconfig (ES2022 library only) and the rules in .dependency-cruiser.cjs; tools/boundaries proves
 * that all three still fire.
 */
import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const CORE_RULE = 'packages/core must stay deterministic and free of browser and Node APIs (CLAUDE.md §8)';

export default defineConfig(
  {
    ignores: ['**/node_modules/**', '**/dist/**', '**/coverage/**', '.claude/**', 'tools/boundaries/fixtures/**'],
  },

  js.configs.recommended,
  tseslint.configs.recommended,

  {
    files: ['packages/app/**/*.{ts,tsx}'],
    languageOptions: { globals: globals.browser },
  },
  {
    files: ['packages/worker/**/*.ts'],
    languageOptions: { globals: globals.worker },
  },
  {
    files: [
      'packages/cli/**/*.ts',
      'tools/**/*.ts',
      '*.config.{ts,mjs}',
      'packages/*/*.config.ts',
      '.dependency-cruiser.cjs',
    ],
    languageOptions: { globals: globals.node },
  },

  {
    name: 'mpc/core-determinism',
    files: ['packages/core/src/**/*.ts'],
    rules: {
      'no-restricted-globals': [
        'error',
        ...['window', 'document', 'navigator', 'self', 'performance', 'crypto', 'setTimeout', 'setInterval'].map(
          (name) => ({ name, message: `${CORE_RULE}.` }),
        ),
      ],
      'no-restricted-properties': [
        'error',
        { object: 'Math', property: 'random', message: `${CORE_RULE}: use a seeded PRNG stream.` },
        { object: 'Date', property: 'now', message: `${CORE_RULE}: time is the integer tick.` },
      ],
      'no-restricted-syntax': [
        'error',
        { selector: "NewExpression[callee.name='Date']", message: `${CORE_RULE}: time is the integer tick.` },
      ],
    },
  },
);
