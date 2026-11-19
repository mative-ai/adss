# Contributing

Thank you for wanting to help. This is a small simulator with a few strict rules, because its results have to be exact and
repeatable. This page says how to help, what is in scope, and which rules a change has to keep.

## Ways to help

- **Bug reports.** Say what you did, what you expected and what happened, with the scenario, the seed and your browser.
  A run is rebuilt from the scenario, the seed and the configuration, so these three let us reproduce it.
- **Scenarios**, **translations** into new languages, **accessibility** and **performance** fixes, and **documentation**.
- **Code**: fixes and features. Open an issue before a large change, so that nobody writes something that cannot be
  merged.
- **Something from [HELP_WANTED.md](HELP_WANTED.md)**: ideas the maintainers would like help with, from a first pull
  request to a project of several weeks. Say in an issue which one you take.

## Your first contribution

1. Find something: an issue labeled `good first issue`, or an idea of [HELP_WANTED.md](HELP_WANTED.md). Say in the issue
   that you take it, so that two people do not do the same work.
2. Fork the repository, clone your fork, and make a branch named `feat/…` or `fix/…`.
3. Set up (below), make the change, and write its test.
4. Run `npm run verify`, and `npm run build` for a change to the app.
5. Open a pull request against `main`. The template holds the checklist; the title is a Conventional Commit subject, as
   for a commit.
6. A maintainer reviews it. Expect questions about the code; they are never about you.

Stuck at any step? See [SUPPORT.md](SUPPORT.md).

## What is in scope

The simulator has four scenarios (pedestrian crossing, moose test, curve with an ice patch, μ-split braking), at most two
critical obstacles in a scenario, and a car and a rigid truck. A new scenario, a new vehicle or a new kind of obstacle is
a larger change: discuss it in an issue first. The maintainers decide what goes in.

## Set up

You need Node.js 22.18 or later (24 is what CI uses) and npm.

```sh
npm ci
npm run dev        # the development server
npm run verify     # the gate: types, lint, format, package boundaries and tests
npm run build      # the production build
```

The repository is an npm workspace: `packages/core` is the simulation (pure TypeScript, no browser), `packages/worker`
runs it in a Web Worker, `packages/app` is the interface and `packages/cli` runs it headless in Node. `scenarios/` holds
the scenario files, `tools/` the model generator and the checks, and `deploy/` the nginx image. The README has the table.
[AGENTS.md](AGENTS.md) holds the engineering rules in full; the comments in the code cite its sections by number.

## The rules a change keeps

Each rule says what guards it. `npm run verify` runs most of them, and a pull request has to pass it.

- **The gate is green.** `npm run verify` (TypeScript in every package, ESLint, Prettier, the package boundaries, the
  tests), and `npm run build` for a change to the app. Run a focused test first with `npx vitest run <file>`.
- **The core is deterministic.** In `packages/core` there is no `Math.random`, `Date.now`, `performance.now` or
  `new Date()`, no `window` or `document`, and no import of `three` or `react`. Three guards enforce it: the core's
  tsconfig, the `mpc/core-determinism` block of `eslint.config.mjs`, and the dependency rules of
  `.dependency-cruiser.cjs` (`npm run check:boundaries`). The probes in `tools/boundaries/` prove that each guard still
  fires: never loosen a guard to make a probe pass.
- **Time is an integer tick** at 1 kHz, never a float that accumulates. Random numbers come only from seeded streams
  (`Prng.create(seed, stream)`).
- **The same seed gives the same result.** `npm run sim -- --scenario pedestrian --seed 1` prints the same fingerprint on
  every run, and `packages/core/test/golden.test.ts` holds a golden hash. A golden value changes only with a reason
  stated in the commit message, never to make a failing test pass.
- **The worker protocol is typed and versioned.** A change updates both sides and the version in
  `packages/worker/src/protocol.ts` in the same commit.
- **Every language has every key, really translated.** The interface is in English, Italian and Spanish;
  `packages/app/src/i18n/i18n.test.ts` fails when a language lacks a key or a `{mark}`. To add a language: add its code
  to `LANGUAGES` in `i18n/types.ts`, write its dictionary in a new file next to `en.ts` (the type `Dictionary` lists every
  key), and register it in `DICTIONARIES` in `i18n/index.ts`.
- **The interface stays accessible.** It works with the keyboard (Space, R, the arrows), respects
  `prefers-reduced-motion`, and shows every value also as text, never by color alone. Try it with `npm run dev`, in the
  light and the dark theme, at a wide and a narrow width.
- **Headers stay strict.** The Content-Security-Policy and the other headers are in `deploy/security-headers.conf`, and
  `tools/deploy/headers.test.ts` guards them: no inline script, no `eval`, no WebAssembly, nothing but the page's own
  origin. Change a header together with its test.
- **No new dependency without a discussion**, and none under a GPL or LGPL license in the bundle (MIT, BSD, Apache-2.0
  and OFL are fine). A new library adds its notice to `packages/app/public/third-party-notices.txt` in the same change.
- **No third-party model, texture or photograph**, unless it is CC0 and has its notice. The models are generated by
  `tools/models` (`npm run models`): change a model in its code, never in its file, and commit the files the command
  writes; a test fails when the two differ.
- **A figure shown as a result comes from a run** of the simulator. The simulator is an educational simulation: it is
  never presented as certified, tested for homologation or a production system.

## Working with an AI coding agent

You may use a coding agent from a command-line console (Claude Code, Codex CLI, Gemini CLI, OpenCode and others).
[AGENTS.md](AGENTS.md) is written for them: the commands, the boundaries, what not to touch, and how to add a scenario or
a language. What you submit is yours: read the diff, run `npm run verify`, and be sure that you have the right to
contribute every line (see below). It helps the review if the pull request says that an agent wrote a large part of it.

## Commits and pull requests

- Commits are [Conventional Commits](https://www.conventionalcommits.org) in English, with the package or the area as
  the scope: `feat(core): …`, `fix(mpc): …`, `feat(app): …`, `docs: …`. The subject says what changed in the
  simulator's behavior. Branches are named `feat/…` or `fix/…`.
- Before you open a pull request: `npm run verify` is green; the change has a test, or the pull request says why it
  cannot; a changed golden hash has its reason; a change that a user can see has a line under `Unreleased` in
  [CHANGELOG.md](CHANGELOG.md), and one that touches the contract says so ([VERSIONING.md](VERSIONING.md)); no secret,
  token or personal data is in the diff; the text you wrote is in English (the interface copy is in all three
  languages).
- The maintainers (Mative) review pull requests, and make no promise about how fast.

## Your contribution and its license

The project is under the [MIT License](LICENSE). A contribution you submit is licensed under the same terms: by opening
a pull request you agree to that. Write only what you have the right to contribute. You may add a
`Signed-off-by: Your Name <your email>` line to a commit (`git commit -s`) to say you agree to the
[Developer Certificate of Origin](https://developercertificate.org); it is welcome, not required.

## Security

Do not report a vulnerability in an issue. Follow [SECURITY.md](SECURITY.md).

## Be kind

Be patient and respectful with everyone who takes part, whatever their experience. Criticize the code, not the person,
and assume good faith. This project follows its [code of conduct](CODE_OF_CONDUCT.md); a maintainer may close a
discussion or remove a comment that is abusive.
