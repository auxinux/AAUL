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
import { validateCommandPayload } from "../utils/command-policy.js";

const router = express.Router();

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
      reboot_required = ?
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
      req.agent.id
    ]
  );

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
  const inProgress = await dbOps.get(
    "SELECT id, type, updated_at FROM commands WHERE agent_id = ? AND status = 'IN_PROGRESS' ORDER BY updated_at DESC LIMIT 1",
    [req.agent.id]
  );
  if (inProgress) {
    const startedAt = Date.parse(inProgress.updated_at);
    const isStale = Number.isFinite(startedAt) && Date.now() - startedAt > STALE_COMMAND_MS;
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
      res.json({ ok: true, command: null, localWeb: localWebConfig, latestAgentVersion });
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
          localWeb: localWebConfig,
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
        localWeb: localWebConfig,
        latestAgentVersion,
        command
      });
      return;
    }
    res.json({ ok: true, command: null, localWeb: localWebConfig, latestAgentVersion });
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
    res.json({ ok: true, command: null, localWeb: localWebConfig, latestAgentVersion });
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
    localWeb: localWebConfig,
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
