# Contributing to Hound

Hound is intentionally scoped to one local authorization-regression workflow. Changes should strengthen that workflow, make its evidence easier to assess, or improve the documented application-adapter boundary. Please discuss broad new vulnerability classes, hosted infrastructure, or arbitrary internet targets before implementing them.

## Local setup

Use Node.js 22 or later, npm, Docker with Compose, and a macOS or Linux shell.

```sh
npm ci
npm run setup:browser
npm run typecheck
npm test
npm run test:browser
./hound control up
npm run test:control
```

The browser and control-plane suites use fresh loopback-only services. They need no provider credential. Run `./hound demo` to validate the complete credential-free workflow; it takes several minutes because minimization repeatedly creates fresh baseline and candidate fixtures.

## Evidence and safety

- Test only the included developer-owned fixture unless an application adapter explicitly establishes authorization and isolation for another target.
- Keep credentials, cookies, raw provider bodies, `.hound/`, reports, and browser test output out of Git.
- Label authored provider sequences as simulated. Do not describe them as autonomous discovery evidence.
- Treat nondetection as inconclusive coverage, never as proof that an application is secure.
- Keep model calls behind an explicit local API key and dollar budget. No test or CI workflow may require a model credential.

## Pull requests

Keep commits focused and explain the behavior being changed. A pull request should state why the change is needed, what it changes, how it was validated, and any limits on the evidence. Update the CLI help and relevant docs when behavior changes.
