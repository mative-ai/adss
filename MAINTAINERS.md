# Maintainers

The project is maintained by Mative Srl, through the GitHub organization `mative-ai`. The maintainers review pull
requests, triage issues, decide what is in scope and cut the releases ([VERSIONING.md](VERSIONING.md)). They do it on a
best-effort basis and make no promise about how fast.

## How decisions are made

The maintainers decide, in the open: in the issue or the pull request, with the reasons. The decisions that shape the
simulator (the RTI-MPC, the QP solver, the vehicle model) change only after a discussion in an issue. An idea of
[HELP_WANTED.md](HELP_WANTED.md) is an invitation to discuss, not a promise to merge.

## Becoming a maintainer

A contributor who helps over time, with good changes and careful reviews, and who is kind to others, may be invited by
the maintainers to review and merge.

## Triage

A new issue carries `needs triage`. A maintainer reads it, replaces that label with the ones that fit, and answers:

- **Kind:** `bug`, `enhancement`, `documentation`, `question` (which goes to Discussions).
- **Size:** `size: small`, `size: medium` or `size: large`, as [HELP_WANTED.md](HELP_WANTED.md) defines them. A large one
  also has `needs discussion`.
- **Area:** `area: core`, `area: mpc`, `area: scenarios`, `area: sensors`, `area: app`, `area: graphics`, `area: i18n`
  or `area: tools`.
- **Contract:** `breaking` or `results changed`, for a change that touches [VERSIONING.md](VERSIONING.md).
- **Invitation:** `good first issue` for a first contribution with pointers and a clear end, `help wanted` for the
  rest. Keep the first kind curated: an item without pointers and a "done when" is not one.
- **Closing:** `duplicate`, `invalid` or `wontfix`, with the reason in a comment.

The labels are defined in `.github/labels.yml`.

## Repository settings

For whoever owns the repository on GitHub:

- Issues and Discussions on (categories: Q&A, Ideas, Show and tell), and private vulnerability reporting on, which
  [SECURITY.md](SECURITY.md) relies on.
- Branch protection on `main`: a pull request, the `verify` check and a review before merging, and no force push.
- The labels of `.github/labels.yml`, and a description, topics and website for the repository.
- Dependabot alerts and secret scanning on.

To reach the maintainers, see [SUPPORT.md](SUPPORT.md).
