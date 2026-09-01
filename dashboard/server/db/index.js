import sqlite3 from "sqlite3";
import bcrypt from "bcrypt";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import config from "../config.js";
import { protectToken } from "../utils/tokens.js";

sqlite3.verbose();

let db;

export function getDb() {
  if (!db) {
    db = new sqlite3.Database(config.dbPath);
  }
  return db;
}

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    getDb().run(sql, params, function onRun(err) {
      if (err) {
        reject(err);
        return;
      }
      resolve(this);
    });
  });
}

function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    getDb().get(sql, params, (err, row) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(row);
    });
  });
}

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    getDb().all(sql, params, (err, rows) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(rows);
    });
  });
}

function resolveRuntimePath(targetPath) {
  if (path.isAbsolute(targetPath)) {
    return targetPath;
  }
  return path.resolve(process.cwd(), targetPath);
}

function bestEffortChmod(filePath, mode) {
  try {
    if (fs.existsSync(filePath)) {
      fs.chmodSync(filePath, mode);
    }
  } catch {
    // Best effort only
  }
}

function writeBootstrapAdminFile(password, createdAt) {
  const resolvedDbPath = resolveRuntimePath(config.dbPath);
  const outputPath = path.join(path.dirname(resolvedDbPath), ".initial-admin-password");
  const payload = [
    "# Initial dashboard admin credentials",
    "username=admin",
    `password=${password}`,
    `created_at=${createdAt}`
  ].join("\n");
  fs.writeFileSync(outputPath, `${payload}\n`, { mode: 0o600 });
  bestEffortChmod(outputPath, 0o600);
  console.warn(`[SECURITY] Initial admin credentials written to ${outputPath}`);
}

export async function initDb() {
  await run(
    `CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE,
      password_hash TEXT,
      created_at TEXT,
      is_admin INTEGER DEFAULT 0
    )`
  );

  const userColumns = await all("PRAGMA table_info(users)");
  const userColumnNames = new Set(userColumns.map((col) => col.name));
  if (!userColumnNames.has("is_admin")) {
    await run("ALTER TABLE users ADD COLUMN is_admin INTEGER DEFAULT 0");
  }
  if (!userColumnNames.has("must_change_password")) {
    await run("ALTER TABLE users ADD COLUMN must_change_password INTEGER DEFAULT 0");
  }

  await run(
    `CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      display_name TEXT,
      install_token TEXT UNIQUE,
      agent_api_token TEXT UNIQUE,
      last_hostname TEXT,
      last_ip TEXT,
      last_seen_at TEXT,
      last_run_at TEXT,
      last_status TEXT,
      last_exit_code INTEGER,
      last_duration_seconds INTEGER,
      schedule_enabled INTEGER,
      schedule_daily_time TEXT,
      agent_version TEXT,
      created_at TEXT
    )`
  );

  const agentColumns = await all("PRAGMA table_info(agents)");
  const agentColumnNames = new Set(agentColumns.map((col) => col.name));
  if (!agentColumnNames.has("install_token_hash")) {
    await run("ALTER TABLE agents ADD COLUMN install_token_hash TEXT");
  }
  if (!agentColumnNames.has("install_token_enc")) {
    await run("ALTER TABLE agents ADD COLUMN install_token_enc TEXT");
  }
  if (!agentColumnNames.has("agent_api_token_hash")) {
    await run("ALTER TABLE agents ADD COLUMN agent_api_token_hash TEXT");
  }
  if (!agentColumnNames.has("agent_api_token_enc")) {
    await run("ALTER TABLE agents ADD COLUMN agent_api_token_enc TEXT");
  }
  if (!agentColumnNames.has("pending_poll_interval_seconds")) {
    await run("ALTER TABLE agents ADD COLUMN pending_poll_interval_seconds INTEGER");
  }
  if (!agentColumnNames.has("last_info_json")) {
    await run("ALTER TABLE agents ADD COLUMN last_info_json TEXT");
  }
  if (!agentColumnNames.has("last_info_updated_at")) {
    await run("ALTER TABLE agents ADD COLUMN last_info_updated_at TEXT");
  }
  if (!agentColumnNames.has("uptime_seconds")) {
    await run("ALTER TABLE agents ADD COLUMN uptime_seconds INTEGER");
  }
  if (!agentColumnNames.has("reboot_required")) {
    await run("ALTER TABLE agents ADD COLUMN reboot_required INTEGER");
  }
  // Down monitoring: online state + per-agent opt-out
  if (!agentColumnNames.has("is_online")) {
    await run("ALTER TABLE agents ADD COLUMN is_online INTEGER");
  }
  if (!agentColumnNames.has("offline_since")) {
    await run("ALTER TABLE agents ADD COLUMN offline_since TEXT");
  }
  if (!agentColumnNames.has("monitor_enabled")) {
    await run("ALTER TABLE agents ADD COLUMN monitor_enabled INTEGER DEFAULT 1");
  }
  // Remote package management: explicit per-agent opt-in (OFF by default)
  if (!agentColumnNames.has("packages_enabled")) {
    await run("ALTER TABLE agents ADD COLUMN packages_enabled INTEGER DEFAULT 0");
  }
  // Available OS/package updates found by CHECK_UPDATES (JSON: {manager,updates,count})
  if (!agentColumnNames.has("pending_updates_json")) {
    await run("ALTER TABLE agents ADD COLUMN pending_updates_json TEXT");
  }
  if (!agentColumnNames.has("updates_checked_at")) {
    await run("ALTER TABLE agents ADD COLUMN updates_checked_at TEXT");
  }
  // Installed packages found by PACKAGES_LIST (JSON: {manager,packages,count}).
  // Not persisted automatically by the agent — the dashboard stores the last
  // scan result so the fleet-wide "Tout" view can aggregate without re-pinging
  // every machine. Cleared/refreshed via "Scan fleet".
  if (!agentColumnNames.has("packages_json")) {
    await run("ALTER TABLE agents ADD COLUMN packages_json TEXT");
  }
  // Live vital signs (CPU / memory / disk) sent with every poll. Distinct from
  // last_info_json, which is the expensive inventory refreshed on demand only.
  if (!agentColumnNames.has("metrics_json")) {
    await run("ALTER TABLE agents ADD COLUMN metrics_json TEXT");
  }
  if (!agentColumnNames.has("metrics_updated_at")) {
    await run("ALTER TABLE agents ADD COLUMN metrics_updated_at TEXT");
  }
  // Log-directory footprint reported by the agent (file count + total bytes),
  // so the retention page can show what each host is actually holding.
  if (!agentColumnNames.has("log_stats_json")) {
    await run("ALTER TABLE agents ADD COLUMN log_stats_json TEXT");
  }
  // Grouping + manual ordering (global)
  if (!agentColumnNames.has("group_id")) {
    await run("ALTER TABLE agents ADD COLUMN group_id INTEGER");
  }
  if (!agentColumnNames.has("position")) {
    await run("ALTER TABLE agents ADD COLUMN position INTEGER");
  }

  // Metric history, used for the sparklines on the fleet and agent pages.
  // One row per agent per sampling window (see METRICS_SAMPLE_INTERVAL_MS in
  // routes/agent-api.js) — not one row per poll, which at a 15 s interval would
  // add ~5 800 rows per agent per day for no extra visual resolution.
  await run(
    `CREATE TABLE IF NOT EXISTS agent_metrics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT NOT NULL,
      collected_at TEXT NOT NULL,
      cpu_percent REAL,
      memory_percent REAL,
      disk_percent REAL,
      load_1m REAL
    )`
  );
  await run(
    "CREATE INDEX IF NOT EXISTS idx_agent_metrics_agent_time ON agent_metrics (agent_id, collected_at)"
  );

  await run(
    `CREATE TABLE IF NOT EXISTS groups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE,
      color TEXT,
      position INTEGER,
      created_at TEXT
    )`
  );
  // Per-agent local web interface settings
  if (!agentColumnNames.has("local_web_enabled")) {
    await run("ALTER TABLE agents ADD COLUMN local_web_enabled INTEGER DEFAULT 0");
  }
  if (!agentColumnNames.has("local_web_port")) {
    await run("ALTER TABLE agents ADD COLUMN local_web_port INTEGER DEFAULT 8180");
  }
  // Custom base URL for agents that communicate via an external/internet URL
  if (!agentColumnNames.has("install_base_url")) {
    await run("ALTER TABLE agents ADD COLUMN install_base_url TEXT");
  }

  const agents = await all(
    "SELECT id, install_token, agent_api_token, install_token_hash, install_token_enc, agent_api_token_hash, agent_api_token_enc FROM agents"
  );
  for (const agent of agents) {
    const updates = [];
    const params = [];

    if (agent.install_token && (!agent.install_token_hash || !agent.install_token_enc)) {
      const token = protectToken(agent.install_token);
      updates.push("install_token_hash = ?", "install_token_enc = ?");
      params.push(token.hash, token.encrypted);
    }

    if (agent.agent_api_token && (!agent.agent_api_token_hash || !agent.agent_api_token_enc)) {
      const token = protectToken(agent.agent_api_token);
      updates.push("agent_api_token_hash = ?", "agent_api_token_enc = ?");
      params.push(token.hash, token.encrypted);
    }

    if (agent.install_token) {
      updates.push("install_token = NULL");
    }
    if (agent.agent_api_token) {
      updates.push("agent_api_token = NULL");
    }

    if (updates.length > 0) {
      params.push(agent.id);
      await run(`UPDATE agents SET ${updates.join(", ")} WHERE id = ?`, params);
    }
  }

  await run(
    `CREATE TABLE IF NOT EXISTS commands (
      id TEXT PRIMARY KEY,
      agent_id TEXT,
      type TEXT,
      payload_json TEXT,
      status TEXT,
      result_json TEXT,
      error_message TEXT,
      created_at TEXT,
      updated_at TEXT
    )`
  );

  const commandColumns = await all("PRAGMA table_info(commands)");
  const commandColumnNames = new Set(commandColumns.map((col) => col.name));
  if (!commandColumnNames.has("started_at")) {
    await run("ALTER TABLE commands ADD COLUMN started_at TEXT");
  }
  if (!commandColumnNames.has("completed_at")) {
    await run("ALTER TABLE commands ADD COLUMN completed_at TEXT");
  }
  if (!commandColumnNames.has("attempt_count")) {
    await run("ALTER TABLE commands ADD COLUMN attempt_count INTEGER DEFAULT 0");
  }
  if (!commandColumnNames.has("last_heartbeat_at")) {
    await run("ALTER TABLE commands ADD COLUMN last_heartbeat_at TEXT");
  }
  if (!commandColumnNames.has("requested_by_user_id")) {
    await run("ALTER TABLE commands ADD COLUMN requested_by_user_id INTEGER");
  }
  if (!commandColumnNames.has("source")) {
    await run("ALTER TABLE commands ADD COLUMN source TEXT");
  }
  if (!commandColumnNames.has("correlation_id")) {
    await run("ALTER TABLE commands ADD COLUMN correlation_id TEXT");
  }

  await run(
    `CREATE TABLE IF NOT EXISTS audit_events (
      id TEXT PRIMARY KEY,
      actor_user_id INTEGER,
      action TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT,
      agent_id TEXT,
      details_json TEXT,
      created_at TEXT NOT NULL
    )`
  );
  await run(
    "CREATE INDEX IF NOT EXISTS idx_audit_events_created_at ON audit_events(created_at)"
  );
  await run(
    "CREATE INDEX IF NOT EXISTS idx_audit_events_agent_id ON audit_events(agent_id)"
  );

  await run(
    `CREATE TABLE IF NOT EXISTS notification_events (
      id TEXT PRIMARY KEY,
      subject TEXT NOT NULL,
      body TEXT,
      channel TEXT NOT NULL,
      ok INTEGER NOT NULL,
      error_message TEXT,
      created_at TEXT NOT NULL
    )`
  );
  await run(
    "CREATE INDEX IF NOT EXISTS idx_notification_events_created_at ON notification_events(created_at)"
  );

  await run(
    `CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    )`
  );

  const existing = await get("SELECT COUNT(*) AS count FROM users");
  if (!existing || existing.count === 0) {
    const now = new Date().toISOString();
    const initialPassword =
      process.env.INITIAL_ADMIN_PASSWORD || crypto.randomBytes(18).toString("base64url");
    const hash = await bcrypt.hash(initialPassword, 10);
    await run(
      "INSERT INTO users (username, password_hash, created_at, is_admin, must_change_password) VALUES (?, ?, ?, 1, 0)",
      ["admin", hash, now]
    );
    if (!process.env.INITIAL_ADMIN_PASSWORD) {
      writeBootstrapAdminFile(initialPassword, now);
    }
  }

  const adminCount = await get(
    "SELECT COUNT(*) AS count FROM users WHERE COALESCE(is_admin, 0) = 1"
  );
  if (!adminCount || adminCount.count === 0) {
    const oldestUser = await get("SELECT id FROM users ORDER BY id ASC LIMIT 1");
    if (oldestUser) {
      await run("UPDATE users SET is_admin = 1 WHERE id = ?", [oldestUser.id]);
    }
  }

  bestEffortChmod(resolveRuntimePath(config.dbPath), 0o600);
  const sessionDbPath = resolveRuntimePath(
    config.dbPath.endsWith(".sqlite")
      ? config.dbPath.replace(/\.sqlite$/, ".sessions.sqlite")
      : `${config.dbPath}.sessions.sqlite`
  );
  bestEffortChmod(sessionDbPath, 0o600);
}

export const dbOps = { run, get, all };
