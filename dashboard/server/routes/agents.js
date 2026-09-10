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
import { applyAgentFilters, triggerHook } from "../plugins/plugin-loader.js";
import { getSetting } from "../utils/settings.js";

const router = express.Router();
const INSTALLER_FILENAMES = {
  linux: "/tmp/aaul-install.sh",
  macos: "/tmp/aaul-install.sh",
  // Quoted at every use: a TEMP path under a profile with a space in it
  // ("C:\\Users\\Jean Dupont\\...") would otherwise split into two arguments.
  windows: '"$env:TEMP\\aaul-install.ps1"'
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
    // Runs in the PowerShell session the operator already opened as
    // Administrator, rather than spawning a nested one.
    //
    // The nested `powershell -Command "..."` this replaces bought nothing and
    // added a failure mode: it depends on the name `powershell` resolving on
    // PATH, and when it does not -- a missing System32 entry, or a Microsoft
    // Store app-execution-alias stub shadowing it -- Windows silently pops the
    // "choose an app to open 'powershell'" dialog instead of running anything.
    // That is the same class of trap as the Python Store alias, and there is no
    // reason to be exposed to it here.
    //
    // Process scope on the execution policy: it applies to this session only,
    // needs no registry write, and disappears when the window closes.
    windows:
      `Set-ExecutionPolicy Bypass -Scope Process -Force; ` +
      `Invoke-WebRequest '${urls.windows}' -UseBasicParsing -OutFile ${INSTALLER_FILENAMES.windows}; ` +
      `try { & ${INSTALLER_FILENAMES.windows} } ` +
      `finally { Remove-Item ${INSTALLER_FILENAMES.windows} -Force -ErrorAction SilentlyContinue }`,
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
  // AAUL-Cloud: un plugin (ex: multi-tenant) peut interdire l'accès à cet agent.
  // Sans cette garde, toute route de commande (run-now, uninstall, …) contourne
  // l'isolation des tenants.
  if (req && !(await applyAgentFilters(agent, req))) {
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

// Live vital signs stored by the poll route. Parsed defensively: a corrupted
// row must degrade to "unknown" in the UI, never break the whole fleet list.
function parseMetrics(metricsJson) {
  if (!metricsJson) {
    return null;
  }
  try {
    const metrics = JSON.parse(metricsJson);
    return metrics && typeof metrics === "object" ? metrics : null;
  } catch {
    return null;
  }
}

// Flat summary for the fleet table/cards — the full object is only sent on the
// agent detail page, where there is room to show it.
function summarizeMetrics(metricsJson, updatedAt) {
  const metrics = parseMetrics(metricsJson);
  if (!metrics) {
    return null;
  }
  return {
    updatedAt: updatedAt || metrics.collectedAt || null,
    cpuPercent: metrics.cpuPercent ?? null,
    memoryPercent: metrics.memory?.percent ?? null,
    diskPercent: metrics.disk?.root?.percent ?? null,
    // The fullest volume matters more than "/" for alerting: / can look healthy
    // while /var is at 98%.
    busiestDiskPercent: metrics.disk?.busiest?.percent ?? null,
    busiestDiskMount: metrics.disk?.busiest?.mount ?? null,
    load1m: metrics.loadAverage?.["1m"] ?? null,
    cpuCount: metrics.cpuCount ?? null
  };
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
  let agents = await dbOps.all(
    "SELECT * FROM agents ORDER BY position IS NULL, position ASC, created_at DESC"
  );
  // AAUL-Cloud: applique les filtres d'agents des plugins (ex: multi-tenant)
  const filtered = [];
  for (const agent of agents) {
    if (await applyAgentFilters(agent, req)) {
      filtered.push(agent);
    }
  }
  agents = filtered;
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
        // Summary only — the fleet table shows a health dot, the detail page
        // fetches the full snapshot.
        antivirus: (() => {
          try {
            const parsed = JSON.parse(agent.antivirus_json || "null");
            if (!parsed) return null;
            return {
              product: parsed.product || null,
              installed: Boolean(parsed.installed),
              healthy: Boolean(parsed.healthy),
              threatsFound: Number(parsed.threatsFound) || 0,
              checkedAt: agent.antivirus_checked_at || null
            };
          } catch { return null; }
        })(),
        metrics: summarizeMetrics(agent.metrics_json, agent.metrics_updated_at),
        securityUpdatesAvailable: (() => {
          try {
            const parsed = JSON.parse(agent.pending_updates_json || "{}");
            if (Number.isFinite(parsed.securityCount)) return parsed.securityCount;
            return (parsed.updates || []).filter((u) => u.security).length;
          } catch { return 0; }
        })(),
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
// AAUL-Cloud: construit le Set des IDs d'agents autorisés par les filtres plugins.
// Retourne null si aucun filtre n'est enregistré (pas de restriction).
async function getAllowedAgentIds(req) {
  const allAgents = await dbOps.all("SELECT * FROM agents");
  const allowed = new Set();
  let hasFilter = false;
  for (const agent of allAgents) {
    if (await applyAgentFilters(agent, req)) {
      allowed.add(agent.id);
    } else {
      hasFilter = true;
    }
  }
  return hasFilter ? allowed : null;
}

router.get("/commands/pending", requireAdmin, async (req, res) => {
  let rows = await dbOps.all(
    `SELECT c.id, c.agent_id, c.type, c.status, c.created_at, c.updated_at, a.display_name
       FROM commands c
       LEFT JOIN agents a ON a.id = c.agent_id
      WHERE c.status IN ('QUEUED','IN_PROGRESS')
      ORDER BY c.created_at ASC`
  );
  // AAUL-Cloud: filtre les commandes dont l'agent est exclu par un plugin
  const allowedAgentIds = await getAllowedAgentIds(req);
  if (allowedAgentIds) {
    rows = rows.filter((r) => allowedAgentIds.has(r.agent_id));
  }
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
  let rows = await dbOps.all(
    `SELECT c.*, a.display_name
       FROM commands c
       LEFT JOIN agents a ON a.id = c.agent_id
      ${where}
      ORDER BY c.created_at DESC
      LIMIT ?`,
    params
  );
  // AAUL-Cloud: filtre les commandes dont l'agent est exclu par un plugin
  const allowedAgentIds = await getAllowedAgentIds(req);
  if (allowedAgentIds) {
    rows = rows.filter((r) => allowedAgentIds.has(r.agent_id));
  }
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

// Purge : annuler TOUTES les tâches en attente / en cours.
// Utile pour vider un backlog (ex: commandes héritées d'une ancienne version).
// AAUL-Cloud: restreinte aux agents autorisés par les filtres de plugins,
// sinon un tenant peut annuler les commandes des autres tenants (DoS).
router.post("/commands/cancel-all", requireAdmin, async (req, res) => {
  const now = new Date().toISOString();
  const allowedAgentIds = await getAllowedAgentIds(req);
  let result;
  if (allowedAgentIds) {
    if (allowedAgentIds.size === 0) {
      res.json({ ok: true, cancelled: 0 });
      return;
    }
    const placeholders = Array.from(allowedAgentIds).map(() => "?").join(",");
    result = await dbOps.run(
      `UPDATE commands SET status = 'ERROR', error_message = ?, updated_at = ? WHERE status IN ('QUEUED','IN_PROGRESS') AND agent_id IN (${placeholders})`,
      ["Cancelled by admin (bulk purge)", now, ...Array.from(allowedAgentIds)]
    );
  } else {
    result = await dbOps.run(
      "UPDATE commands SET status = 'ERROR', error_message = ?, updated_at = ? WHERE status IN ('QUEUED','IN_PROGRESS')",
      ["Cancelled by admin (bulk purge)", now]
    );
  }
  broadcastSSE("command:update", { bulk: true });
  res.json({ ok: true, cancelled: result?.changes ?? null });
});

// Annuler une tâche précise (en attente ou en cours).
router.post("/:id/commands/:commandId/cancel", requireAdmin, async (req, res) => {
  // AAUL-Cloud: isolation multi-tenant avant d'annuler la commande d'un agent
  const agent = await dbOps.get("SELECT id FROM agents WHERE id = ?", [req.params.id]);
  if (!agent || !(await applyAgentFilters(agent, req))) {
    res.status(404).json({ error: "Agent not found" });
    return;
  }
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
  let agents = await dbOps.all(
    "SELECT id, agent_version FROM agents WHERE agent_version IS NOT NULL AND agent_version != ?",
    [latestVersion]
  );
  // AAUL-Cloud: isolation multi-tenant — ne pas révéler ni mettre à jour
  // les agents d'autres tenants.
  const filtered = [];
  for (const agent of agents) {
    if (await applyAgentFilters(agent, req)) filtered.push(agent);
  }
  agents = filtered;
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
  // AAUL-Cloud: notifie les plugins (ex: multi-tenant) qu'un agent vient d'être
  // créé. Le hook reçoit { agentId, req } et peut stamper des colonnes propres
  // au plugin (ex: client_id) — le cœur ne connaît pas ces colonnes.
  await triggerHook("agent:registered", { agentId, req });
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
  // AAUL-Cloud: refuse l'accès si un plugin exclut cet agent (ex: multi-tenant)
  if (!(await applyAgentFilters(agent, req))) {
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
      antivirus: (() => {
        try { return JSON.parse(agent.antivirus_json || "null"); }
        catch { return null; }
      })(),
      antivirusCheckedAt: agent.antivirus_checked_at || null,
      schedule: {
        enabled: Boolean(agent.schedule_enabled),
        dailyTime: agent.schedule_daily_time
      },
      localWeb: {
        enabled: agent.local_web_enabled === 1,
        port: agent.local_web_port || 8180
      },
      createdAt: agent.created_at,
      lastInfoUpdatedAt: agent.last_info_updated_at,
      metrics: parseMetrics(agent.metrics_json),
      metricsUpdatedAt: agent.metrics_updated_at || null,
      logStats: (() => {
        try { return JSON.parse(agent.log_stats_json || "null"); }
        catch { return null; }
      })()
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
  // AAUL-Cloud: FAILLE CRITIQUE — cette route renvoie le token d'installation
  // en clair. Sans garde, un tenant peut obtenir le token d'un agent d'un
  // autre tenant et en prendre le contrôle total.
  if (!(await applyAgentFilters(agent, req))) {
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
  // AAUL-Cloud: vérifie l'isolation avant toute suppression.
  const agent = await dbOps.get("SELECT id FROM agents WHERE id = ?", [req.params.id]);
  if (!agent) {
    res.status(404).json({ error: "Agent not found" });
    return;
  }
  if (!(await applyAgentFilters(agent, req))) {
    res.status(404).json({ error: "Agent not found" });
    return;
  }
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
  // AAUL-Cloud: isolation multi-tenant
  if (!(await applyAgentFilters(agent, req))) {
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
  // AAUL-Cloud: isolation multi-tenant
  if (!(await applyAgentFilters(agent, req))) {
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
  // AAUL-Cloud: isolation multi-tenant
  if (!(await applyAgentFilters(agent, req))) {
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
    // AAUL-Cloud: on ne réordonne que les agents visibles pour cet utilisateur.
    const agent = await dbOps.get("SELECT id FROM agents WHERE id = ?", [String(id)]);
    if (agent && (await applyAgentFilters(agent, req))) {
      await dbOps.run("UPDATE agents SET position = ? WHERE id = ?", [pos, String(id)]);
      pos += 1;
    }
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
  // AAUL-Cloud: isolation multi-tenant
  if (!(await applyAgentFilters(agent, req))) {
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
  const allAgents = await dbOps.all("SELECT id FROM agents");
  const agents = [];
  for (const agent of allAgents) {
    if (await applyAgentFilters(agent, req)) agents.push(agent);
  }
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

// ---------------------------------------------------------------------------
//  Host metrics
// ---------------------------------------------------------------------------

const METRICS_MAX_HOURS = 24 * 30;
// Thresholds above which a host is called "under pressure" on the fleet view.
// Deliberately conservative: an admin should look at the number, not be buried
// under warnings from a machine that briefly hit 81% CPU.
const PRESSURE_CPU_PERCENT = 90;
const PRESSURE_MEMORY_PERCENT = 90;
const PRESSURE_DISK_PERCENT = 85;

// Time series behind the sparklines on the agent detail page.
router.get("/:id/metrics/history", requireAdmin, async (req, res) => {
  const agent = await dbOps.get("SELECT id FROM agents WHERE id = ?", [req.params.id]);
  if (!agent || !(await applyAgentFilters(agent, req))) {
    res.status(404).json({ error: "Agent not found" });
    return;
  }
  const requested = Number.parseInt(req.query.hours, 10);
  const hours = Number.isFinite(requested)
    ? Math.min(Math.max(requested, 1), METRICS_MAX_HOURS)
    : 24;
  const since = new Date(Date.now() - hours * 3600000).toISOString();
  const rows = await dbOps.all(
    `SELECT collected_at, cpu_percent, memory_percent, disk_percent, load_1m
       FROM agent_metrics
      WHERE agent_id = ? AND collected_at >= ?
      ORDER BY collected_at ASC`,
    [req.params.id, since]
  );
  res.json({
    ok: true,
    hours,
    points: rows.map((row) => ({
      at: row.collected_at,
      cpuPercent: row.cpu_percent,
      memoryPercent: row.memory_percent,
      diskPercent: row.disk_percent,
      load1m: row.load_1m
    }))
  });
});

// Fleet health at a glance: averages plus the hosts that actually need action.
router.get("/metrics/summary", requireAdmin, async (req, res) => {
  const allAgents = await dbOps.all(
    "SELECT id, display_name, last_hostname, last_ip, metrics_json, metrics_updated_at FROM agents"
  );
  const agents = [];
  for (const agent of allAgents) {
    if (await applyAgentFilters(agent, req)) agents.push(agent);
  }

  const reporting = [];
  const pressure = { cpu: [], memory: [], disk: [] };

  for (const agent of agents) {
    const summary = summarizeMetrics(agent.metrics_json, agent.metrics_updated_at);
    if (!summary) continue;
    const label = agent.display_name || agent.last_hostname || agent.id;
    reporting.push(summary);

    const entry = { id: agent.id, name: label, hostname: agent.last_hostname };
    if (summary.cpuPercent !== null && summary.cpuPercent >= PRESSURE_CPU_PERCENT) {
      pressure.cpu.push({ ...entry, value: summary.cpuPercent });
    }
    if (summary.memoryPercent !== null && summary.memoryPercent >= PRESSURE_MEMORY_PERCENT) {
      pressure.memory.push({ ...entry, value: summary.memoryPercent });
    }
    // Use the fullest volume, not "/": that is the one that will break first.
    const diskPercent = summary.busiestDiskPercent ?? summary.diskPercent;
    if (diskPercent !== null && diskPercent >= PRESSURE_DISK_PERCENT) {
      pressure.disk.push({ ...entry, value: diskPercent, mount: summary.busiestDiskMount });
    }
  }

  const average = (key) => {
    const values = reporting.map((m) => m[key]).filter((v) => v !== null && v !== undefined);
    if (values.length === 0) return null;
    return Math.round((values.reduce((sum, v) => sum + v, 0) / values.length) * 10) / 10;
  };

  res.json({
    ok: true,
    totalAgents: agents.length,
    reportingAgents: reporting.length,
    averages: {
      cpuPercent: average("cpuPercent"),
      memoryPercent: average("memoryPercent"),
      diskPercent: average("diskPercent")
    },
    thresholds: {
      cpuPercent: PRESSURE_CPU_PERCENT,
      memoryPercent: PRESSURE_MEMORY_PERCENT,
      diskPercent: PRESSURE_DISK_PERCENT
    },
    pressure: {
      cpu: pressure.cpu.sort((a, b) => b.value - a.value),
      memory: pressure.memory.sort((a, b) => b.value - a.value),
      disk: pressure.disk.sort((a, b) => b.value - a.value)
    }
  });
});

// ---------------------------------------------------------------------------
//  Fleet-wide ("Tout") package aggregation
// ---------------------------------------------------------------------------

// Queue PACKAGES_LIST on every agent so the fleet view has fresh
// installed-package data. Agents with a pending command are skipped.
// NOTE: the agent serializes commands (one at a time), so we enqueue a single
// command per agent here. CHECK_UPDATES is triggered separately via the
// existing `/commands/check-updates-all` endpoint once the list scan completes.
router.post("/packages/scan-all", requireAdmin, async (req, res) => {
  const allAgents = await dbOps.all("SELECT id FROM agents");
  const agents = [];
  for (const agent of allAgents) {
    if (await applyAgentFilters(agent, req)) agents.push(agent);
  }
  const results = await Promise.all(
    agents.map(async (a) => {
      const list = await createCommand(a.id, "PACKAGES_LIST", null, req);
      return {
        id: a.id,
        commandId: list.error ? null : list.id,
        error: list.error || null
      };
    })
  );
  res.json({
    ok: true,
    queued: results.filter((r) => r.commandId).length,
    results
  });
});

// Read-only: aggregate installed packages and available updates across all
// agents from the persisted scan results (packages_json / pending_updates_json).
router.get("/packages/all", requireAdmin, async (req, res) => {
  const allAgents = await dbOps.all("SELECT * FROM agents");
  const agents = [];
  for (const agent of allAgents) {
    if (await applyAgentFilters(agent, req)) agents.push(agent);
  }

  const installedByPkg = new Map(); // name -> { name, versions:Set, agents:[{id,name,hostname,ip}] }
  const updatesByPkg = new Map(); // name -> { name, detail, agents:[...] }

  let scannedForInstalled = 0;
  let scannedForUpdates = 0;

  for (const agent of agents) {
    const id = agent.id;
    const label = agent.display_name || agent.last_hostname || id;

    // Installed packages — a machine is "scanned" once a result is persisted,
    // even if the list is empty.
    if (agent.packages_json) {
      scannedForInstalled += 1;
      let pkgs;
      try { pkgs = JSON.parse(agent.packages_json); } catch { pkgs = null; }
      if (pkgs && Array.isArray(pkgs.packages)) {
        for (const p of pkgs.packages) {
          const name = p.name;
          if (!installedByPkg.has(name)) {
            installedByPkg.set(name, { name, versions: new Set(), agents: [] });
          }
          const entry = installedByPkg.get(name);
          if (p.version) entry.versions.add(p.version);
          entry.agents.push({ id, name: label, hostname: agent.last_hostname, ip: agent.last_ip });
        }
      }
    }

    // Available updates — updates_checked_at marks a completed CHECK_UPDATES,
    // which is more reliable than pending_updates_json (cleared after updates).
    if (agent.updates_checked_at) {
      scannedForUpdates += 1;
    }
    if (agent.pending_updates_json) {
      let ups;
      try { ups = JSON.parse(agent.pending_updates_json); } catch { ups = null; }
      if (ups && Array.isArray(ups.updates)) {
        for (const u of ups.updates) {
          const name = u.name;
          if (!updatesByPkg.has(name)) {
            updatesByPkg.set(name, {
              name,
              detail: u.detail || "",
              // A package is flagged security-relevant as soon as ONE host
              // reports it from a security channel: the same version can be in
              // -security on one distro release and plain -updates on another,
              // and under-reporting a security fix is the costlier mistake.
              security: false,
              versions: new Set(),
              sources: new Set(),
              agents: []
            });
          }
          const entry = updatesByPkg.get(name);
          if (u.security) entry.security = true;
          if (!entry.detail && u.detail) entry.detail = u.detail;
          if (u.newVersion) entry.versions.add(u.newVersion);
          if (u.source) entry.sources.add(u.source);
          entry.agents.push({
            id,
            name: label,
            hostname: agent.last_hostname,
            ip: agent.last_ip,
            security: Boolean(u.security),
            version: u.version || null,
            newVersion: u.newVersion || null
          });
        }
      }
    }
  }

  const installed = Array.from(installedByPkg.values())
    .map((e) => ({
      name: e.name,
      versions: Array.from(e.versions),
      count: e.agents.length,
      agents: e.agents
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const updates = Array.from(updatesByPkg.values())
    .map((e) => ({
      name: e.name,
      detail: e.detail,
      security: e.security,
      newVersions: Array.from(e.versions),
      sources: Array.from(e.sources),
      count: e.agents.length,
      agents: e.agents
    }))
    // Security first, then by blast radius (how many hosts are affected), then
    // alphabetically. This is the order an operator patches in.
    .sort((a, b) => {
      if (a.security !== b.security) return a.security ? -1 : 1;
      if (a.count !== b.count) return b.count - a.count;
      return a.name.localeCompare(b.name);
    });

  const securityUpdates = updates.filter((u) => u.security);
  const agentsWithSecurityUpdates = new Set();
  for (const update of securityUpdates) {
    for (const agent of update.agents) {
      if (agent.security) agentsWithSecurityUpdates.add(agent.id);
    }
  }
  const agentsWithAnyUpdate = new Set();
  for (const update of updates) {
    for (const agent of update.agents) agentsWithAnyUpdate.add(agent.id);
  }

  res.json({
    ok: true,
    installed,
    updates,
    stats: {
      totalAgents: agents.length,
      scannedForInstalled,
      scannedForUpdates,
      totalUpdates: updates.length,
      securityUpdates: securityUpdates.length,
      agentsWithUpdates: agentsWithAnyUpdate.size,
      agentsWithSecurityUpdates: agentsWithSecurityUpdates.size,
      totalInstalled: installed.length
    }
  });
});

// Mutating: apply an update to a package on every agent that reports it as
// available. Requires per-agent opt-in; agents without opt-in are skipped.
router.post("/packages/bulk-update", requireAdmin, async (req, res) => {
  const names = Array.isArray(req.body?.names) ? req.body.names : [];
  if (names.length === 0) {
    res.status(400).json({ error: "No packages selected" });
    return;
  }
  // A single unsupported name must not cancel the whole batch. These names come
  // from what the agents themselves reported, and one odd entry (a protected
  // package, or a manager whose output we cannot parse into a clean name) used
  // to abort the entire fleet update with a 400 — nothing got patched at all.
  const clean = [];
  const rejected = [];
  for (const n of names) {
    const check = validatePackageName(n);
    if (check.ok) {
      clean.push(check.name);
    } else {
      rejected.push({ name: String(n).slice(0, 120), reason: check.error });
    }
  }
  if (clean.length === 0) {
    res.status(400).json({
      error: "None of the selected packages can be updated remotely",
      rejected
    });
    return;
  }

  // Package management is an explicit per-agent opt-in, OFF by default. Agents
  // without it are skipped — but they must be COUNTED and reported, otherwise
  // the caller just sees "0 machines queued" with no way to know why.
  const candidates = await dbOps.all(
    "SELECT id, display_name, last_hostname, COALESCE(packages_enabled, 0) AS packages_enabled, pending_updates_json FROM agents"
  );
  const agents = [];
  for (const agent of candidates) {
    if (await applyAgentFilters(agent, req)) agents.push(agent);
  }

  const results = [];
  const skipped = { packagesDisabled: [], notReported: [] };

  for (const agent of agents) {
    const label = agent.display_name || agent.last_hostname || agent.id;

    if (Number(agent.packages_enabled) !== 1) {
      skipped.packagesDisabled.push({ id: agent.id, name: label });
      results.push({ id: agent.id, queued: false, reason: "packages-disabled" });
      continue;
    }

    // Only queue the subset of selected packages that THIS agent reports as
    // outdated. Sending a package the agent doesn't know about (or doesn't have
    // installed) would fail its update command.
    let reportedNames = [];
    if (agent.pending_updates_json) {
      try {
        const parsed = JSON.parse(agent.pending_updates_json);
        if (Array.isArray(parsed.updates)) {
          reportedNames = parsed.updates
            .map((u) => u.name)
            .filter((name) => clean.includes(name));
        }
      } catch { /* ignore */ }
    }
    if (reportedNames.length === 0) {
      skipped.notReported.push({ id: agent.id, name: label });
      results.push({ id: agent.id, queued: false, reason: "not-reported" });
      continue;
    }

    const r = await createCommand(agent.id, "UPDATE_PACKAGES", { names: reportedNames }, req);
    results.push({ id: agent.id, queued: Boolean(r.id), error: r.error || null });
  }

  res.json({
    ok: true,
    queued: results.filter((r) => r.queued).length,
    totalAgents: agents.length,
    requested: names.length,
    accepted: clean.length,
    rejected,
    skipped: {
      packagesDisabled: skipped.packagesDisabled.length,
      notReported: skipped.notReported.length,
      packagesDisabledAgents: skipped.packagesDisabled.slice(0, 20),
      notReportedAgents: skipped.notReported.slice(0, 20)
    },
    results
  });
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

// Read-only: always allowed (reading antivirus health).
router.post("/:id/antivirus/status", requireAdmin, async (req, res) => {
  const result = await createCommand(req.params.id, "ANTIVIRUS_STATUS", null, req);
  if (result.error) {
    res.status(result.status).json({ error: result.error });
    return;
  }
  res.json({ ok: true, commandId: result.id });
});

// Starting a scan only reads files — it never installs or removes anything —
// so it is not behind the package opt-in. It is expensive, though: a full scan
// runs for hours, which is why the poll route gives it a longer stale window.
router.post("/:id/antivirus/scan", requireAdmin, async (req, res) => {
  const payload = { scanType: req.body?.scanType || "quick" };
  if (req.body?.path) {
    payload.path = req.body.path;
  }
  const result = await createCommand(req.params.id, "ANTIVIRUS_SCAN", payload, req);
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
  // AAUL-Cloud: isolation multi-tenant — même réponse pour agent inexistant
  // ou non autorisé (pas de fuite d'information).
  if (!(await applyAgentFilters(agent, req))) {
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

// Ask a host to enforce the log-retention policy immediately, rather than
// waiting for its next hourly pass. The policy itself comes from the dashboard
// settings, so an operator cannot prune with ad-hoc values from this button.
router.post("/:id/commands/prune-logs", requireAdmin, async (req, res) => {
  const retentionDays = Number.parseInt(await getSetting("logRetentionDays"), 10);
  const maxTotalMb = Number.parseInt(await getSetting("logMaxTotalMb"), 10);
  const payload = {
    retentionDays: Number.isFinite(retentionDays) ? retentionDays : 30,
    maxTotalMb: Number.isFinite(maxTotalMb) ? maxTotalMb : 200
  };
  await queueCommand(req, res, "PRUNE_LOGS", payload);
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
  // AAUL-Cloud: isolation multi-tenant avant d'annuler la commande d'un agent
  const agent = await dbOps.get("SELECT id FROM agents WHERE id = ?", [req.params.id]);
  if (!agent || !(await applyAgentFilters(agent, req))) {
    res.status(404).json({ error: "Agent not found" });
    return;
  }
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
  // AAUL-Cloud: isolation multi-tenant avant de lister les commandes d'un agent
  const agent = await dbOps.get("SELECT id FROM agents WHERE id = ?", [req.params.id]);
  if (!agent || !(await applyAgentFilters(agent, req))) {
    res.status(404).json({ error: "Agent not found" });
    return;
  }
  const limit = Math.min(Number.parseInt(req.query.limit, 10) || 50, 200);
  const commands = await dbOps.all(
    "SELECT * FROM commands WHERE agent_id = ? ORDER BY created_at DESC LIMIT ?",
    [req.params.id, limit]
  );
  res.json({ ok: true, commands: commands.map(serializeCommand) });
});

router.get("/:id/commands/:commandId", requireAdmin, async (req, res) => {
  // AAUL-Cloud: isolation multi-tenant avant de lire une commande d'un agent
  const agent = await dbOps.get("SELECT id FROM agents WHERE id = ?", [req.params.id]);
  if (!agent || !(await applyAgentFilters(agent, req))) {
    res.status(404).json({ error: "Agent not found" });
    return;
  }
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
