#!/usr/bin/env node

/**
 * Local CLI for operating the installed dashboard host.
 *
 * The dashboard is primarily managed through the web UI, but a production host
 * still needs a local escape hatch for service control, password recovery, and
 * queueing agent actions without opening the browser.
 */
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";
import readline from "readline/promises";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, "..", "..");
const dashboardRoot = path.join(rootDir, "dashboard");
const dashboardPackagePath = path.join(dashboardRoot, "package.json");
const agentVersionPath = path.join(rootDir, "agent", "app", "VERSION");
const bundledAgentVersionPath = path.join(dashboardRoot, "public", "agent", "VERSION");
const SERVICE_NAME = "agentautoupdate-dashboard";

// Keep help text close to the implementation so the CLI stays honest.
function printHelp() {
  console.log(`AAUL - Local dashboard CLI

Usage:
  AAUL -help | -h
  AAUL -status
  AAUL -version
  AAUL -reset-admin
  AAUL -start
  AAUL -stop
  AAUL -restart
  AAUL -show-url
  AAUL -show-ip
  AAUL -show-ip-public
  AAUL -agent -list
  AAUL -agent -update <AGENT_ID>
  AAUL -agent -exec <AGENT_ID>
  AAUL -agent -remove <AGENT_ID>

Examples:
  AAUL -status
  AAUL -version
  AAUL -reset-admin
  AAUL -agent -list
  AAUL -agent -update 2d5f5c33-aaaa-bbbb-cccc-1234567890ab
  AAUL -agent -exec 2d5f5c33-aaaa-bbbb-cccc-1234567890ab
  AAUL -agent -remove 2d5f5c33-aaaa-bbbb-cccc-1234567890ab
  AAUL -reset-admin -y
`);
}

function fail(message, exitCode = 1) {
  console.error(`AAUL error: ${message}`);
  process.exit(exitCode);
}

function hasYesFlag(args) {
  return args.includes("-y") || args.includes("--yes");
}

function stripYesFlags(args) {
  return args.filter((arg) => arg !== "-y" && arg !== "--yes");
}

// CLI confirmations intentionally require typing "yes" to avoid accidental destructive actions.
async function confirmAction(prompt, force) {
  if (force) {
    return true;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    fail("Confirmation required. Re-run with -y or --yes.");
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  try {
    const answer = (await rl.question(`${prompt} Type 'yes' to continue: `)).trim().toLowerCase();
    if (answer !== "yes") {
      console.log("Cancelled.");
      return false;
    }
    return true;
  } finally {
    rl.close();
  }
}

function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function readText(filePath, fallback = "") {
  try {
    return fs.readFileSync(filePath, "utf8").trim();
  } catch {
    return fallback;
  }
}

function formatCell(value, width) {
  const raw = String(value ?? "-");
  if (raw.length <= width) {
    return raw.padEnd(width, " ");
  }
  if (width <= 3) {
    return raw.slice(0, width);
  }
  return `${raw.slice(0, width - 3)}...`;
}

function formatDate(value) {
  if (!value) {
    return "-";
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toISOString();
}

function getDashboardVersion() {
  const pkg = readJson(dashboardPackagePath, {});
  return pkg?.version || "0.0.0";
}

// Prefer the built agent bundle version when available because that is what clients download.
function getAgentVersion() {
  const bundled = readText(bundledAgentVersionPath, "");
  if (bundled) {
    return bundled;
  }
  return readText(agentVersionPath, "0.0.0");
}

// We only need a compact service state string here, not the full systemctl output.
function getSystemctlValue(args, fallback = "unknown") {
  if (process.platform !== "linux") {
    return fallback;
  }
  try {
    return execFileSync("systemctl", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim() || fallback;
  } catch {
    return fallback;
  }
}

function runServiceCommand(action) {
  const isLinux = process.platform === "linux";
  if (!isLinux) {
    fail("Service control is only supported on Linux with systemd.");
  }

  const baseCommand = process.getuid && process.getuid() === 0
    ? ["systemctl", action, SERVICE_NAME]
    : ["sudo", "systemctl", action, SERVICE_NAME];

  try {
    execFileSync(baseCommand[0], baseCommand.slice(1), { stdio: "inherit" });
  } catch {
    fail(`Failed to ${action} service ${SERVICE_NAME}.`);
  }
}

function listLocalIps() {
  const interfaces = os.networkInterfaces();
  const results = [];

  for (const [name, entries] of Object.entries(interfaces)) {
    for (const entry of entries || []) {
      const family = String(entry.family);
      if (entry.internal || (family !== "IPv4" && family !== "4")) {
        continue;
      }
      results.push({ name, address: entry.address });
    }
  }

  return results;
}

async function ensureDb() {
  const runtime = await loadServerRuntime();
  await runtime.initDb();
  return runtime;
}

// Lazy imports keep simple commands such as -help or -version usable even outside a full install.
async function loadServerRuntime() {
  let dbModule;
  let settingsModule;
  let baseUrlModule;
  let configModule;
  try {
    [
      dbModule,
      settingsModule,
      baseUrlModule,
      configModule
    ] = await Promise.all([
      import("./db/index.js"),
      import("./utils/settings.js"),
      import("./utils/base-url.js"),
      import("./config.js")
    ]);
  } catch (error) {
    throw new Error(
      `Dashboard runtime is unavailable (${error?.message || "missing dependencies"}). ` +
      "Run the installed AAUL command from the server environment."
    );
  }

  const config = configModule.default;
  const runtimeDbPath = path.isAbsolute(config.dbPath || "")
    ? config.dbPath
    : path.resolve(dashboardRoot, config.dbPath || "./dashboard.sqlite");

  return {
    config,
    runtimeDbPath,
    resetPasswordPath: path.join(path.dirname(runtimeDbPath), ".admin-password-reset"),
    initDb: dbModule.initDb,
    dbOps: dbModule.dbOps,
    getSettings: settingsModule.getSettings,
    resolveBaseUrl: baseUrlModule.resolveBaseUrl
  };
}

async function resetAdmin() {
  const runtime = await ensureDb();
  const bcrypt = (await import("bcrypt")).default;
  const temporaryPassword = crypto.randomBytes(18).toString("base64url");
  const passwordHash = await bcrypt.hash(temporaryPassword, 10);
  const now = new Date().toISOString();
  const existing = await runtime.dbOps.get("SELECT id FROM users WHERE username = ?", ["admin"]);

  if (existing) {
    await runtime.dbOps.run(
      "UPDATE users SET password_hash = ?, is_admin = 1, must_change_password = 1 WHERE id = ?",
      [passwordHash, existing.id]
    );
  } else {
    await runtime.dbOps.run(
      "INSERT INTO users (username, password_hash, created_at, is_admin, must_change_password) VALUES (?, ?, ?, 1, 1)",
      ["admin", passwordHash, now]
    );
  }

  fs.writeFileSync(
    runtime.resetPasswordPath,
    [
      "# Temporary AAUL admin password",
      "username=admin",
      `password=${temporaryPassword}`,
      `generated_at=${now}`
    ].join("\n") + "\n",
    { mode: 0o600 }
  );

  console.log("Admin account reset.");
  console.log("Username : admin");
  console.log(`Password : ${temporaryPassword}`);
  console.log(`Saved to : ${runtime.resetPasswordPath}`);
  console.log("This temporary password must be changed at the next web login.");
  console.log(`If login rate-limit is active, run: AAUL -restart`);
}

async function showVersion() {
  console.log(`Dashboard : ${getDashboardVersion()}`);
  console.log(`Agent     : ${getAgentVersion()}`);
}

// The goal of -status is to summarize the host, not dump raw command output.
async function showStatus() {
  const serviceActive = getSystemctlValue(["is-active", SERVICE_NAME], "unavailable");
  const serviceEnabled = getSystemctlValue(["is-enabled", SERVICE_NAME], "unavailable");

  console.log("AAUL status");
  console.log(`Service           : ${serviceActive}`);
  console.log(`Service enabled   : ${serviceEnabled}`);
  console.log(`Dashboard version : ${getDashboardVersion()}`);
  console.log(`Agent version     : ${getAgentVersion()}`);

  const localIps = listLocalIps();
  console.log(`Local IPs         : ${localIps.length ? localIps.map((entry) => entry.address).join(", ") : "-"}`);

  try {
    const runtime = await ensureDb();
    const [settings, baseUrl, agentCount, onlineCount, pendingCount] = await Promise.all([
      runtime.getSettings(),
      runtime.resolveBaseUrl(),
      runtime.dbOps.get("SELECT COUNT(*) AS count FROM agents"),
      runtime.dbOps.get(
        "SELECT COUNT(*) AS count FROM agents WHERE last_seen_at IS NOT NULL AND datetime(last_seen_at) >= datetime('now', '-5 minutes')"
      ),
      runtime.dbOps.get(
        "SELECT COUNT(*) AS count FROM commands WHERE status IN ('QUEUED', 'IN_PROGRESS')"
      )
    ]);

    console.log(`Install URL        : ${baseUrl}`);
    console.log(`Public host        : ${settings.publicIp || "-"}`);
    console.log(`Internet base URL  : ${settings.internetBaseUrl || "-"}`);
    console.log(`Agents total       : ${agentCount?.count ?? 0}`);
    console.log(`Agents online      : ${onlineCount?.count ?? 0}`);
    console.log(`Commands pending   : ${pendingCount?.count ?? 0}`);
  } catch (error) {
    console.log(`Install URL        : unavailable (${error?.message || "runtime error"})`);
  }
}

async function showUrl() {
  const runtime = await ensureDb();
  const settings = await runtime.getSettings();
  const resolvedBaseUrl = await runtime.resolveBaseUrl();
  console.log(`Resolved install URL : ${resolvedBaseUrl}`);
  console.log(`Internet base URL    : ${settings.internetBaseUrl || "-"}`);
}

function showIp() {
  const ips = listLocalIps();
  if (!ips.length) {
    console.log("No non-loopback IPv4 address detected.");
    return;
  }

  for (const entry of ips) {
    console.log(`${entry.name} : ${entry.address}`);
  }
}

async function showPublicIp() {
  const runtime = await ensureDb();
  const settings = await runtime.getSettings();
  const candidates = [];

  if (settings.publicIp) {
    candidates.push({ source: "settings.publicIp", value: settings.publicIp });
  }
  if (settings.internetBaseUrl) {
    try {
      const url = new URL(settings.internetBaseUrl);
      candidates.push({ source: "settings.internetBaseUrl", value: url.host });
    } catch {
      // Ignore invalid persisted value here; validation happens on save.
    }
  }

  if (!candidates.length) {
    console.log("No public IP/host configured.");
    console.log("Configure publicIp or internetBaseUrl from the dashboard admin page.");
    return;
  }

  for (const candidate of candidates) {
    console.log(`${candidate.source} : ${candidate.value}`);
  }
}

async function findAgent(agentId) {
  const runtime = await ensureDb();
  const agent = await runtime.dbOps.get(
    "SELECT id, display_name, last_hostname, last_ip, last_seen_at, last_status, agent_version FROM agents WHERE id = ?",
    [agentId]
  );
  if (!agent) {
    fail(`Agent not found: ${agentId}`);
  }
  return agent;
}

async function getPendingCommand(agentId) {
  const runtime = await ensureDb();
  return runtime.dbOps.get(
    "SELECT id, type, status FROM commands WHERE agent_id = ? AND status IN ('QUEUED', 'IN_PROGRESS') ORDER BY created_at ASC LIMIT 1",
    [agentId]
  );
}

async function queueAgentCommand(agentId, type, payload = null) {
  const runtime = await ensureDb();
  const pending = await getPendingCommand(agentId);
  if (pending) {
    fail(`Agent already has a pending command (${pending.type}, ${pending.status}).`);
  }

  const commandId = crypto.randomUUID();
  const now = new Date().toISOString();
  await runtime.dbOps.run(
    "INSERT INTO commands (id, agent_id, type, payload_json, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'QUEUED', ?, ?)",
    [commandId, agentId, type, payload ? JSON.stringify(payload) : null, now, now]
  );
  console.log(`Queued ${type} for agent ${agentId}`);
  console.log(`Command ID: ${commandId}`);
}

// Keep the list readable in a terminal instead of returning raw JSON.
async function listAgents() {
  const runtime = await ensureDb();
  const agents = await runtime.dbOps.all(
    "SELECT id, display_name, last_hostname, last_ip, last_seen_at, last_status, agent_version FROM agents ORDER BY created_at DESC"
  );

  if (!agents.length) {
    console.log("No agents registered.");
    return;
  }

  const columns = [
    ["ID", 36],
    ["NAME", 20],
    ["HOST", 20],
    ["IP", 15],
    ["STATUS", 12],
    ["VERSION", 10],
    ["LAST_SEEN", 24]
  ];

  console.log(columns.map(([label, width]) => formatCell(label, width)).join(" "));
  console.log(columns.map(([, width]) => "-".repeat(width)).join(" "));

  for (const agent of agents) {
    console.log([
      formatCell(agent.id, 36),
      formatCell(agent.display_name, 20),
      formatCell(agent.last_hostname, 20),
      formatCell(agent.last_ip, 15),
      formatCell(agent.last_status, 12),
      formatCell(agent.agent_version, 10),
      formatCell(formatDate(agent.last_seen_at), 24)
    ].join(" "));
  }
}

async function updateAgent(agentId) {
  await ensureDb();
  await findAgent(agentId);
  await queueAgentCommand(agentId, "UPDATE_AGENT", null);
}

async function execAgent(agentId) {
  await ensureDb();
  await findAgent(agentId);
  await queueAgentCommand(agentId, "RUN_NOW", null);
}

async function removeAgent(agentId) {
  const runtime = await ensureDb();
  const agent = await findAgent(agentId);
  await runtime.dbOps.run("DELETE FROM commands WHERE agent_id = ?", [agentId]);
  await runtime.dbOps.run("DELETE FROM agents WHERE id = ?", [agentId]);
  console.log(`Removed agent ${agent.id} (${agent.display_name || "-"}) from the dashboard.`);
}

async function handleAgentCommand(args) {
  const force = hasYesFlag(args);
  const filteredArgs = stripYesFlags(args);

  if (!filteredArgs.length || filteredArgs.includes("-help") || filteredArgs.includes("-h")) {
    console.log(`AAUL -agent commands:
  AAUL -agent -list
  AAUL -agent -update <AGENT_ID>
  AAUL -agent -exec <AGENT_ID>
  AAUL -agent -remove <AGENT_ID>`);
    return;
  }

  if (filteredArgs[0] === "-list") {
    await listAgents();
    return;
  }

  if (filteredArgs[0] === "-update") {
    if (!filteredArgs[1]) {
      fail("Missing AGENT_ID for -agent -update.");
    }
    await updateAgent(filteredArgs[1]);
    return;
  }

  if (filteredArgs[0] === "-exec") {
    if (!filteredArgs[1]) {
      fail("Missing AGENT_ID for -agent -exec.");
    }
    await execAgent(filteredArgs[1]);
    return;
  }

  if (filteredArgs[0] === "-remove") {
    if (!filteredArgs[1]) {
      fail("Missing AGENT_ID for -agent -remove.");
    }
    const agent = await findAgent(filteredArgs[1]);
    const confirmed = await confirmAction(
      `Remove agent '${agent.display_name || agent.id}' (${agent.id}) from the dashboard? This deletes the agent record and its queued command history.`,
      force
    );
    if (!confirmed) {
      return;
    }
    await removeAgent(filteredArgs[1]);
    return;
  }

  fail(`Unknown agent option: ${filteredArgs[0]}`);
}

async function main() {
  const args = process.argv.slice(2);
  if (!args.length || args.includes("-help") || args.includes("-h")) {
    printHelp();
    return;
  }

  if (args[0] === "-version") {
    await showVersion();
    return;
  }

  if (args[0] === "-status") {
    await showStatus();
    return;
  }

  if (args[0] === "-reset-admin") {
    const force = hasYesFlag(args.slice(1));
    const confirmed = await confirmAction(
      "Reset the admin account and generate a new temporary password?",
      force
    );
    if (!confirmed) {
      return;
    }
    await resetAdmin();
    return;
  }

  if (args[0] === "-start") {
    runServiceCommand("start");
    return;
  }

  if (args[0] === "-stop") {
    runServiceCommand("stop");
    return;
  }

  if (args[0] === "-restart") {
    runServiceCommand("restart");
    return;
  }

  if (args[0] === "-show-url") {
    await showUrl();
    return;
  }

  if (args[0] === "-show-ip") {
    showIp();
    return;
  }

  if (args[0] === "-show-ip-public") {
    await showPublicIp();
    return;
  }

  if (args[0] === "-agent") {
    await handleAgentCommand(args.slice(1));
    return;
  }

  fail(`Unknown option: ${args[0]}`);
}

main().catch((error) => {
  fail(error?.message || "Unexpected CLI failure.");
});
