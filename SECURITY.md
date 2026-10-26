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
- **Web pages you visit.** `app/src/proxy.ts` checks every request before its route: a request that can change something is refused when it comes from another site, and every request must name Kompl by `localhost`, an IP address, a service name or a name in `KOMPL_ALLOWED_HOSTS` (DNS rebinding). The NLP service, published on `127.0.0.1:8000`, checks the Host header the same way (`nlp-service/services/known_host.py`).
- **Fetched links.** Every redirect of a link Kompl fetches is checked before it is followed; a redirect to a private or internal address is refused.
- **Files and backups.** A staged upload must be a file in Kompl's uploads folder, and deleting a source removes only the raw file Kompl derives from its id, never a path stored in the database or a backup. A backup that unpacks to more than 1 GB or 200,000 files is refused before anything is written.
- **API key handling.** Gemini, DeepSeek, Firecrawl, and YouTube keys are stored in `.env` on disk (at least one of Gemini or DeepSeek is required for compilation). They are never logged, never sent to Kompl's own services, and excluded from `.kompl.zip` exports.
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

We only patch the latest release. Update with `kompl update` (pulls latest source, rebuilds locally-built Docker images, and restarts the stack).

## Disclaimer

Kompl is an open-source project maintained on a best-effort, volunteer basis. The maintainers make no warranties about uptime, fitness for any particular purpose, or absence of bugs and vulnerabilities. The response timelines above are aspirational, not contractual. Use at your own discretion.

See [LICENSE](LICENSE) (Apache-2.0 §7 "Disclaimer of Warranty" and §8 "Limitation of Liability") for the full legal disclaimer.
