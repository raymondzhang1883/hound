# Security policy

## Supported scope

Security fixes are applied to the latest commit on `main`. Hound is a local research and developer tool; it is not supported as a public service or for scanning systems without explicit authorization.

The included Fieldnotes candidate is intentionally vulnerable. A report that only reproduces the documented stale-session write in that seeded fixture is expected behavior rather than a new Hound vulnerability.

## Reporting a vulnerability

Please use the repository's **Security** tab and select **Report a vulnerability** to open a private GitHub security advisory. Include the affected revision, impact, reproduction steps, and any suggested mitigation. Do not include real credentials or third-party data.

Please avoid filing a public issue for an unreleased vulnerability. You can expect an initial acknowledgment within seven days. This is a personal project, so remediation timelines depend on severity and maintainer availability.

## Safe research boundary

Use Hound only on applications and accounts you own or are explicitly authorized to test. Keep the control plane, fixtures, and harness listeners on loopback. Never use real user data in the included fixture.
