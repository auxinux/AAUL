import express from "express";
import crypto from "crypto";
import { v4 as uuidv4 } from "uuid";
import { dbOps } from "../db/index.js";
import { requireAgentAuth } from "../middleware/auth.js";
import { broadcastSSE } from "../utils/sse.js";
import { readVersion } from "./bundle.js";
import { notifyEvent } from "../utils/notifications.js";
import { recordAuditEvent } from "../utils/audit.js";
import config from "../config.js";
import { getSetting } from "../utils/settings.js";
import { validateCommandPayload } from "../utils/command-policy.js";
import { compareVersions } from "../utils/update-check.js";

const router = express.Router();

// Merge a finished scan into the stored antivirus snapshot. The scan itself
// knows what it found; everything else (product, signatures, real-time state)
// comes from the last ANTIVIRUS_STATUS and must survive untouched.
async function mergeAntivirusScan(agentId, scan, now) {
  const row = await dbOps.get("SELECT antivirus_json FROM agents WHERE id = ?", [agentId]);
  let snapshot = null;
  try {
    snapshot = JSON.parse(row?.antivirus_json || "null");
  } catch {
    snapshot = null;
  }
  if (!snapshot || typeof snapshot !== "object") {
    // No status was ever collected — keep the scan alone rather than inventing
    // health fields the agent never reported.
    snapshot = {};
  }

  const threatCount = Number(scan.threatsFound) || 0;
  const merged = {
    ...snapshot,
    lastScanAt: scan.finishedAt || now,
    lastScanType: scan.scanType || null,
    lastScanThreats: threatCount,
    lastScanFilesScanned: scan.filesScanned ?? null,
    threatsFound: threatCount,
    threats: Array.isArray(scan.threats) ? scan.threats : []
  };
  // The agent owns the health verdict; the only thing a scan can change about
  // it is to make it worse. `issues` is left as the agent last wrote it and is
  // rewritten wholesale by the next ANTIVIRUS_STATUS.
  if (threatCount > 0) {
    merged.healthy = false;
  }
  await dbOps.run(
    "UPDATE agents SET antivirus_json = ?, antivirus_checked_at = ? WHERE id = ?",
    [JSON.stringify(merged), now, agentId]
  );
}

// Automatic antivirus checks run hourly, and only on agents that know the
// command — ANTIVIRUS_STATUS shipped with agent 0.11.0.
const ANTIVIRUS_CHECK_INTERVAL_MS = 60 * 60 * 1000;
const ANTIVIRUS_MIN_AGENT_VERSION = "0.11.0";

function antivirusCheckDue(agent, agentVersion, nowMs) {
  // NULL means "not decided yet", which is exactly when the discovery check
  // must run — so only an explicit 0 turns the schedule off.
  const autoCheck = agent.antivirus_auto_check;
  if (autoCheck !== null && autoCheck !== undefined && Number(autoCheck) === 0) {
    return false;
  }
  if (!agentVersion || compareVersions(agentVersion, ANTIVIRUS_MIN_AGENT_VERSION) < 0) {
    return false;
  }
  // A manual check or a scan counts too: no point re-checking right after one.
  const last = Math.max(
    Date.parse(agent.antivirus_attempted_at || "") || 0,
    Date.parse(agent.antivirus_checked_at || "") || 0
  );
  return nowMs - last >= ANTIVIRUS_CHECK_INTERVAL_MS;
}

// Sign every JSON response to the agent so that clients which require signed
// responses (HMAC over the raw body keyed by the agent token) accept them.
// Agents that do not check these headers simply ignore them. This is applied
// after requireAgentAuth runs, so req.agentAuthToken (plaintext token) is set
// by the time a handler calls res.json().
function signAgentResponses(req, res, next) {
  const originalJson = res.json.bind(res);
  res.json = (payload) => {
    const token = req.agentAuthToken;
    if (!token) {
      return originalJson(payload);
    }
    const body = JSON.stringify(payload);
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const nonce = crypto.randomBytes(16).toString("hex");
    const signature = crypto
      .createHmac("sha256", token)
      .update(`${timestamp}.${nonce}.${body}`)
      .digest("hex");
    res.setHeader("X-Response-Signature", signature);
    res.setHeader("X-Response-Timestamp", timestamp);
    res.setHeader("X-Response-Nonce", nonce);
    res.type("application/json").send(body);
    return res;
  };
  next();
}

router.use(signAgentResponses);

function parsePayload(payloadJson) {
  if (!payloadJson) {
    return null;
  }
  try {
    return JSON.parse(payloadJson);
  } catch {
    return null;
  }
}

async function createImmediateCommand(agentId, type, payload, now) {
  const source = payload?.triggeredBy || "SYSTEM";
  const commandPayload = payload && typeof payload === "object" && !Array.isArray(payload)
    ? Object.fromEntries(Object.entries(payload).filter(([key]) => key !== "triggeredBy"))
    : payload;
  const policy = validateCommandPayload(type, commandPayload);
  if (!policy.ok) {
    throw new Error(policy.error);
  }
  const commandId = uuidv4();
  await dbOps.run(
    `INSERT INTO commands (
      id,
      agent_id,
      type,
      payload_json,
      status,
      created_at,
      updated_at,
      started_at,
      attempt_count,
      source,
      correlation_id
    ) VALUES (?, ?, ?, ?, 'IN_PROGRESS', ?, ?, ?, 1, ?, ?)`,
    [
      commandId,
      agentId,
      type,
      policy.payload ? JSON.stringify(policy.payload) : null,
      now,
      now,
      now,
      source,
      uuidv4()
    ]
  );
  await recordAuditEvent({
    action: "command.auto_created",
    entityType: "command",
    entityId: commandId,
    agentId,
    details: { type, payload: policy.payload }
  });
  return {
    id: commandId,
    type,
    payload: policy.payload
  };
}

function displayAgentName(agent) {
  return agent.display_name || agent.last_hostname || agent.id;
}

async function notifyCommandTransition(agent, command, finalStatus, result, errorMessage) {
  const commandType = command.type;
  const name = displayAgentName(agent);
  const failed = finalStatus === "ERROR";

  if (failed) {
    await notifyEvent("other", {
      key: `command-failed:${command.id}`,
      subject: `AAUL - commande echouee : ${name}`,
      text: `${commandType} a echoue sur ${name}. Erreur: ${errorMessage || "inconnue"}.`
    });
    return;
  }

  if (commandType === "UPDATE_AGENT") {
    await notifyEvent("other", {
      key: `agent-updated:${command.id}`,
      subject: `AAUL - agent mis a jour : ${name}`,
      text: `${name} a applique la mise a jour agent${result?.version ? ` vers ${result.version}` : ""}.`
    });
  } else if (commandType === "UNINSTALL") {
    await notifyEvent("other", {
      key: `agent-uninstalled:${command.id}`,
      subject: `AAUL - agent desinstalle : ${name}`,
      text: `${name} a confirme sa desinstallation.`
    });
  }
}

// How often a poll sample is written to `agent_metrics`. Polls arrive every
// 15-60 s; storing each one would bloat the DB without adding visible detail to
// a sparkline, so we keep one point per 5-minute window per agent.
const METRICS_SAMPLE_INTERVAL_MS = 5 * 60 * 1000;

// Metric history older than this is discarded. Pruning runs opportunistically
// (roughly once an hour, on whichever poll happens to land first) rather than
// on a timer, so it costs nothing when no agent is reporting.
const DEFAULT_METRICS_RETENTION_DAYS = 30;
const METRICS_PRUNE_INTERVAL_MS = 60 * 60 * 1000;
let lastMetricsPruneAt = 0;

function finiteOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/**
 * Normalize the metrics block sent by the agent.
 *
 * The agent reports a failed probe as null rather than crashing, and an old
 * agent reports nothing at all — both must round-trip to a stored null instead
 * of a zero, so the UI can say "unknown" instead of lying with "0%".
 */
function normalizeMetrics(raw) {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const disk = raw.disk || {};
  return {
    collectedAt: typeof raw.collectedAt === "string" ? raw.collectedAt : null,
    cpuPercent: finiteOrNull(raw.cpuPercent),
    cpuCount: finiteOrNull(raw.cpuCount),
    loadAverage: raw.loadAverage && typeof raw.loadAverage === "object"
      ? {
          "1m": finiteOrNull(raw.loadAverage["1m"]),
          "5m": finiteOrNull(raw.loadAverage["5m"]),
          "15m": finiteOrNull(raw.loadAverage["15m"])
        }
      : null,
    memory: raw.memory && typeof raw.memory === "object"
      ? {
          percent: finiteOrNull(raw.memory.percent),
          totalBytes: finiteOrNull(raw.memory.totalBytes),
          usedBytes: finiteOrNull(raw.memory.usedBytes),
          availableBytes: finiteOrNull(raw.memory.availableBytes)
        }
      : null,
    swap: raw.swap && typeof raw.swap === "object"
      ? {
          percent: finiteOrNull(raw.swap.percent),
          totalBytes: finiteOrNull(raw.swap.totalBytes),
          usedBytes: finiteOrNull(raw.swap.usedBytes)
        }
      : null,
    disk: {
      root: normalizeDiskEntry(disk.root),
      busiest: normalizeDiskEntry(disk.busiest)
    },
    processCount: finiteOrNull(raw.processCount),
    loggedInUsers: finiteOrNull(raw.loggedInUsers)
  };
}

function normalizeDiskEntry(entry) {
  if (!entry || typeof entry !== "object") {
    return null;
  }
  return {
    mount: typeof entry.mount === "string" ? entry.mount.slice(0, 260) : null,
    percent: finiteOrNull(entry.percent),
    totalBytes: finiteOrNull(entry.totalBytes),
    usedBytes: finiteOrNull(entry.usedBytes),
    freeBytes: finiteOrNull(entry.freeBytes)
  };
}

function normalizeLogStats(raw) {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  return {
    fileCount: finiteOrNull(raw.fileCount),
    totalBytes: finiteOrNull(raw.totalBytes),
    oldest: typeof raw.oldest === "string" ? raw.oldest : null,
    newest: typeof raw.newest === "string" ? raw.newest : null
  };
}

/** Append a history point if the sampling window has elapsed, then prune. */
async function recordMetricsHistory(agentId, metrics, now) {
  if (!metrics) {
    return;
  }
  const last = await dbOps.get(
    "SELECT collected_at FROM agent_metrics WHERE agent_id = ? ORDER BY collected_at DESC LIMIT 1",
    [agentId]
  );
  if (last) {
    const elapsed = now.getTime() - new Date(last.collected_at).getTime();
    if (Number.isFinite(elapsed) && elapsed < METRICS_SAMPLE_INTERVAL_MS) {
      return;
    }
  }
  await dbOps.run(
    `INSERT INTO agent_metrics (agent_id, collected_at, cpu_percent, memory_percent, disk_percent, load_1m)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      agentId,
      now.toISOString(),
      metrics.cpuPercent,
      metrics.memory?.percent ?? null,
      metrics.disk?.root?.percent ?? null,
      metrics.loadAverage?.["1m"] ?? null
    ]
  );

  if (now.getTime() - lastMetricsPruneAt < METRICS_PRUNE_INTERVAL_MS) {
    return;
  }
  lastMetricsPruneAt = now.getTime();
  const retentionDays = await readMetricsRetentionDays();
  const cutoff = new Date(now.getTime() - retentionDays * 86400000).toISOString();
  await dbOps.run("DELETE FROM agent_metrics WHERE collected_at < ?", [cutoff]);
}

async function readMetricsRetentionDays() {
  const value = Number.parseInt(await getSetting("metricsRetentionDays"), 10);
  if (Number.isFinite(value) && value >= 1 && value <= 3650) {
    return value;
  }
  return DEFAULT_METRICS_RETENTION_DAYS;
}

/** Retention policy pushed to the agent so it prunes its own log directory. */
async function buildLogsConfig() {
  const retentionDays = Number.parseInt(await getSetting("logRetentionDays"), 10);
  const maxTotalMb = Number.parseInt(await getSetting("logMaxTotalMb"), 10);
  return {
    retentionDays:
      Number.isFinite(retentionDays) && retentionDays >= 1 && retentionDays <= 3650
        ? retentionDays
        : DEFAULT_LOG_RETENTION_DAYS,
    maxTotalMb:
      Number.isFinite(maxTotalMb) && maxTotalMb >= 1 && maxTotalMb <= 100000
        ? maxTotalMb
        : DEFAULT_LOG_MAX_TOTAL_MB
  };
}

// Conservative defaults: 30 days or 200 MB of agent logs, whichever comes first.
// Chosen so an untouched install stops growing without silently discarding the
// history an admin is likely to need after an incident.
const DEFAULT_LOG_RETENTION_DAYS = 30;
const DEFAULT_LOG_MAX_TOTAL_MB = 200;

router.post("/poll", requireAgentAuth, async (req, res) => {
  const body = req.body || {};
  if (!body.agentId || body.agentId !== req.agent.id) {
    res.status(401).json({ error: "Invalid agent" });
    return;
  }
  const now = new Date().toISOString();
  const schedule = body.schedule || {};
  const uptimeSeconds = Number.parseInt(body.uptimeSeconds, 10);
  const uptimeValue = Number.isFinite(uptimeSeconds) ? uptimeSeconds : null;
  const rebootRequired =
    typeof body.rebootRequired === "boolean" ? (body.rebootRequired ? 1 : 0) : null;
  const metrics = normalizeMetrics(body.metrics);
  const logStats = normalizeLogStats(body.logStats);
  await dbOps.run(
    `UPDATE agents SET
      last_hostname = ?,
      last_ip = ?,
      last_seen_at = ?,
      last_run_at = ?,
      last_status = ?,
      last_exit_code = ?,
      last_duration_seconds = ?,
      schedule_enabled = ?,
      schedule_daily_time = ?,
      agent_version = ?,
      uptime_seconds = ?,
      reboot_required = ?,
      metrics_json = COALESCE(?, metrics_json),
      metrics_updated_at = COALESCE(?, metrics_updated_at),
      log_stats_json = COALESCE(?, log_stats_json)
     WHERE id = ?`,
    [
      body.hostname || null,
      body.ip || null,
      body.lastSeenAt || now,
      body.lastRunAt || null,
      body.lastStatus || null,
      body.lastExitCode ?? null,
      body.lastDurationSeconds ?? null,
      schedule.enabled ? 1 : 0,
      schedule.dailyTime || null,
      body.agentVersion || null,
      uptimeValue,
      rebootRequired,
      metrics ? JSON.stringify(metrics) : null,
      metrics ? now : null,
      logStats ? JSON.stringify(logStats) : null,
      req.agent.id
    ]
  );

  // History is best-effort: a failure here must not fail the heartbeat, or a
  // full disk would take the whole fleet offline in the dashboard's eyes.
  try {
    await recordMetricsHistory(req.agent.id, metrics, new Date(now));
  } catch (err) {
    console.error("[metrics] history write failed:", err?.message || err);
  }

  // Notify connected dashboard browsers in real-time
  broadcastSSE("agent:update", { agentId: req.agent.id });

  const skipCommand = req.headers["x-skip-command"] === "true";
  if (skipCommand) {
    res.json({ ok: true, command: null });
    return;
  }

  const latestAgentVersion = readVersion();
  const currentAgentVersion = body.agentVersion || req.agent.agent_version || null;

  // Get agent's local web settings
  const agentSettings = await dbOps.get(
    "SELECT local_web_enabled, local_web_port, packages_enabled FROM agents WHERE id = ?",
    [req.agent.id]
  );
  const logsConfig = await buildLogsConfig();
  const localWebConfig = {
    enabled: agentSettings?.local_web_enabled === 1,
    port: agentSettings?.local_web_port || 8180,
    packagesEnabled: agentSettings?.packages_enabled === 1
  };

  // A command stays IN_PROGRESS while the agent executes it (an update can take
  // several minutes, during which the poller keeps polling). We only fail it when
  // it has been stuck well beyond any plausible execution time, to avoid killing
  // a command that is still legitimately running.
  const STALE_COMMAND_MS = 30 * 60 * 1000;
  // A full antivirus scan legitimately runs for hours. Failing it at 30 minutes
  // would report a timeout on a machine that is still busy scanning.
  const STALE_ANTIVIRUS_SCAN_MS = 8 * 60 * 60 * 1000;
  const inProgress = await dbOps.get(
    "SELECT id, type, updated_at FROM commands WHERE agent_id = ? AND status = 'IN_PROGRESS' ORDER BY updated_at DESC LIMIT 1",
    [req.agent.id]
  );
  if (inProgress) {
    const startedAt = Date.parse(inProgress.updated_at);
    const staleAfter =
      inProgress.type === "ANTIVIRUS_SCAN" ? STALE_ANTIVIRUS_SCAN_MS : STALE_COMMAND_MS;
    const isStale = Number.isFinite(startedAt) && Date.now() - startedAt > staleAfter;
    if (isStale) {
      const updatedAt = new Date().toISOString();
      await dbOps.run(
        "UPDATE commands SET status = 'ERROR', error_message = ?, updated_at = ? WHERE id = ?",
        ["Command timed out before completion", updatedAt, inProgress.id]
      );
      await recordAuditEvent({
        action: "command.timeout",
        entityType: "command",
        entityId: inProgress.id,
        agentId: req.agent.id,
        details: { type: inProgress.type }
      });
      await notifyEvent("other", {
        key: `command-stuck:${inProgress.id}`,
        subject: `AAUL - commande bloquee : ${displayAgentName(req.agent)}`,
        text: `${inProgress.type} sur ${displayAgentName(req.agent)} a depasse le delai d'execution.`
      });
    } else {
      // A command is still legitimately running. Do not hand out or create
      // another one; let the agent complete it.
      res.json({ ok: true, command: null, localWeb: localWebConfig, logs: logsConfig, latestAgentVersion });
      return;
    }
  }

  const queued = await dbOps.get(
    "SELECT * FROM commands WHERE agent_id = ? AND status = 'QUEUED' ORDER BY created_at ASC LIMIT 1",
    [req.agent.id]
  );
  if (!queued) {
    if (
      config.agentAutoUpdateEnabled &&
      currentAgentVersion &&
      latestAgentVersion &&
      currentAgentVersion !== latestAgentVersion
    ) {
      const latestUpdateCommand = await dbOps.get(
        "SELECT status, payload_json FROM commands WHERE agent_id = ? AND type = 'UPDATE_AGENT' ORDER BY created_at DESC LIMIT 1",
        [req.agent.id]
      );
      const latestUpdatePayload = parsePayload(latestUpdateCommand?.payload_json);
      const alreadyFailedSameTarget =
        latestUpdateCommand?.status === "ERROR" &&
        latestUpdatePayload?.version === latestAgentVersion;

      if (!alreadyFailedSameTarget) {
        const command = await createImmediateCommand(
          req.agent.id,
          "UPDATE_AGENT",
          {
            version: latestAgentVersion,
            triggeredBy: "AUTO_ON_POLL"
          },
          now
        );
        res.json({
          ok: true,
          localWeb: localWebConfig, logs: logsConfig,
          latestAgentVersion,
          command
        });
        return;
      }
    }

    const pendingPoll = Number.parseInt(req.agent.pending_poll_interval_seconds, 10);
    if (Number.isFinite(pendingPoll) && pendingPoll > 0) {
      const payload = { pollIntervalSeconds: pendingPoll };
      const command = await createImmediateCommand(
        req.agent.id,
        "SET_POLL_INTERVAL",
        payload,
        now
      );
      await dbOps.run(
        "UPDATE agents SET pending_poll_interval_seconds = NULL WHERE id = ?",
        [req.agent.id]
      );
      res.json({
        ok: true,
        localWeb: localWebConfig, logs: logsConfig,
        latestAgentVersion,
        command
      });
      return;
    }
    // The hourly antivirus check — and the one-time discovery that decides its
    // default — is handed out here rather than queued: it never waits for a
    // poll cycle, and holds the command slot only while it actually runs.
    // Turning antivirus monitoring off in Admin stops both. The setting is only
    // read once a check is due, so an idle poll costs no extra query.
    if (
      antivirusCheckDue(req.agent, currentAgentVersion, Date.now()) &&
      (await getSetting("antivirusMonitoringEnabled")) !== "false"
    ) {
      const command = await createImmediateCommand(req.agent.id, "ANTIVIRUS_STATUS", null, now);
      await dbOps.run("UPDATE agents SET antivirus_attempted_at = ? WHERE id = ?", [now, req.agent.id]);
      res.json({ ok: true, localWeb: localWebConfig, logs: logsConfig, latestAgentVersion, command });
      return;
    }
    res.json({ ok: true, command: null, localWeb: localWebConfig, logs: logsConfig, latestAgentVersion });
    return;
  }

  const updatedAt = new Date().toISOString();
  const queuedPayload = parsePayload(queued.payload_json);
  const policy = validateCommandPayload(queued.type, queuedPayload);
  if (!policy.ok) {
    await dbOps.run(
      "UPDATE commands SET status = 'ERROR', error_message = ?, updated_at = ?, completed_at = ? WHERE id = ?",
      [`Rejected by command policy: ${policy.error}`, updatedAt, updatedAt, queued.id]
    );
    await recordAuditEvent({
      action: "command.rejected",
      entityType: "command",
      entityId: queued.id,
      agentId: req.agent.id,
      details: { type: queued.type, error: policy.error }
    });
    broadcastSSE("command:update", { agentId: req.agent.id, commandId: queued.id });
    res.json({ ok: true, command: null, localWeb: localWebConfig, logs: logsConfig, latestAgentVersion });
    return;
  }
  await dbOps.run(
    "UPDATE commands SET status = 'IN_PROGRESS', updated_at = ?, started_at = COALESCE(started_at, ?), attempt_count = COALESCE(attempt_count, 0) + 1 WHERE id = ?",
    [updatedAt, updatedAt, queued.id]
  );
  await recordAuditEvent({
    action: "command.started",
    entityType: "command",
    entityId: queued.id,
    agentId: req.agent.id,
    details: { type: queued.type }
  });
  broadcastSSE("command:update", { agentId: req.agent.id, commandId: queued.id });

  res.json({
    ok: true,
    localWeb: localWebConfig, logs: logsConfig,
    latestAgentVersion,
    command: {
      id: queued.id,
      type: queued.type,
      payload: policy.payload
    }
  });
});

router.post("/command-result", requireAgentAuth, async (req, res) => {
  const body = req.body || {};
  if (!body.agentId || body.agentId !== req.agent.id) {
    res.status(401).json({ error: "Invalid agent" });
    return;
  }
  if (!body.commandId) {
    res.status(400).json({ error: "Missing commandId" });
    return;
  }
  const command = await dbOps.get(
    "SELECT id, type FROM commands WHERE id = ? AND agent_id = ?",
    [body.commandId, req.agent.id]
  );
  if (!command) {
    res.status(404).json({ error: "Command not found" });
    return;
  }
  const now = new Date().toISOString();
  const finalStatus = body.status || "DONE";
  await dbOps.run(
    "UPDATE commands SET status = ?, result_json = ?, error_message = ?, updated_at = ?, completed_at = ? WHERE id = ? AND agent_id = ?",
    [
      finalStatus,
      body.result ? JSON.stringify(body.result) : null,
      body.errorMessage || null,
      now,
      now,
      body.commandId,
      req.agent.id
    ]
  );
  await recordAuditEvent({
    action: finalStatus === "ERROR" ? "command.failed" : "command.completed",
    entityType: "command",
    entityId: body.commandId,
    agentId: req.agent.id,
    details: {
      type: command.type,
      status: finalStatus,
      errorMessage: body.errorMessage || null
    }
  });
  if (command.type === "FETCH_INFO" && finalStatus !== "ERROR" && body.result) {
    await dbOps.run(
      "UPDATE agents SET last_info_json = ?, last_info_updated_at = ? WHERE id = ?",
      [JSON.stringify(body.result), now, req.agent.id]
    );
  }
  if (command.type === "CHECK_UPDATES" && finalStatus !== "ERROR" && body.result) {
    await dbOps.run(
      "UPDATE agents SET pending_updates_json = ?, updates_checked_at = ? WHERE id = ?",
      [JSON.stringify(body.result), now, req.agent.id]
    );
    broadcastSSE("agent:update", { agentId: req.agent.id });
  }
  if (command.type === "PACKAGES_LIST" && finalStatus !== "ERROR" && body.result) {
    // Persist the last installed-package scan so the fleet-wide "Tout" view can
    // aggregate across machines without re-pinging each one.
    await dbOps.run("UPDATE agents SET packages_json = ? WHERE id = ?", [
      JSON.stringify(body.result),
      req.agent.id
    ]);
    broadcastSSE("agent:update", { agentId: req.agent.id });
  }
  // Enabling real-time protection and installing ClamAV both answer with the
  // resulting status, so they are stored exactly like a status check.
  if (
    ["ANTIVIRUS_STATUS", "ANTIVIRUS_ENABLE_REALTIME", "ANTIVIRUS_INSTALL"].includes(command.type) &&
    finalStatus !== "ERROR" &&
    body.result
  ) {
    await dbOps.run(
      "UPDATE agents SET antivirus_json = ?, antivirus_checked_at = ? WHERE id = ?",
      [JSON.stringify(body.result), now, req.agent.id]
    );
    // The hourly check only makes sense with something to check. No antivirus
    // forces it off, and the toggle stays locked. An antivirus appearing —
    // installed through AAUL, or by hand and then detected — restores the
    // default (on). While an antivirus is present, the operator's choice holds.
    let previous = null;
    try {
      previous = JSON.parse(req.agent.antivirus_json || "null");
    } catch {
      previous = null;
    }
    const appeared = previous !== null && previous.installed === false && body.result.installed;
    const undecided =
      req.agent.antivirus_auto_check === null || req.agent.antivirus_auto_check === undefined;
    if (!body.result.installed) {
      await dbOps.run("UPDATE agents SET antivirus_auto_check = 0 WHERE id = ?", [req.agent.id]);
    } else if (undecided || appeared) {
      await dbOps.run("UPDATE agents SET antivirus_auto_check = 1 WHERE id = ?", [req.agent.id]);
    }
    // Protection is back on: if it lapses again later, that deserves a fresh
    // prompt rather than an old dismissal.
    if (body.result.realtimeEnabled) {
      await dbOps.run("UPDATE agents SET antivirus_realtime_ignored = 0 WHERE id = ?", [req.agent.id]);
    }
    broadcastSSE("agent:update", { agentId: req.agent.id });
  }
  if (command.type === "ANTIVIRUS_SCAN" && finalStatus !== "ERROR" && body.result) {
    // Fold the scan into the stored health snapshot so the fleet view reflects
    // it immediately, instead of waiting for the next status refresh.
    await mergeAntivirusScan(req.agent.id, body.result, now);
    broadcastSSE("agent:update", { agentId: req.agent.id });
  }
  if ((command.type === "UPDATE_PACKAGES" || command.type === "RUN_NOW") && finalStatus !== "ERROR") {
    // Updates were applied — clear the cached list so it refreshes on next check.
    await dbOps.run("UPDATE agents SET pending_updates_json = NULL WHERE id = ?", [req.agent.id]);
  }
  if (command.type === "UPDATE_AGENT" && finalStatus !== "ERROR") {
    const newVersion = body.result?.version || null;
    if (newVersion) {
      await dbOps.run("UPDATE agents SET agent_version = ? WHERE id = ?", [
        newVersion,
        req.agent.id
      ]);
    }
  }
  if (command.type === "UNINSTALL" && finalStatus !== "ERROR") {
    await dbOps.run("DELETE FROM commands WHERE agent_id = ?", [req.agent.id]);
    await dbOps.run("DELETE FROM agents WHERE id = ?", [req.agent.id]);
  }
  // Notify dashboard browsers that agent state has changed
  broadcastSSE("agent:update", { agentId: req.agent.id });
  broadcastSSE("command:update", { agentId: req.agent.id, commandId: body.commandId });
  await notifyCommandTransition(req.agent, command, finalStatus, body.result, body.errorMessage);
  res.json({ ok: true });
});

export default router;
