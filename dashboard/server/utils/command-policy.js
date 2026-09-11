import { validatePackageName, validateSearchQuery } from "./packages-policy.js";
import { MIN_AGENT_POLL_SECONDS, MAX_AGENT_POLL_SECONDS } from "../config.js";

const COMMANDS_WITHOUT_PAYLOAD = new Set([
  "RUN_NOW",
  "UNINSTALL",
  "FETCH_INFO",
  "LIST_LOGS",
  "CHECK_UPDATES",
  "PACKAGES_LIST",
  "ANTIVIRUS_STATUS",
  // Turns real-time protection ON only. There is deliberately no command to
  // turn it off: that has to be done on the machine itself, so a compromised
  // dashboard account cannot strip a whole fleet of its antivirus.
  "ANTIVIRUS_ENABLE_REALTIME",
  // Installs ClamAV from a package list fixed in the agent: the dashboard never
  // sends a package name, so this cannot become a way to install anything else.
  "ANTIVIRUS_INSTALL"
]);

export const GROUP_COMMAND_TYPES = new Set([
  "RUN_NOW",
  "CHECK_UPDATES",
  "FETCH_INFO",
  "UPDATE_AGENT",
  "ANTIVIRUS_STATUS"
]);

export const RETRYABLE_COMMAND_TYPES = new Set([
  "RUN_NOW",
  "UPDATE_AGENT",
  "FETCH_INFO",
  "LIST_LOGS",
  "FETCH_LOG",
  "CHECK_UPDATES",
  "PACKAGES_LIST",
  "PACKAGE_SEARCH",
  "PACKAGE_INSTALL",
  "PACKAGE_REMOVE",
  "UPDATE_PACKAGES",
  "PRUNE_LOGS",
  "ANTIVIRUS_STATUS"
]);

function fail(error) {
  return { ok: false, error };
}

function cleanNoPayload(payload) {
  if (payload === null || payload === undefined) {
    return { ok: true, payload: null };
  }
  if (typeof payload === "object" && !Array.isArray(payload) && Object.keys(payload).length === 0) {
    return { ok: true, payload: null };
  }
  return fail("Command does not accept a payload");
}

export function validateCommandPayload(type, payload = null) {
  if (COMMANDS_WITHOUT_PAYLOAD.has(type)) {
    return cleanNoPayload(payload);
  }

  if (type === "SET_SCHEDULE") {
    const enabled = payload?.enabled;
    const dailyTime = String(payload?.dailyTime || "");
    if (typeof enabled !== "boolean" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(dailyTime)) {
      return fail("Invalid schedule payload");
    }
    return { ok: true, payload: { enabled, dailyTime } };
  }

  if (type === "UPDATE_AGENT") {
    if (payload === null || payload === undefined) {
      return { ok: true, payload: null };
    }
    if (typeof payload !== "object" || Array.isArray(payload)) {
      return fail("Invalid agent update payload");
    }
    const keys = Object.keys(payload);
    if (keys.length === 0) {
      return { ok: true, payload: null };
    }
    const version = String(payload.version || "").trim();
    if (keys.length !== 1 || keys[0] !== "version" || !/^\d+\.\d+\.\d+$/.test(version)) {
      return fail("Invalid agent update version");
    }
    return { ok: true, payload: { version } };
  }

  if (type === "SET_POLL_INTERVAL") {
    const seconds = Number.parseInt(payload?.pollIntervalSeconds, 10);
    if (
      !Number.isFinite(seconds) ||
      seconds < MIN_AGENT_POLL_SECONDS ||
      seconds > MAX_AGENT_POLL_SECONDS
    ) {
      return fail("Invalid poll interval");
    }
    return { ok: true, payload: { pollIntervalSeconds: seconds } };
  }

  if (type === "FETCH_LOG") {
    const logName = String(payload?.logName || "").trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/.test(logName)) {
      return fail("Invalid logName");
    }
    return { ok: true, payload: { logName } };
  }

  // Log retention: bounds mirror the agent's own clamping in lib/logs.py, so a
  // malformed request is rejected before a command is ever queued.
  if (type === "PRUNE_LOGS") {
    const days = Number.parseInt(payload?.retentionDays, 10);
    const maxMb = Number.parseInt(payload?.maxTotalMb, 10);
    const clean = {};
    if (Number.isFinite(days)) {
      if (days < 1 || days > 3650) {
        return fail("Invalid retentionDays (1..3650)");
      }
      clean.retentionDays = days;
    }
    if (Number.isFinite(maxMb)) {
      if (maxMb < 1 || maxMb > 100000) {
        return fail("Invalid maxTotalMb (1..100000)");
      }
      clean.maxTotalMb = maxMb;
    }
    if (Object.keys(clean).length === 0) {
      return fail("PRUNE_LOGS requires retentionDays and/or maxTotalMb");
    }
    return { ok: true, payload: clean };
  }

  // A scan is deliberately not retryable: it is expensive, and a silent replay
  // could pin a machine at full CPU for hours.
  if (type === "ANTIVIRUS_SCAN") {
    const scanType = String(payload?.scanType || "quick").trim().toLowerCase();
    if (scanType !== "quick" && scanType !== "full") {
      return fail("Invalid scanType (quick or full)");
    }
    const clean = { scanType };
    const path = payload?.path === undefined ? "" : String(payload.path).trim();
    if (path) {
      // Absolute POSIX path only, no traversal, no shell metacharacter — the
      // agent validates again before it ever reaches a command line.
      if (!/^\/[A-Za-z0-9._/-]{0,255}$/.test(path) || path.includes("..")) {
        return fail("Invalid scan path");
      }
      clean.path = path;
    }
    return { ok: true, payload: clean };
  }

  if (type === "PACKAGE_SEARCH") {
    const check = validateSearchQuery(payload?.query);
    return check.ok ? { ok: true, payload: { query: check.query } } : fail(check.error);
  }

  if (type === "PACKAGE_INSTALL" || type === "PACKAGE_REMOVE") {
    const check = validatePackageName(payload?.name);
    return check.ok ? { ok: true, payload: { name: check.name } } : fail(check.error);
  }

  if (type === "UPDATE_PACKAGES") {
    const names = Array.isArray(payload?.names) ? payload.names : [];
    if (names.length === 0 || names.length > 200) {
      return fail("Invalid package list");
    }
    const clean = [];
    for (const name of names) {
      const check = validatePackageName(name);
      if (!check.ok) {
        return fail(`${check.error}: ${name}`);
      }
      clean.push(check.name);
    }
    return { ok: true, payload: { names: clean } };
  }

  return fail("Unsupported command type");
}
