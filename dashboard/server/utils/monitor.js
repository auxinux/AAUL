/**
 * Device down-monitoring watcher.
 *
 * Periodically checks each agent's `last_seen_at` and flips an online/offline
 * state. State changes (and only state changes) trigger a notification and a
 * real-time SSE broadcast, so operators are alerted without being spammed.
 *
 * The whole feature can be toggled at runtime via the `downMonitoringEnabled`
 * setting, and per-agent via the `monitor_enabled` column.
 */
import { dbOps } from "../db/index.js";
import { getSetting } from "./settings.js";
import { broadcastSSE } from "./sse.js";
import { notifyEvent, clearEvent } from "./notifications.js";
import { readVersion } from "../routes/bundle.js";
import config from "../config.js";

const CHECK_INTERVAL_MS = 30 * 1000;
const DEFAULT_THRESHOLD_SECONDS = 120;

let timer = null;

async function resolveThresholdSeconds() {
  const explicit = Number.parseInt(await getSetting("downThresholdSeconds"), 10);
  if (Number.isFinite(explicit) && explicit >= 30) {
    return explicit;
  }
  // Fall back to a few poll cycles so a single missed poll doesn't alert.
  const poll = Number.parseInt(await getSetting("defaultPollSeconds"), 10)
    || Number.parseInt(config.agentDefaultPollSeconds, 10)
    || 15;
  return Math.max(DEFAULT_THRESHOLD_SECONDS, poll * 4);
}

async function setOnlineState(agent, online, now) {
  await dbOps.run(
    "UPDATE agents SET is_online = ?, offline_since = ? WHERE id = ?",
    [online ? 1 : 0, online ? null : now, agent.id]
  );
  broadcastSSE("agent:status", { agentId: agent.id, online });
}

export async function runMonitorCheck() {
  const enabled = (await getSetting("downMonitoringEnabled")) !== "false"; // default ON
  if (!enabled) {
    return;
  }
  const thresholdMs = (await resolveThresholdSeconds()) * 1000;
  const now = new Date().toISOString();
  const nowMs = Date.now();

  const latestVersion = readVersion();

  const agents = await dbOps.all(
    "SELECT id, display_name, last_hostname, last_ip, last_seen_at, is_online, monitor_enabled, agent_version FROM agents"
  );

  for (const agent of agents) {
    // Skip opted-out agents and those that never connected (still installing).
    if (Number(agent.monitor_enabled) === 0) continue;
    if (!agent.last_seen_at) continue;

    const lastSeenMs = Date.parse(agent.last_seen_at);
    if (!Number.isFinite(lastSeenMs)) continue;

    const name = agent.display_name || agent.last_hostname || agent.id;
    const isOffline = nowMs - lastSeenMs > thresholdMs;

    // While an agent is executing a command (e.g. a long system update), its
    // poller is busy and won't check in — that's "busy", not "down". Skip the
    // offline alert to avoid false positives. If it truly died, the command
    // goes stale after STALE_COMMAND_MS and normal monitoring resumes.
    if (isOffline) {
      const busy = await dbOps.get(
        "SELECT 1 AS x FROM commands WHERE agent_id = ? AND status IN ('QUEUED','IN_PROGRESS') LIMIT 1",
        [agent.id]
      );
      if (busy) {
        continue;
      }
    }

    if (isOffline) {
      // Flip to offline once; reset the "back online" dedup so a future
      // recovery notifies again.
      if (agent.is_online === null || agent.is_online === 1) {
        await setOnlineState(agent, false, now);
        clearEvent("deviceUp", agent.id);
      }
      // Fired every tick, but notifyEvent throttles it: once, then at most
      // once per `repeatMinutes` while the problem persists.
      await notifyEvent("deviceDown", {
        key: agent.id,
        subject: `🔴 Agent hors-ligne : ${name}`,
        text: `L'agent « ${name} » (${agent.last_hostname || "?"} / ${agent.last_ip || "?"}) ne répond plus depuis ${agent.last_seen_at || "?"}.`
      });
    } else {
      // Online. If it was offline, announce recovery exactly once.
      if (agent.is_online === 0) {
        await setOnlineState(agent, true, now);
        clearEvent("deviceDown", agent.id);
        await notifyEvent("deviceUp", {
          key: agent.id,
          subject: `✅ Agent en ligne : ${name}`,
          text: `L'agent « ${name} » (${agent.last_hostname || "?"} / ${agent.last_ip || "?"}) répond à nouveau.`
        });
      }
      // Optional: notify once per target version when an agent update is available.
      if (agent.agent_version && latestVersion && agent.agent_version !== latestVersion) {
        await notifyEvent("updateAvailable", {
          key: `${agent.id}:${latestVersion}`,
          subject: `⬆️ Mise à jour disponible : ${name}`,
          text: `Une mise à jour de l'agent « ${name} » est disponible (actuel ${agent.agent_version} → ${latestVersion}).`
        });
      }
    }
  }
}

export function startMonitor() {
  if (timer) return;
  // Run once shortly after boot, then on a fixed interval.
  timer = setInterval(() => {
    runMonitorCheck().catch((err) => {
      console.error("[monitor] check failed:", err?.message || err);
    });
  }, CHECK_INTERVAL_MS);
  if (typeof timer.unref === "function") timer.unref();
  setTimeout(() => {
    runMonitorCheck().catch(() => {});
  }, 5000);
  console.log("[monitor] Device down-monitoring started");
}

export function stopMonitor() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
