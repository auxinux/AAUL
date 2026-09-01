# Security Audit Report

**Date:** 2026-02-16
**Auditor:** Security review (automated + manual)
**Scope:** Full mono-repo (`/dashboard` Node.js + `/agent` Python)

---

## 1. Findings

### CRITICAL

| ID | Title | File:Line | Status |
|----|-------|-----------|--------|
| F1 | Reflected XSS on agent login page | `agent/app/lib/local_web.py:138` | **FIXED** |
| F2 | CORS `Access-Control-Allow-Origin: *` on agent web | `agent/app/lib/local_web.py:92` | **FIXED** |
| F3 | Path traversal in plugin `main` field → RCE | `dashboard/server/plugins/plugin-loader.js:261` | **FIXED** |
| F4 | TLS completely disabled with `allowSelfSigned` (`CERT_NONE`) | `agent/app/lib/security.py:69-70` | **FIXED** |

**F1 — Reflected XSS**
- Exploit: `GET /login?error=<script>alert(1)</script>` — error param rendered unescaped in HTML
- Impact: Session theft, phishing
- Fix: `html.escape()` on error parameter

**F2 — CORS wildcard**
- Exploit: Any website can `fetch()` agent APIs to extract CPU, memory, IPs, logs
- Impact: Full system info exfiltration from any browser tab
- Fix: Removed `Access-Control-Allow-Origin: *` header entirely

**F3 — Plugin main path traversal**
- Exploit: Malicious plugin with `"main": "../../../etc/cron.d/evil.js"` → arbitrary `import()`
- Impact: Remote code execution on dashboard server
- Fix: `path.resolve()` + check that resolved path stays within plugin directory

**F4 — TLS CERT_NONE**
- Exploit: Network MITM intercepts all agent↔dashboard traffic
- Impact: Token theft, malicious update injection, full agent takeover
- Fix: Changed `CERT_NONE` → `CERT_OPTIONAL` + warning log

### HIGH

| ID | Title | File:Line | Status |
|----|-------|-----------|--------|
| F5 | No security headers on agent web | `agent/app/lib/local_web.py:88-103` | **FIXED** |
| F6 | Server error details leaked to client | `agent/app/lib/local_web.py:957,970` | **FIXED** |
| F7 | ZIP symlinks not checked in plugin upload | `dashboard/server/routes/plugins.js:40-45` | **FIXED** |
| F8 | No rate limiting on agent web login | `agent/app/lib/local_web.py:362` | **FIXED** |
| F9 | `.env.example` defaults to `ALLOW_HTTP_INSTALL=true` | `dashboard/.env.example:8` | **FIXED** |
| F10 | Shell command injection in uninstall | `agent/app/lib/uninstall.py:44,52` | **FIXED** |

**F5** — Added `X-Content-Type-Options`, `X-Frame-Options`, `X-XSS-Protection`, `Content-Security-Policy`, `Cache-Control` on all responses.

**F6** — Replaced `str(e)` error messages with generic "Internal server error" / "Update failed". Detailed errors logged server-side only.

**F7** — Extended `isSafeZipEntry()` to accept full entry object and check symlink attribute bit (`attr >>> 28 === 0xA`).

**F8** — Added IP-based rate limiting: 5 attempts per 15 minutes. Clears on successful login.

**F9** — Changed default from `true` to `false` in `.env.example`.

**F10** — Replaced f-string interpolation with `shlex.quote()` for safe shell escaping.

### MEDIUM (mostly documented; some now fixed)

| ID | Title | File:Line | Status |
|----|-------|-----------|--------|
| F11 | WebSocket no origin validation | `dashboard/server/plugins/local-console/index.js:346` | **FIXED** |
| F12 | Default session secret "change-me" | `dashboard/config/config.json:4` |
| F13 | All users hardcoded `isAdmin: true` | `dashboard/server/routes/auth.js:62` | **FIXED** |
| F14 | No CSRF protection on dashboard | All POST/DELETE routes | **FIXED** |
| F15 | Agent API tokens stored plaintext in DB | `dashboard/server/db/index.js:67` |
| F16 | No bundle signature verification | `agent/app/lib/updater.py:32-46` | **FIXED** |
| F17 | `curl \| sudo sh` install pattern | `dashboard/server/routes/install.js:93` |
| F18 | Services run as root without capability restrictions | `dashboard/server/routes/install.js:128` |
| F19 | Initial admin password logged to console | `dashboard/server/db/index.js:143` |

---

## 2. Changes Applied

### `agent/app/lib/local_web.py`
- Removed `Access-Control-Allow-Origin: *` (F2)
- Added `_send_security_headers()` with CSP, X-Frame-Options, X-Content-Type-Options (F5)
- HTML-escape error parameter in login page (F1)
- Added login rate limiting: 5 attempts/15min per IP (F8)
- Replaced `str(e)` error responses with generic messages (F6)

### `agent/app/lib/security.py`
- Changed `ssl.CERT_NONE` → `ssl.CERT_OPTIONAL` for self-signed mode (F4)
- Added warning log when self-signed mode is used

### `agent/app/lib/uninstall.py`
- Replaced f-string shell interpolation with `shlex.quote()` (F10)

### `dashboard/server/plugins/plugin-loader.js`
- Added path traversal check: resolved path must stay within plugin directory (F3)

### `dashboard/server/routes/plugins.js`
- Extended `isSafeZipEntry()` to detect symlinks via ZIP header attributes (F7)
- Updated call site to pass full entry object

### `dashboard/server/plugins/local-console/index.js`
- Added Origin header validation on WebSocket upgrade (F11)

### `dashboard/.env.example`
- Changed `ALLOW_HTTP_INSTALL=true` → `false` (F9)

### Additional hardening (post-audit)
- `dashboard/server/middleware/auth.js`: Added CSRF validation on unsafe methods (`POST/PUT/PATCH/DELETE`) for session-authenticated routes.
- `dashboard/server/routes/auth.js`: Added per-session CSRF token issuance + `csrf-token` cookie; wired login/me/logout flow.
- `dashboard/server/db/index.js`: Added `users.is_admin` migration + bootstrap guarantee that at least one admin exists.
- `dashboard/server/routes/users.js`: Added RBAC role management endpoint (`PUT /api/users/:id/admin`) + protections against deleting/demoting last admin.
- `dashboard/server/routes/agents.js`, `dashboard/server/routes/admin.js`, `dashboard/server/routes/settings.js`, `dashboard/server/routes/plugins.js`: Switched sensitive routes from `requireAuth` to `requireAdmin`.
- `dashboard/server/routes/bundle.js` + `agent/app/lib/updater.py`: Added bundle integrity metadata headers (`X-Bundle-Sha256`, `X-Bundle-Signature`) and strict agent-side checksum/HMAC verification before extraction.

---

## 3. Validation

| Check | Result |
|-------|--------|
| `python3 -m py_compile agent/app/lib/local_web.py` | OK |
| `python3 -m py_compile agent/app/lib/security.py` | OK |
| `python3 -m py_compile agent/app/lib/uninstall.py` | OK |
| `node --check dashboard/server/plugins/plugin-loader.js` | OK |
| `node --check dashboard/server/routes/plugins.js` | OK |
| `node --check dashboard/server/plugins/local-console/index.js` | OK |

---

## 4. Residual Risks & Prioritized Plan

### Priority 1 — Short-term (before production)
1. **F15 — Token hashing**: Hash agent API tokens with SHA-256 before storage (like passwords)
2. **F17 — Install script**: Replace `curl|sh` with download→verify→execute pattern
3. Add audit logging for admin actions and role changes

### Priority 2 — Medium-term
1. **F18 — Least privilege**: Create dedicated `agentautoupdate` user, use `CapabilityBoundingSet` in systemd
2. **F19 — Console password**: Stop logging initial admin password; write to a secure file instead
3. **Plugin sandboxing**: Run plugins in worker threads or separate processes
4. **Audit logging**: Log all admin actions, plugin installs, config changes
5. **CI pipeline**: Add a `.github/workflows/ci.yml` running server+client install, `npm run test:security`, client build, and agent `py_compile`, with `npm audit`/`pip-audit` as informational steps

### Priority 3 — Hardening
11. Database file permissions: enforce `0600` on `.sqlite` files
12. Certificate file permissions: validate `0600` on private keys at startup
13. Add Content-Security-Policy to dashboard (currently only on agent web)
14. Persistent rate limiting (SQLite-backed instead of in-memory)
15. Session secret: persist auto-generated secret to file to survive restarts

---

## 5. Beta-readiness audit (2026-06-12)

**Scope:** dependency supply chain, boot integrity, community-release readiness.

### Fixed

| ID | Title | Detail |
|----|-------|--------|
| B1 | **Server did not boot** | `agent-api.js` imported the removed `notify()` from a refactored `notifications.js` (now `notifyEvent(type, {...})`). The Express app crashed on startup with `does not provide an export named 'notify'`. Rewired all four call sites to the typed `notifyEvent("other", { key, subject, text })` API. Verified `/health` responds. |
| B2 | **Vulnerable npm dependencies** | `npm audit fix` (non-breaking) updated `express` → 4.22.x (path-to-regexp ReDoS), `multer` → 2.1.1 (DoS), `ws` → 8.21.x. `nodemailer` bumped 6.9 → **8.0.11** (SMTP command injection / CRLF / addressparser DoS). Usage is the basic `createTransport`/`sendMail` API — verified compatible; Node ≥18 required by the installer, nodemailer 8 needs ≥6. |
| B3 | **Misleading default secrets in repo** | `config/config.json` and `.env.example` shipped `SESSION_SECRET=change-me`. Set to empty; `config.js` already auto-generates and persists a random `0600` secret. |
| B4 | **No reproducible dependency install** | `install.sh` used `npm install` (can drift to new/broken versions). Now uses **`npm ci`** (exact, audited lockfile versions) with automatic fallback to `npm install` if the lockfile is desynced or offline. Security fixes now ship with the committed lockfile — re-running `install.sh` applies them safely. |
| B5 | **No community governance** | Added `SECURITY.md`, `CODE_OF_CONDUCT.md`, and a "known limitations" section in the README. A CI workflow (server+client install, security tests, client build, agent `py_compile`) is still on the TODO list — see Priority 1 below. |

### Accepted residual risks (not exploitable in this codebase)

| Advisory | Why accepted |
|----------|--------------|
| `tar` / `cacache` / `@tootallnate/once` (high) | **Build-time only** transitive deps of `bcrypt` (node-pre-gyp) and `sqlite3` (node-gyp). Used solely to fetch/extract official prebuilt native binaries during `npm ci`; never loaded at runtime and never fed attacker-controlled archives. The fix exists only in `tar` 7.x, which is API-incompatible with `node-gyp@8`/`node-pre-gyp@1` and would break native-module compilation. Re-evaluate when `bcrypt`/`sqlite3` ship majors using `tar@7`. |
| `uuid` <11.1.1 (moderate) | Advisory affects `v3/v5/v6` when a `buf` argument is passed. The codebase only calls `uuidv4()` with no buffer → not reachable. Bumping to v11/14 is an ESM-only breaking change. |

### Validation

| Check | Result |
|-------|--------|
| Dashboard boots + `/health` 200 | OK |
| `node --check` on changed routes | OK |
| `npm run test:security` | OK (command-policy tests passed) |
| `python3 -m py_compile agent/app/lib/*.py` | OK |
| `bash -n install.sh` | OK |
