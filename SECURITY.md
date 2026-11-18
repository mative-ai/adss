# Security policy

## Reporting a vulnerability

Please report a vulnerability privately, through GitHub's private vulnerability reporting: open the **Security** tab of
the repository and choose **Report a vulnerability**. Do not open a public issue for it.

Say what you found, where, and how to reproduce it. Mative reads every report and answers it.

## What the simulator exposes

The simulator is a static site. Everything in its bundle is readable by anyone, so none of it is a secret. It receives
no personal data, sets no cookies and calls no other system. The access token of [ADR 0003](docs/adr/0003-token-ed25519.md)
is verified in the browser with a public key; the signing key never leaves Mative's own servers.

## In scope

- The build and the files in `deploy/`: headers, Content-Security-Policy, caching.
- The verification of the access token.
- The dependencies the bundle contains.
- Anything that lets one visitor affect another.

## Out of scope

- How closely the physics or the controller model a real vehicle. The simulator is educational: its limits are stated
  in the product, and a more accurate model is a feature request, not a vulnerability.
- A report that needs a browser extension, a modified browser or access to the visitor's device.

## Supported versions

Only the latest published snapshot of the repository is supported.
