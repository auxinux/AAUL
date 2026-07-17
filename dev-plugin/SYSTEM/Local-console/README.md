# Local Console Plugin

Real interactive terminal (PTY) for the dashboard host, admin-only.

## Access
- URL: `/local-console`
- Requires an admin session.
- The terminal connects over a WebSocket, authenticated with a short-lived
  one-time token and restricted to same-origin requests.

## Notes
- The shell runs on the same host as the dashboard server, with the same
  privileges as the server process.
- Only one shell session is spawned per WebSocket connection; closing the
  tab or the connection kills the underlying process.
- Intended for trusted administrators only — treat it like SSH access to
  the host.
