import assert from "node:assert/strict";
import { validateCommandPayload } from "./command-policy.js";

assert.equal(validateCommandPayload("RUN_NOW").ok, true);
assert.equal(validateCommandPayload("RUN_NOW", { command: "rm -rf /" }).ok, false);
assert.deepEqual(validateCommandPayload("UPDATE_AGENT", { version: "0.8.0" }), {
  ok: true,
  payload: { version: "0.8.0" }
});
assert.equal(validateCommandPayload("UPDATE_AGENT", { version: "latest" }).ok, false);
assert.equal(
  validateCommandPayload("UPDATE_AGENT", { version: "0.8.0", triggeredBy: "user" }).ok,
  false
);
assert.equal(validateCommandPayload("SHELL", { command: "rm -rf /" }).ok, false);
assert.equal(validateCommandPayload("FETCH_LOG", { logName: "../../etc/passwd" }).ok, false);
assert.equal(validateCommandPayload("FETCH_LOG", { logName: "agent.log" }).ok, true);
assert.equal(validateCommandPayload("PACKAGE_INSTALL", { name: "curl" }).ok, true);
assert.equal(validateCommandPayload("PACKAGE_INSTALL", { name: "curl;rm -rf /" }).ok, false);
assert.equal(validateCommandPayload("PACKAGE_REMOVE", { name: "systemd" }).ok, false);
assert.equal(validateCommandPayload("UPDATE_PACKAGES", { names: ["curl", "git"] }).ok, true);
assert.equal(validateCommandPayload("UPDATE_PACKAGES", { names: ["curl", "../bad"] }).ok, false);
assert.equal(validateCommandPayload("ANTIVIRUS_STATUS").ok, true);
assert.equal(validateCommandPayload("ANTIVIRUS_STATUS", { scanType: "full" }).ok, false);
assert.deepEqual(validateCommandPayload("ANTIVIRUS_SCAN", { scanType: "FULL" }), {
  ok: true,
  payload: { scanType: "full" }
});
assert.equal(validateCommandPayload("ANTIVIRUS_SCAN").ok, true);
assert.equal(validateCommandPayload("ANTIVIRUS_SCAN", { scanType: "deep" }).ok, false);
assert.equal(validateCommandPayload("ANTIVIRUS_SCAN", { scanType: "quick", path: "/home/u" }).ok, true);
assert.equal(validateCommandPayload("ANTIVIRUS_SCAN", { scanType: "quick", path: "/home/../etc" }).ok, false);
assert.equal(validateCommandPayload("ANTIVIRUS_SCAN", { scanType: "quick", path: "/tmp; rm -rf /" }).ok, false);
assert.equal(validateCommandPayload("ANTIVIRUS_SCAN", { scanType: "quick", path: "relative" }).ok, false);
assert.equal(validateCommandPayload("ANTIVIRUS_ENABLE_REALTIME").ok, true);
assert.equal(validateCommandPayload("ANTIVIRUS_ENABLE_REALTIME", { enabled: false }).ok, false);
// Real-time protection can never be turned off from the dashboard. Adding such
// a command means deleting this line on purpose.
assert.equal(validateCommandPayload("ANTIVIRUS_DISABLE_REALTIME").ok, false);
assert.equal(validateCommandPayload("ANTIVIRUS_INSTALL").ok, true);
// The package list lives in the agent: a name sent from the dashboard is refused.
assert.equal(validateCommandPayload("ANTIVIRUS_INSTALL", { name: "nmap" }).ok, false);

const { checkCommandQueue, MAX_PENDING_COMMANDS } = await import("./command-queue.js");
const queueOf = (rows) => ({ all: async () => rows });
const waiting = (type, payload = null, status = "QUEUED") =>
  ({ id: `${type}-${status}`, type, status, payload_json: payload ? JSON.stringify(payload) : null });
assert.deepEqual(await checkCommandQueue(queueOf([]), "a", "RUN_NOW", null), {});
assert.equal((await checkCommandQueue(queueOf([waiting("UNINSTALL")]), "a", "FETCH_INFO", null)).status, 409);
assert.equal((await checkCommandQueue(queueOf([waiting("UNINSTALL", null, "IN_PROGRESS")]), "a", "FETCH_INFO", null)).status, 409);
assert.equal(
  (await checkCommandQueue(queueOf([waiting("ANTIVIRUS_SCAN", { scanType: "full" })]), "a", "ANTIVIRUS_SCAN", { scanType: "full" })).duplicateId,
  "ANTIVIRUS_SCAN-QUEUED"
);
// Same type, different payload: a different request, so it is queued.
assert.deepEqual(await checkCommandQueue(queueOf([waiting("ANTIVIRUS_SCAN", { scanType: "quick" })]), "a", "ANTIVIRUS_SCAN", { scanType: "full" }), {});
// The same command already RUNNING may be queued again behind itself.
assert.deepEqual(await checkCommandQueue(queueOf([waiting("FETCH_INFO", null, "IN_PROGRESS")]), "a", "FETCH_INFO", null), {});
const full = Array.from({ length: MAX_PENDING_COMMANDS }, (_, i) => ({ ...waiting("RUN_NOW"), id: `c${i}`, type: `T${i}` }));
assert.equal((await checkCommandQueue(queueOf(full), "a", "FETCH_INFO", null)).status, 409);

console.log("command-policy tests passed");
