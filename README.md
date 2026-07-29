# Agent Auto Update Linux

Ce projet est Québecois et donc généralement programmer en Francais mais pour el rendre plus universel ici c'est en Anglais mais en bas vous aurez des lien vers le projet Auxnix et sont Wiki est en Francais

Agent Auto Update Linux, or `AAUL`, is a small fleet management project built around two parts:

- `dashboard/`: the server-side dashboard and API used by administrators
- `agent/`: the client-side agent installed on managed machines

The original project name says "Linux", but the current codebase also supports macOS and Windows for agent installation and update flows.

## What the project does

AAUL lets you register a machine in the dashboard, generate a one-time installer URL, and let the agent poll the dashboard for work.

The dashboard can:

- register agents and generate installation commands
- queue commands such as `RUN_NOW`, `SET_SCHEDULE`, `UPDATE_AGENT`, `UNINSTALL`
- display machine state, package information, logs, and last-seen activity
- build and serve the latest agent bundle used for agent self-update

The agent can:

- install on Debian/Ubuntu, Fedora/RHEL, Arch Linux, macOS, and Windows 11
- report local system information back to the dashboard
- apply operating system updates using the native package manager
- update itself from the bundle exposed by the dashboard
- run as a background service on each supported platform

## Repository layout

```text
agent/
  app/                    Python agent runtime
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
