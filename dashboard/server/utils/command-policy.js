import { validatePackageName, validateSearchQuery } from "./packages-policy.js";

const COMMANDS_WITHOUT_PAYLOAD = new Set([
  "RUN_NOW",
  "UNINSTALL",
  "FETCH_INFO",
  "LIST_LOGS",
  "CHECK_UPDATES",
  "PACKAGES_LIST"
]);

export const GROUP_COMMAND_TYPES = new Set([
  "RUN_NOW",
  "CHECK_UPDATES",
  "FETCH_INFO",
  "UPDATE_AGENT"
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
  "UPDATE_PACKAGES"
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
    if (!Number.isFinite(seconds) || seconds < 5 || seconds > 86400) {
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
