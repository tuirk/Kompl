# Security Policy

## Reporting a Vulnerability

**Do not open a public GitHub issue for security vulnerabilities.**

Report privately via [GitHub Security Advisories](https://github.com/tuirk/Kompl/security/advisories/new). Both maintainers are notified automatically; the report is only visible to you and us.

Include:
- Description of the vulnerability
- Steps to reproduce
- Impact assessment (what an attacker could do)

## Response

- Acknowledge within 48 hours
- Patch critical issues within 7 days; high-severity within 30 days; lower severity within 90 days
- Credit the reporter in the release notes (unless they prefer anonymity)

## Scope

Kompl runs locally on your machine. The attack surface is:

- **Local network exposure.** Kompl binds to `localhost:3000` by default. If you expose it to your network or the internet, you are responsible for adding authentication — Kompl has none.
- **API key handling.** Gemini and Firecrawl keys are stored in `.env` on disk. They are never logged, never sent to Kompl's own services, and excluded from `.kompl.zip` exports.
- **Docker container isolation.** Kompl's containers run with default Docker security. No `--privileged`, no host network mode, no volume mounts outside the project directory.
- **n8n webhooks.** Internal webhooks between services are unauthenticated. This is safe when running locally. If exposed to the internet, n8n's webhook endpoints could be triggered by anyone.

## What Kompl Does NOT Do

- No telemetry, analytics, or error reporting
- No outbound connections except those documented in the README ("Your data" section)
- No user accounts or authentication (single-tenant by design)
- No data stored outside Docker volumes on your machine

## Supported Versions

| Version | Supported |
|---------|-----------|
| Latest  | ✅        |
| Older   | ❌        |

We only patch the latest release. Update with `kompl update`.

## Disclaimer

Kompl is an open-source project maintained on a best-effort, volunteer basis. The maintainers make no warranties about uptime, fitness for any particular purpose, or absence of bugs and vulnerabilities. The response timelines above are aspirational, not contractual. Use at your own discretion.

See [LICENSE](LICENSE) (Apache-2.0 §7 "Disclaimer of Warranty" and §8 "Limitation of Liability") for the full legal disclaimer.
