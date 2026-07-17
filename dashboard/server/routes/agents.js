/**
 * Agent management routes used by the dashboard UI and local admin tooling.
 */
import express from "express";
import { v4 as uuidv4 } from "uuid";
import { dbOps } from "../db/index.js";
import { requireAdmin } from "../middleware/auth.js";
import { decryptSecret, generateToken, protectToken } from "../utils/tokens.js";
import config from "../config.js";
import { resolveBaseUrl } from "../utils/base-url.js";
import { readVersion } from "./bundle.js";
import { validatePackageName, validateSearchQuery } from "../utils/packages-policy.js";
import { broadcastSSE } from "../utils/sse.js";
import { getActorUserId, recordAuditEvent } from "../utils/audit.js";
import { RETRYABLE_COMMAND_TYPES, validateCommandPayload } from "../utils/command-policy.js";

const router = express.Router();
const INSTALLER_FILENAMES = {
  linux: "/tmp/aaul-install.sh",
  macos: "/tmp/aaul-install.sh",
  windows: "$env:TEMP\\aaul-install.ps1"
};

// Every platform uses the same one-time token, only the generated script differs.
function buildInstallUrls(baseUrl, installToken) {
  const encodedToken = encodeURIComponent(installToken);
  const root = `${baseUrl.replace(/\/$/, "")}/install?token=${encodedToken}`;
  return {
    linux: root,
    macos: `${root}&platform=macos`,
    windows: `${root}&platform=windows`
  };
}

// These commands are meant for display and copy/paste in the dashboard.
function buildInstallCommands(baseUrl, installToken) {
  const urls = buildInstallUrls(baseUrl, installToken);
  return {
    linux: `curl -fsSLo ${INSTALLER_FILENAMES.linux} '${urls.linux}' && sudo sh ${INSTALLER_FILENAMES.linux} && rm -f ${INSTALLER_FILENAMES.linux}`,
    macos: `curl -fsSLo ${INSTALLER_FILENAMES.macos} '${urls.macos}' && sudo bash ${INSTALLER_FILENAMES.macos} && rm -f ${INSTALLER_FILENAMES.macos}`,
    windows:
      `powershell -NoProfile -ExecutionPolicy Bypass -Command "` +
      `Invoke-WebRequest '${urls.windows}' -UseBasicParsing -OutFile ${INSTALLER_FILENAMES.windows}; ` +
      `& ${INSTALLER_FILENAMES.windows}"`,
    urls
  };
}

// Older rows or broken key material can make token decryption fail; callers handle null.
function extractInstallToken(agent) {
  try {
    return agent.install_token_enc ? decryptSecret(agent.install_token_enc) : agent.install_token;
  } catch {
    return null;
  }
}

// The UI expects install information to exist even for migrated legacy rows.
async function ensureInstallToken(agent) {
  const installToken = extractInstallToken(agent);
  if (installToken) {
    return installToken;
  }

  const rotatedToken = generateToken(32);
  const protectedInstallToken = protectToken(rotatedToken);
  await dbOps.run(
    "UPDATE agents SET install_token = NULL, install_token_hash = ?, install_token_enc = ? WHERE id = ?",
    [protectedInstallToken.hash, protectedInstallToken.encrypted, agent.id]
  );
  agent.install_token = null;
  agent.install_token_hash = protectedInstallToken.hash;
  agent.install_token_enc = protectedInstallToken.encrypted;
  return rotatedToken;
}

// Keep command dispatch serialized per agent to avoid overlapping actions.
async function getPendingCommand(agentId) {
  return dbOps.get(
    "SELECT id, type, status, payload_json FROM commands WHERE agent_id = ? AND status IN ('QUEUED','IN_PROGRESS') ORDER BY created_at ASC LIMIT 1",
    [agentId]
  );
}

async function createCommand(agentId, type, payload, req = null) {
  const policy = validateCommandPayload(type, payload);
  if (!policy.ok) {
    return { error: policy.error, status: 400 };
  }
  const agent = await dbOps.get("SELECT id FROM agents WHERE id = ?", [agentId]);
  if (!agent) {
    return { error: "Agent not found", status: 404 };
  }
  const existing = await getPendingCommand(agentId);
  if (existing) {
    return { error: "Command already pending", status: 409 };
  }
  const now = new Date().toISOString();
  const id = uuidv4();
  await dbOps.run(
    `INSERT INTO commands (
      id,
      agent_id,
      type,
      payload_json,
      status,
      created_at,
      updated_at,
      requested_by_user_id,
      source,
      correlation_id
    ) VALUES (?, ?, ?, ?, 'QUEUED', ?, ?, ?, ?, ?)`,
    [
      id,
      agentId,
      type,
      policy.payload ? JSON.stringify(policy.payload) : null,
      now,
      now,
      getActorUserId(req),
      req ? "ADMIN" : "SYSTEM",
      uuidv4()
    ]
  );
  await recordAuditEvent({
    actorUserId: getActorUserId(req),
    action: "command.queued",
    entityType: "command",
    entityId: id,
    agentId,
    details: { type, payload: policy.payload }
  });
  return { id };
}

function parseJsonOrNull(value) {
  if (!value) {
    return null;
  }
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function serializeCommand(command) {
  return {
    id: command.id,
    type: command.type,
    status: command.status,
    payload: parseJsonOrNull(command.payload_json),
    result: parseJsonOrNull(command.result_json),
    errorMessage: command.error_message,
    requestedByUserId: command.requested_by_user_id,
    source: command.source,
    correlationId: command.correlation_id,
    createdAt: command.created_at,
    startedAt: command.started_at,
    completedAt: command.completed_at,
    updatedAt: command.updated_at,
    attemptCount: command.attempt_count || 0
  };
}

async function queueCommand(req, res, type, payload = null) {
  const result = await createCommand(req.params.id, type, payload, req);
  if (result.error) {
    res.status(result.status).json({ error: result.error });
    return null;
  }
  res.json({ ok: true, commandId: result.id });
  return result;
}

router.get("/", requireAdmin, async (req, res) => {
  const latestVersion = readVersion();
  const agents = await dbOps.all(
    "SELECT * FROM agents ORDER BY position IS NULL, position ASC, created_at DESC"
  );
  const enriched = await Promise.all(
    agents.map(async (agent) => {
      const pending = await getPendingCommand(agent.id);
      const isOutdated =
        Boolean(agent.agent_version) && agent.agent_version !== latestVersion;

      // Only expose the subset the dashboard uses in tables and tooltips.
      let osInfo = null;
      if (agent.last_info_json) {
        try {
          const info = JSON.parse(agent.last_info_json);
          if (info.os) {
            osInfo = {
              name: info.os.name || null,
              version: info.os.version || null,
              codename: info.os.codename || null
            };
          }
        } catch { /* ignore parse errors */ }
      }

      return {
        id: agent.id,
        displayName: agent.display_name,
        hostname: agent.last_hostname,
        ip: agent.last_ip,
        lastSeenAt: agent.last_seen_at,
        lastRunAt: agent.last_run_at,
        lastStatus: agent.last_status,
        lastExitCode: agent.last_exit_code,
        lastDurationSeconds: agent.last_duration_seconds,
        uptimeSeconds: agent.uptime_seconds,
        rebootRequired: agent.reboot_required === 1,
        agentVersion: agent.agent_version,
        isOutdated,
        isOnline: agent.is_online === null ? true : agent.is_online === 1,
        offlineSince: agent.offline_since || null,
        monitorEnabled: agent.monitor_enabled === null ? true : agent.monitor_enabled === 1,
        updatesAvailable: (() => {
          try { return JSON.parse(agent.pending_updates_json || "{}").count || 0; }
          catch { return 0; }
        })(),
        groupId: agent.group_id || null,
        position: agent.position ?? null,
        osName: (() => {
          try { return JSON.parse(agent.last_info_json || "{}")?.os?.name || null; }
          catch { return null; }
        })(),
        isInternet: Boolean(agent.install_base_url),
        osInfo,
        schedule: {
          enabled: Boolean(agent.schedule_enabled),
          dailyTime: agent.schedule_daily_time
        },
        pendingCommand: pending
          ? {
              id: pending.id,
              type: pending.type,
              status: pending.status
            }
          : null,
        createdAt: agent.created_at
      };
    })
  );
  res.json({ ok: true, agents: enriched, latestVersion });
});

// Tâches : toutes les commandes en attente / en cours (tous agents).
// Les commandes terminées (DONE/ERROR) ne sont volontairement pas listées.
router.get("/commands/pending", requireAdmin, async (req, res) => {
  const rows = await dbOps.all(
    `SELECT c.id, c.agent_id, c.type, c.status, c.created_at, c.updated_at, a.display_name
       FROM commands c
       LEFT JOIN agents a ON a.id = c.agent_id
      WHERE c.status IN ('QUEUED','IN_PROGRESS')
      ORDER BY c.created_at ASC`
  );
  res.json({
    ok: true,
    commands: rows.map((r) => ({
      id: r.id,
      agentId: r.agent_id,
      agentName: r.display_name || r.agent_id,
      type: r.type,
      status: r.status,
      createdAt: r.created_at,
      updatedAt: r.updated_at
    }))
  });
});

router.get("/commands/history", requireAdmin, async (req, res) => {
  const limit = Math.min(Number.parseInt(req.query.limit, 10) || 100, 500);
  const status = String(req.query.status || "").trim().toUpperCase();
  const agentId = String(req.query.agentId || "").trim();
  const type = String(req.query.type || "").trim().toUpperCase();
  const conditions = [];
  const params = [];

  if (status && ["QUEUED", "IN_PROGRESS", "DONE", "ERROR"].includes(status)) {
    conditions.push("c.status = ?");
    params.push(status);
  }
  if (agentId) {
    conditions.push("c.agent_id = ?");
    params.push(agentId);
  }
  if (type) {
    conditions.push("c.type = ?");
    params.push(type);
  }

  params.push(limit);
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const rows = await dbOps.all(
    `SELECT c.*, a.display_name
       FROM commands c
       LEFT JOIN agents a ON a.id = c.agent_id
      ${where}
      ORDER BY c.created_at DESC
      LIMIT ?`,
    params
  );
  res.json({
    ok: true,
    commands: rows.map((row) => ({
      ...serializeCommand(row),
      agentName: row.display_name || row.agent_id
    }))
  });
});

router.post("/commands/:commandId/retry", requireAdmin, async (req, res) => {
  const command = await dbOps.get("SELECT * FROM commands WHERE id = ?", [req.params.commandId]);
  if (!command) {
    res.status(404).json({ error: "Command not found" });
    return;
  }
  if (!RETRYABLE_COMMAND_TYPES.has(command.type)) {
    res.status(400).json({ error: "Command type is not retryable" });
    return;
  }
  const payload = parseJsonOrNull(command.payload_json);
  const result = await createCommand(command.agent_id, command.type, payload, req);
  if (result.error) {
    res.status(result.status).json({ error: result.error });
    return;
  }
  res.json({ ok: true, commandId: result.id });
});

// Purge : annuler TOUTES les tâches en attente / en cours (tous agents).
// Utile pour vider un backlog (ex: commandes héritées d'une ancienne version).
router.post("/commands/cancel-all", requireAdmin, async (req, res) => {
  const now = new Date().toISOString();
  const result = await dbOps.run(
    "UPDATE commands SET status = 'ERROR', error_message = ?, updated_at = ? WHERE status IN ('QUEUED','IN_PROGRESS')",
    ["Cancelled by admin (bulk purge)", now]
  );
  broadcastSSE("command:update", { bulk: true });
  res.json({ ok: true, cancelled: result?.changes ?? null });
});

// Annuler une tâche précise (en attente ou en cours).
router.post("/:id/commands/:commandId/cancel", requireAdmin, async (req, res) => {
  const cmd = await dbOps.get(
    "SELECT id, status FROM commands WHERE id = ? AND agent_id = ?",
    [req.params.commandId, req.params.id]
  );
  if (!cmd) {
    res.status(404).json({ error: "Command not found" });
    return;
  }
  if (!["QUEUED", "IN_PROGRESS"].includes(cmd.status)) {
    res.status(400).json({ error: "Command is not cancellable" });
    return;
  }
  const now = new Date().toISOString();
  await dbOps.run(
    "UPDATE commands SET status = 'ERROR', error_message = ?, updated_at = ? WHERE id = ?",
    ["Cancelled by admin", now, req.params.commandId]
  );
  broadcastSSE("command:update", { agentId: req.params.id, commandId: req.params.commandId, status: "ERROR" });
  res.json({ ok: true });
});

// Convenience action from the dashboard header.
router.post("/update-outdated", requireAdmin, async (req, res) => {
  const latestVersion = readVersion();
  const agents = await dbOps.all(
    "SELECT id, agent_version FROM agents WHERE agent_version IS NOT NULL AND agent_version != ?",
    [latestVersion]
  );
  const results = await Promise.all(
    agents.map(async (agent) => {
      const existing = await getPendingCommand(agent.id);
      if (existing) {
        return { id: agent.id, skipped: true };
      }
      const result = await createCommand(agent.id, "UPDATE_AGENT", null, req);
      return { id: agent.id, commandId: result.id, error: result.error || null };
    })
  );
  res.json({ ok: true, queued: results.filter((r) => r.commandId).length, results });
});

function sanitizeBaseUrl(value) {
  try {
    const u = new URL(String(value || "").trim());
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    // Keep only the origin. Install scripts should never inherit an arbitrary path.
    return u.origin;
  } catch {
    return null;
  }
}

router.post("/", requireAdmin, async (req, res) => {
  const { displayName, baseUrl: rawBaseUrl } = req.body || {};
  const displayNameValue = String(displayName || "").trim();
  if (!displayNameValue) {
    res.status(400).json({ error: "Missing displayName" });
    return;
  }
  if (displayNameValue.length > 128 || /[\r\n\t\0]/.test(displayNameValue)) {
    res.status(400).json({ error: "Invalid displayName" });
    return;
  }

  let installBaseUrl = null;
  if (rawBaseUrl) {
    installBaseUrl = sanitizeBaseUrl(rawBaseUrl);
    if (!installBaseUrl) {
      res.status(400).json({ error: "Invalid baseUrl — must be a valid http/https URL" });
      return;
    }
  }

  const agentId = uuidv4();
  const installToken = generateToken(32);
  const agentApiToken = generateToken(32);
  const protectedInstallToken = protectToken(installToken);
  const protectedAgentApiToken = protectToken(agentApiToken);
  const now = new Date().toISOString();
  // Tokens are persisted as hash + encrypted value; plaintext leaves the server only once here.
  await dbOps.run(
    `INSERT INTO agents (
      id,
      display_name,
      install_token,
      agent_api_token,
      install_token_hash,
      install_token_enc,
      agent_api_token_hash,
      agent_api_token_enc,
      schedule_enabled,
      schedule_daily_time,
      install_base_url,
      created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      agentId,
      displayNameValue,
      null,
      null,
      protectedInstallToken.hash,
      protectedInstallToken.encrypted,
      protectedAgentApiToken.hash,
      protectedAgentApiToken.encrypted,
      config.agentDefaultScheduleEnabled,
      config.agentDefaultDailyTime,
      installBaseUrl,
      now
    ]
  );

  const resolvedBase = installBaseUrl || (await resolveBaseUrl()).replace(/\/$/, "");
  const install = buildInstallCommands(resolvedBase, installToken);
  await recordAuditEvent({
    actorUserId: getActorUserId(req),
    action: "agent.created",
    entityType: "agent",
    entityId: agentId,
    agentId,
    details: { displayName: displayNameValue, installBaseUrl }
  });

  res.json({
    ok: true,
    agentId,
    installToken,
    installUrls: install.urls,
    installCommands: {
      linux: install.linux,
      macos: install.macos,
      windows: install.windows
    },
    installCommand: install.linux
  });
});

router.get("/:id", requireAdmin, async (req, res) => {
  const agent = await dbOps.get("SELECT * FROM agents WHERE id = ?", [req.params.id]);
  if (!agent) {
    res.status(404).json({ error: "Agent not found" });
    return;
  }
  const resolvedBase = agent.install_base_url
    ? agent.install_base_url.replace(/\/$/, "")
    : (await resolveBaseUrl()).replace(/\/$/, "");
  const installToken = await ensureInstallToken(agent);
  res.json({
    ok: true,
    agent: {
      id: agent.id,
      displayName: agent.display_name,
      hostname: agent.last_hostname,
      ip: agent.last_ip,
      lastSeenAt: agent.last_seen_at,
      lastRunAt: agent.last_run_at,
      lastStatus: agent.last_status,
      lastExitCode: agent.last_exit_code,
      lastDurationSeconds: agent.last_duration_seconds,
      uptimeSeconds: agent.uptime_seconds,
      rebootRequired: agent.reboot_required === 1,
      agentVersion: agent.agent_version,
      installBaseUrl: resolvedBase,
      isOnline: agent.is_online === null ? true : agent.is_online === 1,
      offlineSince: agent.offline_since || null,
      monitorEnabled: agent.monitor_enabled === null ? true : agent.monitor_enabled === 1,
      packagesEnabled: agent.packages_enabled === 1,
      updates: (() => {
        try { return JSON.parse(agent.pending_updates_json || "null"); }
        catch { return null; }
      })(),
      updatesCheckedAt: agent.updates_checked_at || null,
      schedule: {
        enabled: Boolean(agent.schedule_enabled),
        dailyTime: agent.schedule_daily_time
      },
      localWeb: {
        enabled: agent.local_web_enabled === 1,
        port: agent.local_web_port || 8180
      },
      createdAt: agent.created_at,
      lastInfoUpdatedAt: agent.last_info_updated_at
    },
    install: installToken ? buildInstallCommands(resolvedBase, installToken) : null,
    info: agent.last_info_json ? JSON.parse(agent.last_info_json) : null
  });
});

router.get("/:id/install", requireAdmin, async (req, res) => {
  const agent = await dbOps.get(
    "SELECT id, display_name, install_token, install_token_enc, install_token_hash, install_base_url FROM agents WHERE id = ?",
    [req.params.id]
  );
  if (!agent) {
    res.status(404).json({ error: "Agent not found" });
    return;
  }
  const installToken = await ensureInstallToken(agent);
  if (!installToken) {
    res.status(500).json({ error: "Install token unavailable" });
    return;
  }
  const resolvedBase = agent.install_base_url
    ? agent.install_base_url.replace(/\/$/, "")
    : (await resolveBaseUrl()).replace(/\/$/, "");
  const install = buildInstallCommands(resolvedBase, installToken);
  res.json({
    ok: true,
    agentId: agent.id,
    displayName: agent.display_name,
    installToken,
    installUrls: install.urls,
    installCommands: {
      linux: install.linux,
      macos: install.macos,
      windows: install.windows
    },
    installCommand: install.linux
  });
});

router.delete("/:id", requireAdmin, async (req, res) => {
  await dbOps.run("DELETE FROM commands WHERE agent_id = ?", [req.params.id]);
  await dbOps.run("DELETE FROM agents WHERE id = ?", [req.params.id]);
  await recordAuditEvent({
    actorUserId: getActorUserId(req),
    action: "agent.deleted",
    entityType: "agent",
    entityId: req.params.id,
    agentId: req.params.id
  });
  res.json({ ok: true });
});

// The agent applies these settings on its next poll.
router.put("/:id/local-web", requireAdmin, async (req, res) => {
  const { enabled, port } = req.body || {};
  const allowedPorts = [8080, 8090, 8180, 8190];
  
  // Validate port
  const portValue = parseInt(port, 10);
  if (port !== undefined && !allowedPorts.includes(portValue)) {
    res.status(400).json({ 
      error: `Invalid port. Allowed ports: ${allowedPorts.join(', ')}` 
    });
    return;
  }
  
  const agent = await dbOps.get("SELECT id FROM agents WHERE id = ?", [req.params.id]);
  if (!agent) {
    res.status(404).json({ error: "Agent not found" });
    return;
  }
  
  // Update the agent's local web settings
  await dbOps.run(
    "UPDATE agents SET local_web_enabled = ?, local_web_port = ? WHERE id = ?",
    [
      enabled ? 1 : 0,
      portValue || 8180,
      req.params.id
    ]
  );
  await recordAuditEvent({
    actorUserId: getActorUserId(req),
    action: "agent.local_web_updated",
    entityType: "agent",
    entityId: req.params.id,
    agentId: req.params.id,
    details: { enabled: Boolean(enabled), port: portValue || 8180 }
  });
  
  res.json({ 
    ok: true,
    localWeb: {
      enabled: Boolean(enabled),
      port: portValue || 8180
    }
  });
});

// Enable/disable down-monitoring for a single agent.
router.put("/:id/monitor", requireAdmin, async (req, res) => {
  const { enabled } = req.body || {};
  if (typeof enabled !== "boolean") {
    res.status(400).json({ error: "Missing enabled boolean" });
    return;
  }
  const agent = await dbOps.get("SELECT id FROM agents WHERE id = ?", [req.params.id]);
  if (!agent) {
    res.status(404).json({ error: "Agent not found" });
    return;
  }
  // When re-enabling, reset the online state so the watcher re-evaluates cleanly.
  await dbOps.run(
    "UPDATE agents SET monitor_enabled = ?, is_online = NULL, offline_since = NULL WHERE id = ?",
    [enabled ? 1 : 0, req.params.id]
  );
  await recordAuditEvent({
    actorUserId: getActorUserId(req),
    action: "agent.monitor_updated",
    entityType: "agent",
    entityId: req.params.id,
    agentId: req.params.id,
    details: { enabled }
  });
  res.json({ ok: true, monitorEnabled: enabled });
});

// --- Remote package management -------------------------------------------

// Toggle the per-agent opt-in for install/remove (OFF by default).
router.put("/:id/packages", requireAdmin, async (req, res) => {
  const { enabled } = req.body || {};
  if (typeof enabled !== "boolean") {
    res.status(400).json({ error: "Missing enabled boolean" });
    return;
  }
  const agent = await dbOps.get("SELECT id FROM agents WHERE id = ?", [req.params.id]);
  if (!agent) {
    res.status(404).json({ error: "Agent not found" });
    return;
  }
  await dbOps.run("UPDATE agents SET packages_enabled = ? WHERE id = ?", [
    enabled ? 1 : 0,
    req.params.id
  ]);
  await recordAuditEvent({
    actorUserId: getActorUserId(req),
    action: "agent.packages_updated",
    entityType: "agent",
    entityId: req.params.id,
    agentId: req.params.id,
    details: { enabled }
  });
  res.json({ ok: true, packagesEnabled: enabled });
});

// Persist a custom global ordering (drag & drop in the "Tout" view).
router.put("/reorder", requireAdmin, async (req, res) => {
  const orderedIds = Array.isArray(req.body?.orderedIds) ? req.body.orderedIds : [];
  if (orderedIds.length === 0) {
    res.status(400).json({ error: "orderedIds required" });
    return;
  }
  let pos = 0;
  for (const id of orderedIds) {
    await dbOps.run("UPDATE agents SET position = ? WHERE id = ?", [pos, String(id)]);
    pos += 1;
  }
  res.json({ ok: true });
});

// Assign an agent to a group (or null to ungroup).
router.put("/:id/group", requireAdmin, async (req, res) => {
  const { groupId } = req.body || {};
  const agent = await dbOps.get("SELECT id FROM agents WHERE id = ?", [req.params.id]);
  if (!agent) {
    res.status(404).json({ error: "Agent not found" });
    return;
  }
  let gid = null;
  if (groupId !== null && groupId !== undefined && groupId !== "") {
    const group = await dbOps.get("SELECT id FROM groups WHERE id = ?", [groupId]);
    if (!group) {
      res.status(400).json({ error: "Group not found" });
      return;
    }
    gid = group.id;
  }
  await dbOps.run("UPDATE agents SET group_id = ? WHERE id = ?", [gid, req.params.id]);
  res.json({ ok: true, groupId: gid });
});

// Read-only: scan for available updates on every agent (no install).
router.post("/commands/check-updates-all", requireAdmin, async (req, res) => {
  const agents = await dbOps.all("SELECT id FROM agents");
  const results = await Promise.all(
    agents.map(async (a) => {
      const r = await createCommand(a.id, "CHECK_UPDATES", null, req);
      return { id: a.id, commandId: r.id, error: r.error || null };
    })
  );
  res.json({ ok: true, queued: results.filter((r) => r.commandId).length, results });
});

// Read-only: scan a single agent for available updates (no install).
router.post("/:id/packages/check-updates", requireAdmin, async (req, res) => {
  const result = await createCommand(req.params.id, "CHECK_UPDATES", null, req);
  if (result.error) {
    res.status(result.status).json({ error: result.error });
    return;
  }
  res.json({ ok: true, commandId: result.id });
});

// Apply updates to selected packages (mutating: requires the opt-in + validation).
router.post("/:id/packages/update", requireAdmin, async (req, res) => {
  const agent = await requirePackagesEnabled(req, res);
  if (!agent) return;
  const names = Array.isArray(req.body?.names) ? req.body.names : [];
  if (names.length === 0) {
    res.status(400).json({ error: "No packages selected" });
    return;
  }
  const clean = [];
  for (const n of names) {
    const check = validatePackageName(n);
    if (!check.ok) {
      res.status(400).json({ error: `${check.error}: ${n}` });
      return;
    }
    clean.push(check.name);
  }
  const result = await createCommand(req.params.id, "UPDATE_PACKAGES", { names: clean }, req);
  if (result.error) {
    res.status(result.status).json({ error: result.error });
    return;
  }
  res.json({ ok: true, commandId: result.id });
});

// Read-only: always allowed (listing installed packages).
router.post("/:id/packages/list", requireAdmin, async (req, res) => {
  const result = await createCommand(req.params.id, "PACKAGES_LIST", null, req);
  if (result.error) {
    res.status(result.status).json({ error: result.error });
    return;
  }
  res.json({ ok: true, commandId: result.id });
});

// Read-only: always allowed (searching available packages).
router.post("/:id/packages/search", requireAdmin, async (req, res) => {
  const check = validateSearchQuery(req.body?.query);
  if (!check.ok) {
    res.status(400).json({ error: check.error });
    return;
  }
  const result = await createCommand(req.params.id, "PACKAGE_SEARCH", { query: check.query }, req);
  if (result.error) {
    res.status(result.status).json({ error: result.error });
    return;
  }
  res.json({ ok: true, commandId: result.id });
});

// Mutating: requires the per-agent opt-in + strict validation + blacklist.
async function requirePackagesEnabled(req, res) {
  const agent = await dbOps.get(
    "SELECT id, COALESCE(packages_enabled, 0) AS packages_enabled FROM agents WHERE id = ?",
    [req.params.id]
  );
  if (!agent) {
    res.status(404).json({ error: "Agent not found" });
    return null;
  }
  if (Number(agent.packages_enabled) !== 1) {
    res.status(403).json({ error: "Package management is disabled for this agent" });
    return null;
  }
  return agent;
}

router.post("/:id/packages/install", requireAdmin, async (req, res) => {
  const agent = await requirePackagesEnabled(req, res);
  if (!agent) return;
  const check = validatePackageName(req.body?.name);
  if (!check.ok) {
    res.status(400).json({ error: check.error });
    return;
  }
  const result = await createCommand(req.params.id, "PACKAGE_INSTALL", { name: check.name }, req);
  if (result.error) {
    res.status(result.status).json({ error: result.error });
    return;
  }
  res.json({ ok: true, commandId: result.id });
});

router.post("/:id/packages/remove", requireAdmin, async (req, res) => {
  const agent = await requirePackagesEnabled(req, res);
  if (!agent) return;
  const check = validatePackageName(req.body?.name);
  if (!check.ok) {
    res.status(400).json({ error: check.error });
    return;
  }
  const result = await createCommand(req.params.id, "PACKAGE_REMOVE", { name: check.name }, req);
  if (result.error) {
    res.status(result.status).json({ error: result.error });
    return;
  }
  res.json({ ok: true, commandId: result.id });
});

router.post("/:id/commands/run-now", requireAdmin, async (req, res) => {
  await queueCommand(req, res, "RUN_NOW");
});

router.post("/:id/commands/schedule", requireAdmin, async (req, res) => {
  const { enabled, dailyTime } = req.body || {};
  if (typeof enabled !== "boolean" || !dailyTime) {
    res.status(400).json({ error: "Missing schedule payload" });
    return;
  }
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(dailyTime))) {
    res.status(400).json({ error: "Invalid dailyTime format (HH:MM)" });
    return;
  }
  await queueCommand(req, res, "SET_SCHEDULE", {
    enabled,
    dailyTime: String(dailyTime)
  });
});

router.post("/:id/commands/update-agent", requireAdmin, async (req, res) => {
  await queueCommand(req, res, "UPDATE_AGENT");
});

router.post("/:id/commands/info", requireAdmin, async (req, res) => {
  await queueCommand(req, res, "FETCH_INFO");
});

router.post("/:id/commands/uninstall", requireAdmin, async (req, res) => {
  await queueCommand(req, res, "UNINSTALL");
});

router.post("/:id/commands/logs", requireAdmin, async (req, res) => {
  await queueCommand(req, res, "LIST_LOGS");
});

router.post("/:id/commands/log-content", requireAdmin, async (req, res) => {
  const { logName } = req.body || {};
  if (!logName) {
    res.status(400).json({ error: "Missing logName" });
    return;
  }
  await queueCommand(req, res, "FETCH_LOG", { logName });
});

router.post("/:id/commands/cancel", requireAdmin, async (req, res) => {
  const pending = await dbOps.get(
    "SELECT id FROM commands WHERE agent_id = ? AND status = 'QUEUED' ORDER BY created_at ASC LIMIT 1",
    [req.params.id]
  );
  if (!pending) {
    res.status(404).json({ error: "No queued command" });
    return;
  }
  const now = new Date().toISOString();
  await dbOps.run(
    "UPDATE commands SET status = 'ERROR', error_message = ?, updated_at = ?, completed_at = ? WHERE id = ?",
    ["Cancelled by admin", now, now, pending.id]
  );
  await recordAuditEvent({
    actorUserId: getActorUserId(req),
    action: "command.cancelled",
    entityType: "command",
    entityId: pending.id,
    agentId: req.params.id
  });
  res.json({ ok: true });
});

router.get("/:id/commands", requireAdmin, async (req, res) => {
  const limit = Math.min(Number.parseInt(req.query.limit, 10) || 50, 200);
  const commands = await dbOps.all(
    "SELECT * FROM commands WHERE agent_id = ? ORDER BY created_at DESC LIMIT ?",
    [req.params.id, limit]
  );
  res.json({ ok: true, commands: commands.map(serializeCommand) });
});

router.get("/:id/commands/:commandId", requireAdmin, async (req, res) => {
  const command = await dbOps.get(
    "SELECT * FROM commands WHERE id = ? AND agent_id = ?",
    [req.params.commandId, req.params.id]
  );
  if (!command) {
    res.status(404).json({ error: "Command not found" });
    return;
  }
  res.json({
    ok: true,
    command: serializeCommand(command)
  });
});

export default router;
