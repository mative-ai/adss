# Versioning

How this project numbers its releases, what counts as a breaking change, and who does what. The maintainers (Mative)
decide when to release, and make no promise about when.

## The scheme

[Semantic Versioning 2.0.0](https://semver.org): `MAJOR.MINOR.PATCH`, for example `1.4.2`, and `1.0.0-rc.1` for a
pre-release. A release is an annotated git tag on `main` named `v1.4.2`, and a GitHub release whose notes are the
changelog entry ([CHANGELOG.md](CHANGELOG.md)).

Nothing is published to a package registry. This is an application, and the packages in the repository are not
published, so a TypeScript import between them is not a public interface and carries no promise.

**Where we are.** No version number is set yet and there is no tag. The first release will be `0.1.0`.

## What a version promises

A library promises its API. A simulator promises that what you built on it keeps working, and that its results can be
trusted and repeated. So the **contract** is these five things:

1. **Results.** For a scenario, a seed and a configuration, the fingerprint that `npm run sim` prints, and the figures
   of the report. The same version gives the same result on every run.
2. **Scenario files:** the JSON in `scenarios/`, its schema (`packages/core/src/scenario/schema.ts`) and the scenario
   ids.
3. **The CSV export:** its columns and what they mean. A file exported by a version reloads in the later versions of the
   same major line.
4. **The command line:** the `npm run` scripts that the README documents, and the flags and the output of `npm run sim`.
5. **The address parameters of the app** that the README documents (`?lng=`).

Outside the contract, and free to change in any release: the imports between packages, the look of the interface and
the text of its messages, the generated 3D models, and the internals of the controller and the solvers, as long as the
results of point 1 are stated.

The worker protocol has a number of its own, `PROTOCOL_VERSION` in `packages/worker/src/protocol.ts`: a whole number that
grows with every change to a message, a field or the layout of a frame, and that the page and the worker check when
they start. It is not part of the contract, and it does not decide the version of a release.

## What changes which number

| Change                                                                                                                                                                                                                                           | Bump               |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------ |
| A scenario file that was valid is rejected; a scenario id is removed or renamed; a CSV file exported before no longer reloads; a documented flag, script or address parameter is removed or renamed or its output changes in an incompatible way | **MAJOR**          |
| A new scenario, controller, sensor option, language or page; a new optional field that old files do without; a new flag; a deprecation                                                                                                           | **MINOR**          |
| A fix, a performance gain, a documentation or translation fix, a dependency update with no visible effect, a refactor that leaves every result as it was                                                                                         | **PATCH**          |
| A change that moves the fingerprint of an existing scenario at the same seed                                                                                                                                                                     | **at least MINOR** |

A change that moves a fingerprint is never hidden in a patch. The changelog lists it under **Results changed**, with
the reason and the old and the new fingerprint of the four scenarios at seed 1, and the golden value changes with its
reason stated in the commit, as [CONTRIBUTING.md](CONTRIBUTING.md) already requires.

**Before 1.0.0.** In `0.y.z` the contract is not yet stable: a MINOR release may break it, and says so under
**Breaking** in the changelog; a PATCH release only fixes. The maintainers call it `1.0.0` when the scenario schema, the
CSV format and the command line are documented and stable, and the fingerprints of the four scenarios are recorded in
the changelog.

## Deprecation

A feature of the contract is deprecated in a MINOR release, with a line in the changelog and a warning where one can be
shown, and removed no earlier than the next MAJOR release.

## Supported versions

Only the latest release gets fixes. A security fix is a PATCH on it; [SECURITY.md](SECURITY.md) says how to report one.

## The changelog

[CHANGELOG.md](CHANGELOG.md) follows [Keep a Changelog](https://keepachangelog.com): sections **Added**, **Changed**,
**Deprecated**, **Removed**, **Fixed**, **Security**, and the two of this project, **Breaking** and **Results
changed**. The author of a change that a user can see adds a line under `## [Unreleased]` in the same pull request. The
maintainers move those lines under the new version at the release.

## For contributors

- Do not change the version, and do not tag. Add a line under `Unreleased`.
- If your change touches the contract, say so in the description of the pull request: "Breaking" or "Results changed",
  and why.
- A change to the worker protocol raises `PROTOCOL_VERSION` in the same commit, as [AGENTS.md](AGENTS.md) says.

## Making a release (maintainers)

1. `main` is green: `npm run verify` and `npm run build`. Run `npm run sim -- --scenario <id> --seed 1` for the four
   scenarios and keep the fingerprints for the notes.
2. In `CHANGELOG.md`, move `Unreleased` under the new version with its date. Set `version` in the root `package.json`.
3. Commit as `chore(release): vX.Y.Z`, tag `vX.Y.Z` (annotated), push the commit and the tag, and publish the GitHub
   release with the changelog entry as its notes.

The hosted version runs the maintainers' own build of the code and may be ahead of, or behind, the latest release.
