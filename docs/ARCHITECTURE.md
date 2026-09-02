# Architecture Overview

This document is the quickest way to understand how the project is split and where to start reading.

## Mental model

The repository has two runtime applications:

1. `dashboard/`
2. `agent/`

The dashboard is the control plane.
The agent is the worker installed on client machines.

There are two agent implementations behind one protocol:

- `agent/app/` — Python, for Linux and macOS
- `agent/windows/` — Go, for Windows

They are separate programs, not a shared codebase with platform branches. The
dashboard cannot tell them apart: the wire format, the command set and every
JSON payload are identical, which is the contract that keeps the split
manageable.

Communication is initiated by the agent, not by the dashboard.

## Dashboard side

Main entrypoint:

- `dashboard/server/index.js`

Important areas:

- `dashboard/server/routes/`
  Handles HTTP endpoints for authentication, agent management, install URLs, settings, plugin management, and bundle download.
- `dashboard/server/db/index.js`
  Owns SQLite initialization and lightweight schema migration.
- `dashboard/server/middleware/auth.js`
  Contains session checks, admin authorization, CSRF checks, and agent request verification.
- `dashboard/server/utils/`
  Shared server utilities such as token protection, SSL loading, base URL resolution, and SSE broadcasting.
- `dashboard/server/utils/monitor.js`
  Periodic watcher that flips agents between online and offline.
- `dashboard/server/utils/update-check.js`
  Same periodic pattern, but for the project itself: fetches `RELEASE.md` and
  reports whether a newer AAUL version has been published. Read-only — it never
  downloads or installs anything. It also parses the release notes out of that
  document, caches them to disk, and serves them per language, falling back to
  the `RELEASE.md` shipped with the installation when offline.
- `dashboard/server/cli.js`
  Local machine CLI used to operate the installed dashboard host.

The frontend lives in:

- `dashboard/client/src/`

Useful pages:

- `pages/Dashboard.jsx`
  Main fleet view and command entrypoint.
- `pages/NewAgent.jsx`
  Agent creation and installation command generation.
- `pages/AgentDetails.jsx`
  Detailed host information and per-agent settings.
- `pages/Admin.jsx`
  Dashboard host and network configuration.

## Agent side (Python — Linux, macOS)

Main entrypoints:

- `agent/app/agent_poller.py`
  Background poller that asks the dashboard for work.
- `agent/app/agent_runner.py`
  Update runner used for scheduled or immediate update execution.
- `agent/app/agent_cli.py`
  Local CLI installed on the managed machine.

Important agent libraries:

- `agent/app/lib/api.py`
  HTTP communication with the dashboard.
- `agent/app/lib/config.py`
  Runtime path handling and configuration loading.
- `agent/app/lib/package_manager.py`
  Native update commands per operating system.
- `agent/app/lib/system_info.py`
  Full inventory collection, returned on demand via FETCH_INFO.
- `agent/app/lib/metrics.py`
  Lightweight vital signs (CPU, memory, disk, load) sent on every poll.
  Deliberately separate from `system_info.py`: cheap enough for a heartbeat.
- `agent/app/lib/logs.py`
  Log listing, reading, and retention (age + total size limits).
- `agent/app/lib/systemd.py`
  Service management abstraction across Linux, macOS, and Windows.
- `agent/app/lib/updater.py`
  Self-update flow using the bundle published by the dashboard.

## Agent side (Go — Windows)

Single entrypoint:

- `agent/windows/main.go`
  Dispatches between three roles of the same binary: Windows service (started by
  the SCM), console mode (`run --console`, the debugging path), and the local
  CLI.

Important packages:

- `internal/api/`
  HTTP client. Owns the wire contract: bearer token, HMAC-SHA256 request
  signing over the exact bytes sent, and verification of the dashboard's own
  response signature. `sign_test.go` pins it against vectors produced by the
  Python agent, and an integration test (build tag `integration`) checks it
  against a running dashboard.
- `internal/poller/`
  The main loop: heartbeat, command dispatch, and the daily update window.
- `internal/commands/`
  The command set, one function per type, same result payloads as the Python
  agent's `handle_command()`.
- `internal/sysinfo/` and `internal/metrics/`
  Inventory and vital signs, read through Win32 and the registry. No
  subprocess: the Python agent spawned PowerShell on every poll just to read CPU
  usage, roughly 5 700 interpreter launches a day at a 15 s interval.
- `internal/packages/`
  winget: locating it (the `PATH` alias does not exist for LocalSystem), running
  it, and parsing its fixed-width, localised tables.
- `internal/osupdate/`
  winget upgrades plus Windows Update through its COM API. The only place the
  agent still calls PowerShell — Windows Update has no usable command line, and
  PowerShell ships with Windows.
- `internal/service/`
  Service registration, recovery actions, restart, PATH entry, self-removal.
- `internal/selfupdate/`
  Binary swap by rename. A running `.exe` cannot be overwritten on Windows but
  can be renamed, which is what makes a helper process unnecessary.

## Install flow

The public install flow is generated by:

- `dashboard/server/routes/install.js`

That route:

1. validates the one-time install token
2. loads or regenerates the agent API token when safe to do so
3. builds a platform-specific installer script
4. embeds the dashboard URL, agent ID, token, schedule, and poll interval

The generated installer then downloads either:

- `/agent/latest.tar.gz` — the Python agent bundle, or
- `/agent/windows/latest.exe` — the Go agent binary

Both are prepared by:

- `dashboard/server/routes/bundle.js`

Each response carries the artifact's SHA-256 plus an HMAC of that hash keyed
with the requesting agent's own API token, so a payload served by anything other
than this dashboard is refused before it is executed.

## Command flow

Commands are stored in the dashboard database.

Typical loop:

1. agent calls `/api/agent/poll`
2. dashboard returns the next queued command, if any
3. agent executes the command locally
4. agent reports the result to `/api/agent/command-result`

The poll response also carries configuration the agent applies without a command
round-trip: `localWeb` (local UI settings) and `logs` (retention policy). The
poll request carries `metrics` and `logStats`, which the dashboard persists on
the agent row and samples into `agent_metrics` for history.

This keeps the system simple and firewall-friendly because the dashboard never needs direct shell access to the managed host.

## Security model

There are two main trust boundaries:

- browser to dashboard
- agent to dashboard

Browser requests use:

- session cookies
- CSRF validation on unsafe methods
- admin checks where required

Agent requests use:

- bearer tokens
- token hashing in the database
- encrypted token storage
- request signing on non-GET requests
- replay protection via nonce + timestamp

## Where to start reading

If you are debugging a server problem:

1. `dashboard/server/index.js`
2. the route involved in `dashboard/server/routes/`
3. `dashboard/server/middleware/auth.js`
4. `dashboard/server/db/index.js`

If you are debugging a Linux or macOS agent problem:

1. `agent/app/agent_cli.py`
2. `agent/app/agent_poller.py`
3. `agent/app/lib/api.py`
4. `agent/app/lib/package_manager.py`
5. `agent/app/lib/system_info.py`

If you are debugging a Windows agent problem, start by running it in the
foreground — `aaul-agent run --console` prints the same log the service writes:

1. `agent/windows/main.go`
2. `agent/windows/internal/poller/`
3. `agent/windows/internal/api/`
4. `agent/windows/internal/commands/`

If you are changing the UI:

1. `dashboard/client/src/App.jsx`
2. `dashboard/client/src/components/Layout.jsx`
3. the relevant page in `dashboard/client/src/pages/`

## Design choices

The code intentionally uses:

- SQLite for simple deployment and local administration
- explicit route modules instead of heavy abstractions
- Python on the Linux and macOS agent, where an interpreter is already present
  and OS-level administration is easy to express
- Go on the Windows agent, where the interpreter had to be installed first and
  that installation was the single largest source of failures; a static binary
  removes the problem rather than working around it
- generated install scripts instead of shipping separate per-platform installers

The tradeoff is that some files are necessarily larger than ideal, especially where platform-specific install logic lives.
When touching those files, prefer small focused helpers and comments that explain why the code exists.
