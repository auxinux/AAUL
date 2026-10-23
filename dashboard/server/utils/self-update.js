/**
 * Dashboard update requested from the UI.
 *
 * The dashboard runs under an ordinary account and must never gain root. It
 * only drops a request file; a systemd path unit installed by install.sh sees
 * it and runs dashboard/scripts/self-update.sh as root, which fetches the
 * published version from the configured repository into a root-owned
 * directory and runs its install.sh. The request carries no parameters that
 * root would act on: the most a compromised dashboard can do is ask for the
 * published version to be installed.
 *
 * Progress is read back from a root-owned state directory. The dashboard is
 * restarted halfway through, so the browser polls through the gap.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const DASHBOARD_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

// Same paths as install.sh (install_self_update) and self-update.sh. The
// overrides exist for tests, which cannot write to /etc or /var/lib.
const CONF_FILE = process.env.AAUL_SELF_UPDATE_CONF || "/etc/aaul/self-update.conf";
const STATE_DIR = process.env.AAUL_SELF_UPDATE_STATE_DIR || "/var/lib/aaul/self-update";
const STATUS_FILE = path.join(STATE_DIR, "status.json");
const LOG_FILE = path.join(STATE_DIR, "log.txt");
const REQUEST_DIR = path.join(DASHBOARD_DIR, ".self-update");
const REQUEST_FILE = path.join(REQUEST_DIR, "request");

// A request the root side has not picked up by then means the path unit is
// not running; say so instead of showing "waiting" forever.
const PICKUP_TIMEOUT_MS = 2 * 60 * 1000;
const LOG_TAIL_LINES = 40;

/**
 * Whether this installation can update itself from the UI. Off on anything
 * install.sh did not set up for it: macOS or non-systemd hosts, dev mode, or
 * an installation that predates the feature until install.sh runs once more.
 */
export function getSelfUpdateCapability() {
  if (process.platform !== "linux") {
    return { available: false, reason: "unsupported-platform" };
  }
  if (!fs.existsSync(CONF_FILE)) {
    return { available: false, reason: "not-installed" };
  }
  try {
    fs.accessSync(REQUEST_DIR, fs.constants.W_OK);
  } catch {
    return { available: false, reason: "not-installed" };
  }
  return { available: true, reason: null };
}

function readStatusFile() {
  try {
    const parsed = JSON.parse(fs.readFileSync(STATUS_FILE, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function readLogTail() {
  try {
    const lines = fs.readFileSync(LOG_FILE, "utf8").split(/\r?\n/);
    // install.sh colours its output; the browser shows plain text.
    return lines
      .slice(-LOG_TAIL_LINES)
      .join("\n")
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b\[[0-9;]*m/g, "")
      .trim();
  } catch {
    return "";
  }
}

function requestedAt() {
  try {
    return fs.statSync(REQUEST_FILE).mtime;
  } catch {
    return null;
  }
}

/**
 * Current state, for the release-notes window.
 * state: idle | requested | stalled | running | success | up-to-date | failed
 */
export function getSelfUpdateStatus() {
  const capability = getSelfUpdateCapability();
  const status = readStatusFile();
  const pending = requestedAt();

  let state = status?.state || "idle";
  if (pending && state !== "running") {
    state = Date.now() - pending.getTime() > PICKUP_TIMEOUT_MS ? "stalled" : "requested";
  }

  return {
    ...capability,
    state,
    message: status?.message || null,
    from: status?.from || null,
    to: status?.to || null,
    startedAt: status?.startedAt || null,
    finishedAt: status?.finishedAt || null,
    exitCode: status?.exitCode ?? null,
    // The log only matters when something went wrong.
    log: state === "failed" ? readLogTail() : null
  };
}

export class SelfUpdateError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

/** Drop the request file. The root side does the rest. */
export function requestSelfUpdate({ username } = {}) {
  const capability = getSelfUpdateCapability();
  if (!capability.available) {
    throw new SelfUpdateError("Self-update is not available on this installation", "unavailable");
  }
  const current = getSelfUpdateStatus();
  if (current.state === "running" || current.state === "requested") {
    throw new SelfUpdateError("An update is already in progress", "busy");
  }
  // Informational only: the root side never reads it.
  const body = JSON.stringify({ requestedAt: new Date().toISOString(), by: username || null });
  // A stalled request is replaced, which re-arms the path unit.
  fs.rmSync(REQUEST_FILE, { force: true });
  fs.writeFileSync(REQUEST_FILE, `${body}\n`, { mode: 0o600 });
  return getSelfUpdateStatus();
}
