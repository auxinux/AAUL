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

console.log("command-policy tests passed");
