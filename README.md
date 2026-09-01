# Agent Auto Update Linux

Ce projet est Québecois et donc généralement programmer en Francais mais pour el rendre plus universel ici c'est en Anglais mais en bas vous aurez des lien vers le projet Auxnix et sont Wiki est en Francais

Agent Auto Update Linux, or `AAUL`, is a small fleet management project built around two parts:

- `dashboard/`: the server-side dashboard and API used by administrators
- `agent/`: the client-side agent installed on managed machines

The original project name says "Linux", but the current codebase also supports macOS and Windows for agent installation and update flows.

The dashboard is responsive: it is usable from a phone or tablet, not only from a desktop browser.

## What the project does

AAUL lets you register a machine in the dashboard, generate a one-time installer URL, and let the agent poll the dashboard for work.

The dashboard can:

- register agents and generate installation commands
- queue commands such as `RUN_NOW`, `SET_SCHEDULE`, `UPDATE_AGENT`, `UNINSTALL`
- display machine state, package information, logs, and last-seen activity
- show live CPU / memory / disk usage per host, with 24-hour history
- aggregate pending updates across the whole fleet and flag the security ones
- push a log-retention policy that every agent enforces locally
- build and serve the latest agent bundle used for agent self-update

The agent can:

- install on Debian/Ubuntu, Fedora/RHEL, Arch Linux, macOS, and Windows 11
- report local system information back to the dashboard
- report lightweight vital signs (CPU, memory, disk, load) on every check-in
- apply operating system updates using the native package manager
- report which pending updates come from a security channel
- prune its own log directory according to the dashboard's retention policy
- update itself from the bundle exposed by the dashboard
- run as a background service on each supported platform

## Repository layout

```text
agent/
  app/                    Python agent runtime
  app/lib/metrics.py      Vital signs collected on every check-in
  app/lib/logs.py         Log listing, reading and retention
  systemd/                Linux service templates

dashboard/
  client/                 React + Vite frontend
  server/                 Express API and server-side logic
  public/agent/           Built agent bundle served to clients
  config/config.json      Static dashboard configuration

docs/
  ARCHITECTURE.md         High-level codebase tour
  SECURITY_AUDIT.md       Security notes and historical findings

install.sh                Production installer / updater for the dashboard
AAUL                      Local wrapper for the dashboard CLI during development
```

## How it works

1. An administrator creates an agent entry from the dashboard.
2. The dashboard stores an install token and an agent API token.
3. The generated `/install?token=...` URL returns a platform-specific installer script.
4. The installer downloads the latest agent bundle from `/agent/latest.tar.gz`.
5. The installed agent polls `/api/agent/poll` and executes queued commands.
6. The agent reports results to `/api/agent/command-result`.

The agent never needs inbound access from the dashboard. The communication model is poll-based.

## Supported platforms

Agent package updates are implemented for:

- Debian and derivatives through `apt`
- Fedora / RHEL families through `dnf` or `yum`
- Arch Linux and derivatives through `pacman`
- macOS through `softwareupdate`, plus Homebrew when present
- Windows 11 through `winget` and Windows Update APIs

Service management is implemented through:

- `systemd` on Linux
- `launchd` on macOS
- Task Scheduler on Windows

## Development

Install dashboard dependencies:

```bash
cd dashboard
npm install
npm --prefix client install
```

Run the server:

```bash
cd dashboard
npm run dev:server
```

Run the frontend:

```bash
cd dashboard
npm run dev:client
```

Or run both:

```bash
cd dashboard
npm run dev:all
```

Build the agent bundle used by `/install` and agent self-update:

```bash
bash dashboard/scripts/build-agent-bundle.sh
```

## Production install / update

The intended production entrypoint is `install.sh`.

Fresh install or upgrade:

```bash
sudo ./install.sh
```

The installer:

- copies the project to `/opt/AAUL`
- verifies that the native modules (`sqlite3`, `bcrypt`) actually load, and
  rebuilds them if npm blocked their install scripts
- preserves runtime data during upgrades
- installs Node.js dependencies
- builds the frontend
- builds the agent bundle
- installs the `agentautoupdate-dashboard` systemd service
- installs the local `AAUL` CLI on the host

## Using an installed agent

Once an agent is installed on a machine it is managed locally by a background service and by the dashboard. The quickest way to see the agent state from the host is the local CLI.

### Agent CLI commands

The agent CLI is available as `agentautoupdate` (or `agentautoupdate.exe` on Windows). On Linux and macOS it is installed under `/usr/local/bin/agentautoupdate`.

```bash
# Show installed version and local config
agentautoupdate version
agentautoupdate status

# Send a heartbeat to the dashboard without running a command
agentautoupdate check-in

# Run operating-system updates immediately
sudo agentautoupdate update

# Update the agent itself from the dashboard bundle
sudo agentautoupdate update-agent

# Read the most recent agent log
agentautoupdate logs
agentautoupdate logs --tail 50

# Point the agent at a different dashboard address or host
sudo agentautoupdate config set-dashboard 192.168.1.10
sudo agentautoupdate config set-dashboard https://dashboard.example.com:3002

# Remove the agent from this machine
sudo agentautoupdate uninstall
```

> The dashboard URL stored in `/opt/agentautoupdate/config.json` (Linux) or `/Library/Application Support/AgentAutoUpdate/config.json` (macOS) must be reachable by the agent. If the dashboard moves to a new host or port, use `config set-dashboard` on the agent.

### Service control

The background poller is what keeps the agent talking to the dashboard.

| Platform | Service / task | Useful commands |
|----------|----------------|-----------------|
| Linux (systemd) | `agentautoupdate.service` | `sudo systemctl status agentautoupdate.service`, `sudo systemctl restart agentautoupdate.service` |
| macOS (launchd) | `com.agentautoupdate.poller` | `sudo launchctl print system/com.agentautoupdate.poller`, `sudo launchctl kickstart -k system/com.agentautoupdate.poller` |
| Windows | Task Scheduler `AgentAutoUpdate Poller` | `schtasks /Query /TN "AgentAutoUpdate Poller"`, `schtasks /Run /TN "AgentAutoUpdate Poller"` |

### When an agent stops talking to the dashboard

The dashboard shows an agent as offline when it has not received a poll for more than a few minutes. The machine can be powered on and healthy while the agent itself is unable to reach the dashboard. Here is the usual diagnostic order:

1. **Check the agent service on the machine**
   - Linux: `sudo systemctl status agentautoupdate.service --no-pager`
   - macOS: `sudo launchctl print system/com.agentautoupdate.poller`
   - Windows: `schtasks /Query /TN "AgentAutoUpdate Poller" /FO LIST`

   If the service is stopped, start or restart it. A freshly installed agent that has never connected will usually show an error here first.

2. **Read the agent log**

   ```bash
   agentautoupdate logs --tail 100
   ```

   Common log errors:
   - `Connection Error: ... Is the dashboard running?` — the agent cannot reach the dashboard URL.
   - `SSL Error: ... Check certificate configuration.` — TLS mismatch, expired certificate, or self-signed certificate not allowed.
   - `HTTP 401: Invalid token` or `Invalid request signature` — the agent API token is wrong, rotated, or the agent clock is off.
   - `Missing response signature` — the agent expects signed dashboard responses but the dashboard did not sign them.

3. **Verify network reachability from the agent machine**

   ```bash
   # Linux / macOS
   curl -v https://<dashboard-host>:<port>/health
   # or, if the dashboard is HTTP
   curl -v http://<dashboard-host>:<port>/health
   ```

   If this fails, the problem is network or firewall related, not AAUL related. Check DNS, routing, firewalls, and reverse-proxy rules.

4. **Check the dashboard URL configured on the agent**

   ```bash
   agentautoupdate status | grep dashboardUrl
   sudo agentautoupdate config show
   ```

   If the dashboard was moved behind HTTPS, a new public IP, or a different port, update it:

   ```bash
   sudo agentautoupdate config set-dashboard https://<new-host>:3002
   ```

   Then restart the poller service.

5. **Check TLS / HTTPS settings**

   The agent stores TLS policy in `security.json` next to `config.json`:

   ```json
   {
     "verifyTls": true,
     "allowSelfSigned": false,
     "signRequests": true
   }
   ```

   - If the dashboard uses a self-signed certificate, set `allowSelfSigned: true` (development only) or, better, install the CA on the agent machine.
   - If HTTPS was disabled on the dashboard but the agent still points at `https://...`, the connection will fail.
   - The dashboard's `dashboard/config/config.json` defines `defaultApiProtocol`. Make sure the install URL matches the protocol the agent actually uses.

6. **Verify the agent API token**

   The token lives in `config.json` as `agentApiToken`. If you regenerated or reinstalled the agent entry in the dashboard, the old token becomes invalid. The fastest fix is to reinstall the agent with a fresh install token, or to update `agentApiToken` in the agent's `config.json` to match the value shown in the dashboard for that agent.

7. **Check clock skew**

   Request signatures have a five-minute validity window. Run `date -u` on the agent and on the dashboard host. If they differ by more than a couple of minutes, signing will fail and the dashboard will return 401.

8. **Force a manual check-in**

   ```bash
   agentautoupdate check-in
   ```

   If this succeeds, the service restart above likely fixed it. If it fails, the error printed here is the real cause.

### What the dashboard "online" status really means

The agent is poll-based: it calls `/api/agent/poll` at `pollIntervalSeconds` (default every 15–60 seconds). The dashboard marks an agent online when `last_seen_at` is within the last ~5 minutes. There is no persistent connection, so if an agent stops polling, check the agent side first — the dashboard cannot initiate contact.

### Agent file locations

| Platform | Runtime directory | Config file | Logs |
|----------|-------------------|-------------|------|
| Linux | `/opt/agentautoupdate` | `config.json` | `logs/agent-YYYY-MM-DD.log` |
| macOS | `/Library/Application Support/AgentAutoUpdate` | `config.json` | `logs/agent-YYYY-MM-DD.log` |
| Windows | `C:\ProgramData\AgentAutoUpdate` | `config.json` | `logs\agent-YYYY-MM-DD.log` |

## Dashboard CLI

After a production install, the host gets an `AAUL` command for local administration.

Examples:

```bash
AAUL -status
AAUL -version
AAUL -reset-admin
AAUL -agent -list
AAUL -agent -update <AGENT_ID>
AAUL -agent -exec <AGENT_ID>
AAUL -agent -remove <AGENT_ID>
```

## Fleet packages and security updates

`Packages -> See the whole fleet` aggregates every machine's pending updates into
one list. For each package you get the number of hosts affected and whether the
update comes from a security channel, so the page answers the two questions that
actually drive patching: *what must I fix* and *how much of my fleet does it
touch*.

Security detection is per-platform and best effort:

| Platform | Source of the security flag |
|----------|-----------------------------|
| Debian / Ubuntu | the suite in `apt list --upgradable` (`<codename>-security`), cross-checked against `apt-get -s dist-upgrade` |
| Fedora / RHEL | `dnf updateinfo list security` |
| openSUSE | `zypper list-patches --category security` |
| Arch, macOS, Windows | not available — these publish no per-package security metadata, so updates are reported as regular ones rather than guessed |

A package is flagged as security-relevant as soon as **one** host reports it from
a security channel: the same version can sit in `-security` on one distro release
and in plain `-updates` on another, and under-reporting a security fix is the
costlier mistake.

Use `Security only` to reduce the list, or `Patch security updates` to queue just
those updates on every affected machine. Bulk updates still require the per-agent
package-management opt-in; agents without it are skipped.

## Host metrics

Every poll carries a small set of vital signs (CPU, load average, memory, swap,
root filesystem **and the fullest mounted filesystem**, process and session
counts). This is deliberately separate from the full inventory
(`collect_system_info()`), which is expensive and still runs only on demand.

- Fleet cards and the fleet-health panel show current usage at a glance.
- The agent page adds 24-hour sparklines.
- A host is listed as "under pressure" above 90% CPU, 90% memory or 85% disk.
  Disk pressure uses the fullest volume, not `/`: a machine can look healthy on
  `/` while `/var` is the one about to fill up.

History is sampled once per host every 5 minutes (not once per poll, which would
add thousands of rows a day without adding visible detail) and pruned according
to `Admin -> Metric history retention`, 30 days by default.

Agents older than 0.9.0 simply report no metrics; the dashboard shows "no metrics
reported yet" rather than a misleading 0%.

## Log collection and retention

Agents write one log file per day. Nothing used to delete them, so a long-lived
machine accumulated hundreds of files.

Retention is configured centrally in `Logs -> Log retention` and pushed to every
agent on its next check-in. Each agent then enforces it locally, at most once an
hour:

1. delete logs older than the age limit;
2. delete the oldest remaining logs until the total fits the size limit.

Defaults are 30 days or 200 MB, whichever comes first. Two safety rules are
hardcoded in the agent and cannot be overridden from the dashboard: the **current
day's log is never deleted**, and only files the agent itself produced
(`agent-YYYY-MM-DD.log`) are ever eligible for removal.

`Clean up now` applies the policy to one host immediately, which is what you want
when a disk is filling up. The log viewer supports search, level highlighting
(errors, warnings, success), line wrapping and download.

## Beta status & known limitations

AAUL is currently released as a **public beta** (pre-1.0). It is usable and has
been through a security review, but a few things are worth knowing before you
deploy it on a fleet you care about:

- **Versioning.** For as long as the project is in beta, both the dashboard and
  the agent stay on `0.x.x` — pre-1.0 in the semver sense, meaning the API and
  behavior may still change between releases. `1.0.0` is reserved for the first
  stable release. Note that the agent auto-update compares version *strings*,
  not version *order*: any change to the agent version (in either direction)
  triggers an update on the next poll.

- **Metrics and log retention need agent 0.9.0+.** Older agents keep working
  normally, but report no vital signs and do not prune their own logs. Push
  `UPDATE_AGENT` to the fleet to enable both.

- **Security flags depend on the package manager.** Arch, macOS and Windows
  expose no per-package security metadata, so their updates are never marked as
  security updates. Absence of the flag on those platforms means "unknown", not
  "safe".

- **Run it over HTTPS.** Agent tokens and admin sessions travel over the wire.
  Enable HTTPS (or put the dashboard behind a TLS-terminating reverse proxy)
  before exposing it beyond localhost. Plain-HTTP install is disabled by default.
- **The dashboard runs privileged commands on agents.** Treat admin accounts as
  highly sensitive. The default admin password is generated at first launch and
  written to `.initial-admin-password` (mode `0600`) next to the database —
  change it immediately and delete that file.
- **Agent services run as root.** This is inherent to OS package management.
  Only install the agent on machines you administer.
- **The optional agent local web UI binds to all interfaces** and is reachable
  on the LAN when enabled. It is **off by default**, requires PAM/system-user
  authentication, and is rate-limited — enable it only on trusted networks, and
  prefer HTTPS for it too.
- **Plugins run in the dashboard process.** Install only plugins you trust.
- **Native modules must build.** The dashboard depends on `sqlite3` and
  `bcrypt`, which ship compiled binaries. Recent npm versions block dependency
  install scripts by default (`install scripts blocked because they are not
  covered by allowScripts`), in which case `npm ci` succeeds but the binary is
  never fetched and the server dies at boot with *Could not locate the bindings
  file*. `install.sh` now detects this, rebuilds the modules, and aborts with
  instructions rather than restarting a service that cannot start. If you
  install dependencies by hand, verify with:

  ```bash
  cd /opt/AAUL/dashboard
  node -e "require('sqlite3'); require('bcrypt')"   # must print nothing
  ```

- A few remaining `npm audit` advisories are **build-time-only** transitive
  dependencies of native modules (`tar`/`cacache` via `node-gyp`/`node-pre-gyp`)
  and are not reachable at runtime. See `docs/SECURITY_AUDIT.md`.

Found a security issue? See [SECURITY.md](SECURITY.md) — please report privately.

## Documentation

Current entry points:

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- [docs/SECURITY_AUDIT.md](docs/SECURITY_AUDIT.md)
- [SECURITY.md](SECURITY.md) — vulnerability reporting policy
- [CONTRIBUTING.md](CONTRIBUTING.md)
- [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)

The older `docs/wiki/` pages were removed from this public tree because they no longer matched the current codebase.

## Notes for contributors

This repository is meant to stay readable by contributors who are new to the project.

The code should prefer:

- explicit names over short names
- small helpers over repeated inline logic
- comments that explain intent, not syntax
- platform-specific code that is isolated instead of hidden in conditionals everywhere

See [CONTRIBUTING.md](CONTRIBUTING.md) for the maintainer-facing conventions used in this repository.

## Links

- Git: [git.auxinux.ca/aporler/AAUL](https://git.auxinux.ca/aporler/AAUL)
- Project page: [aaul.auxinux.ca](https://aaul.auxinux.ca)
- Auxinux wiki: [auxinux.ca/projets/projet-aaul](https://auxinux.ca/projets/projet-aaul?tab=wiki)

## License

MIT — Copyright (c) 2026 André Porlier — Projet Auxinux
