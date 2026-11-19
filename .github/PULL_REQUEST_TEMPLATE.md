## What and why

<!-- What changes in the simulator's behavior, and why. Link the issue: "Closes #123". -->

## How you checked it

<!-- The commands you ran and what they printed. For a change of the controller or the vehicle, the fingerprint before and after: `npm run sim -- --scenario pedestrian --seed 1`. -->

## Checklist

- [ ] `npm run verify` is green, and `npm run build` for a change to the app.
- [ ] The change has a test, or this description says why it cannot.
- [ ] The same seed still gives the same result, or a golden value changed and the commit says why.
- [ ] A change that a user can see has a line under `Unreleased` in `CHANGELOG.md`.
- [ ] This change touches the contract of `VERSIONING.md`:
  - [ ] No.
  - [ ] Breaking: says what and who is affected.
  - [ ] Results changed: the fingerprints before and after are above.
- [ ] Interface text is in English, Italian and Spanish.
- [ ] No secret, token or personal data in the diff. No new dependency without a discussion, and its notice is added.
- [ ] I have the right to contribute this code under the MIT License. (`Signed-off-by` on the commits is welcome, not required.)
- [ ] An AI coding agent wrote a large part of it. (Optional: it helps the review.)
