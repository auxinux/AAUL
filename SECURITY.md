# Security Policy

AAUL is fleet-management software: a dashboard can run privileged commands and
package operations on every machine where the agent is installed. Security
reports are taken seriously and handled with priority.

## Supported versions

AAUL is currently in **beta** (pre-1.0). Only the latest released version of the
dashboard and the agent receives security fixes. Please upgrade before
reporting an issue you suspect is already fixed.

| Component | Version | Supported |
|-----------|---------|-----------|
| Dashboard | latest  | ✅ |
| Agent     | latest  | ✅ |
| Anything older | — | ❌ |

## Reporting a vulnerability

**Please do not open a public GitHub issue for security problems.**

Use one of these private channels instead:

1. **GitHub Security Advisories** — preferred:
   <https://github.com/aporler/AAUL/security/advisories/new>
2. **Email** — `aporler@gmail.com` with the subject prefix `[AAUL-SECURITY]`.

Please include, as far as you can:

- the affected component (dashboard / agent) and version,
- a description of the vulnerability and its impact,
- reproduction steps or a proof of concept,
- any suggested remediation.

## What to expect

- **Acknowledgement** within 5 business days.
- **Initial assessment** (severity, affected versions) within 10 business days.
- A fix or mitigation plan communicated as soon as the assessment is complete.
- Public disclosure coordinated with you, normally after a fix is released.

## Scope

In scope: the dashboard server/API, the agent runtime, the installer scripts,
the bundle/update mechanism, and the optional agent local web interface.

Out of scope: vulnerabilities in third-party operating-system package managers,
self-inflicted misconfiguration (e.g. running the dashboard over plain HTTP on a
hostile network), and social-engineering of administrators.

## Hardening reference

See [`docs/SECURITY_AUDIT.md`](docs/SECURITY_AUDIT.md) for the current security
posture, historical findings, and accepted residual risks.
