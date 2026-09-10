// Endpoints for managing dashboard configuration settings. Settings are
// stored in the SQLite database and override config.json values.

import express from "express";
import config from "../config.js";
import { requireAdmin, requireSystemAdmin } from "../middleware/auth.js";
import { dbOps } from "../db/index.js";
import { getSettings, setSettings } from "../utils/settings.js";
import { resolveBaseUrl } from "../utils/base-url.js";

const router = express.Router();

// Defaults mirror the fallbacks in routes/agent-api.js so the Admin page shows
// the values the fleet is actually running with, not a blank field.
const DEFAULT_LOG_RETENTION_DAYS = 30;
const DEFAULT_LOG_MAX_TOTAL_MB = 200;
const DEFAULT_METRICS_RETENTION_DAYS = 30;
// Published-version check. On by default; an isolated fleet can turn it off so
// it stops attempting an outbound request it can never complete.
const DEFAULT_UPDATE_CHECK_ENABLED = true;
const DEFAULT_UPDATE_CHECK_INTERVAL_MINUTES = 30;

/**
 * Validate a bounded integer setting.
 *
 * An absent field must keep whatever is already stored, NOT snap back to the
 * default: several pages post a partial settings document (the Logs page owns
 * log retention, this page owns networking), and resetting the fields a caller
 * did not mention would silently undo another page's configuration.
 */
function boundedInt(value, { min, max, fallback, label }) {
  if (value === undefined || value === null || String(value).trim() === "") {
    return { ok: true, value: String(fallback) };
  }
  const number = Number.parseInt(String(value).trim(), 10);
  if (!Number.isFinite(number) || number < min || number > max) {
    return { ok: false, error: `Invalid ${label} (integer ${min}..${max} expected)` };
  }
  return { ok: true, value: String(number) };
}

/**
 * GET /api/settings
 * Retrieve current settings merged with defaults from config
 */
router.get("/", requireAdmin, requireSystemAdmin, async (req, res) => {
  const settings = await getSettings();
  const installUrl = await resolveBaseUrl();
  res.json({
    ok: true,
    settings: {
      // Network settings
      publicIp: settings.publicIp || "",
      installUrl,
      defaultPollSeconds: settings.defaultPollSeconds || String(config.agentDefaultPollSeconds),

      // Agent local web settings
      agentLocalWebEnabled: settings.agentLocalWebEnabled === "true" || config.agentLocalWebEnabled || false,
      agentLocalWebPort: settings.agentLocalWebPort || String(config.agentLocalWebPort || 8080),

      // Global internet base URL (used as default when creating internet agents)
      internetBaseUrl: settings.internetBaseUrl || "",

      // Log retention, pushed to every agent on its next poll. Agents clamp
      // these values again locally — see agent/app/lib/logs.py.
      logRetentionDays: settings.logRetentionDays || String(DEFAULT_LOG_RETENTION_DAYS),
      logMaxTotalMb: settings.logMaxTotalMb || String(DEFAULT_LOG_MAX_TOTAL_MB),

      // How long the dashboard keeps per-host metric history (server-side only).
      metricsRetentionDays: settings.metricsRetentionDays || String(DEFAULT_METRICS_RETENTION_DAYS),

      // Published-version check (see utils/update-check.js).
      updateCheckEnabled:
        settings.updateCheckEnabled === undefined
          ? DEFAULT_UPDATE_CHECK_ENABLED
          : settings.updateCheckEnabled === "true",
      updateCheckIntervalMinutes:
        settings.updateCheckIntervalMinutes || String(DEFAULT_UPDATE_CHECK_INTERVAL_MINUTES),
      updateReleaseUrl: settings.updateReleaseUrl || ""
    }
  });
});

/**
 * POST /api/settings
 * Update settings
 * Note: SSL and port changes require server restart to take effect
 */
router.post("/", requireAdmin, requireSystemAdmin, async (req, res) => {
  const {
    publicIp,
    defaultPollSeconds,
    agentLocalWebEnabled,
    agentLocalWebPort,
    internetBaseUrl,
    logRetentionDays,
    logMaxTotalMb,
    metricsRetentionDays,
    updateCheckEnabled,
    updateCheckIntervalMinutes,
    updateReleaseUrl
  } = req.body || {};

  const current = await getSettings();

  const logDays = boundedInt(logRetentionDays, {
    min: 1, max: 3650,
    fallback: current.logRetentionDays ?? DEFAULT_LOG_RETENTION_DAYS,
    label: "logRetentionDays"
  });
  if (!logDays.ok) {
    res.status(400).json({ error: logDays.error });
    return;
  }
  const logMb = boundedInt(logMaxTotalMb, {
    min: 1, max: 100000,
    fallback: current.logMaxTotalMb ?? DEFAULT_LOG_MAX_TOTAL_MB,
    label: "logMaxTotalMb"
  });
  if (!logMb.ok) {
    res.status(400).json({ error: logMb.error });
    return;
  }
  const metricsDays = boundedInt(metricsRetentionDays, {
    min: 1, max: 3650,
    fallback: current.metricsRetentionDays ?? DEFAULT_METRICS_RETENTION_DAYS,
    label: "metricsRetentionDays"
  });
  if (!metricsDays.ok) {
    res.status(400).json({ error: metricsDays.error });
    return;
  }

  const updateInterval = boundedInt(updateCheckIntervalMinutes, {
    min: 5, max: 1440,
    fallback: current.updateCheckIntervalMinutes ?? DEFAULT_UPDATE_CHECK_INTERVAL_MINUTES,
    label: "updateCheckIntervalMinutes"
  });
  if (!updateInterval.ok) {
    res.status(400).json({ error: updateInterval.error });
    return;
  }

  // Same guard as agentLocalWebEnabled: the string "false" is truthy in JS, so a
  // caller echoing settings back would silently re-enable the check.
  const updateEnabledValue =
    updateCheckEnabled === undefined
      ? (current.updateCheckEnabled === undefined
          ? DEFAULT_UPDATE_CHECK_ENABLED
          : current.updateCheckEnabled === "true")
      : updateCheckEnabled === true || updateCheckEnabled === "true";

  let updateReleaseUrlValue =
    updateReleaseUrl === undefined ? (current.updateReleaseUrl || "") : "";
  if (updateReleaseUrl !== undefined && String(updateReleaseUrl).trim()) {
    try {
      const parsed = new URL(String(updateReleaseUrl).trim());
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new Error("bad protocol");
      }
      updateReleaseUrlValue = parsed.href;
    } catch {
      res.status(400).json({ error: "Invalid updateReleaseUrl — must be a valid http/https URL" });
      return;
    }
  }

  // Absent (undefined) means "leave as-is"; an empty string means "clear it".
  // Different pages own different parts of this document, so a partial POST
  // must never reset the fields it did not mention.
  const publicIpValue =
    publicIp === undefined ? (current.publicIp || "") : String(publicIp).trim();
  if (publicIpValue && !/^[A-Za-z0-9.\-:\[\]]+$/.test(publicIpValue)) {
    res.status(400).json({ error: "Invalid publicIp format" });
    return;
  }

  const nextPoll =
    defaultPollSeconds === undefined
      ? (current.defaultPollSeconds || "")
      : String(defaultPollSeconds).trim();
  if (nextPoll) {
    const pollValue = Number.parseInt(nextPoll, 10);
    if (!Number.isFinite(pollValue) || pollValue <= 0 || pollValue > 86400) {
      res.status(400).json({ error: "Invalid defaultPollSeconds value" });
      return;
    }
  }

  let internetBaseUrlValue =
    internetBaseUrl === undefined ? (current.internetBaseUrl || "") : "";
  if (internetBaseUrl !== undefined && String(internetBaseUrl).trim()) {
    try {
      const u = new URL(String(internetBaseUrl).trim());
      if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("bad protocol");
      internetBaseUrlValue = u.origin;
    } catch {
      res.status(400).json({ error: "Invalid internetBaseUrl — must be a valid http/https URL" });
      return;
    }
  }

  const allowedPorts = [8080, 8090, 8180, 8190];
  const localWebPortRaw =
    agentLocalWebPort === undefined ? current.agentLocalWebPort : agentLocalWebPort;
  const localWebPortValue = localWebPortRaw ? Number.parseInt(localWebPortRaw, 10) : 8080;
  if (!allowedPorts.includes(localWebPortValue)) {
    res.status(400).json({ error: `Invalid agentLocalWebPort. Allowed: ${allowedPorts.join(", ")}` });
    return;
  }

  // Guard against the classic JSON pitfall: the string "false" is truthy, so a
  // caller echoing settings back would silently turn the flag on.
  const localWebEnabledValue =
    agentLocalWebEnabled === undefined
      ? (current.agentLocalWebEnabled === "true")
      : agentLocalWebEnabled === true || agentLocalWebEnabled === "true";
  
  const currentPoll = current.defaultPollSeconds || String(config.agentDefaultPollSeconds);
  
  // Build settings object with all values
  const newSettings = {
    publicIp: publicIpValue,
    defaultPollSeconds: nextPoll,
    agentLocalWebEnabled: localWebEnabledValue ? "true" : "false",
    agentLocalWebPort: String(localWebPortValue),
    internetBaseUrl: internetBaseUrlValue,
    logRetentionDays: logDays.value,
    logMaxTotalMb: logMb.value,
    metricsRetentionDays: metricsDays.value,
    updateCheckEnabled: updateEnabledValue ? "true" : "false",
    updateCheckIntervalMinutes: updateInterval.value,
    updateReleaseUrl: updateReleaseUrlValue
  };
  
  await setSettings(newSettings);
  
  // Update pending poll interval for all agents if changed.
  // AAUL-Cloud: ne mettre à jour que les agents autorisés par les filtres.
  if (nextPoll && nextPoll !== String(currentPoll)) {
    const pollValue = Number.parseInt(nextPoll, 10);
    if (Number.isFinite(pollValue) && pollValue > 0) {
      const { applyAgentFilters } = await import("../plugins/plugin-loader.js");
      const allAgents = await dbOps.all("SELECT id FROM agents");
      const allowed = [];
      for (const agent of allAgents) {
        if (await applyAgentFilters(agent, req)) {
          allowed.push(agent.id);
        }
      }
      if (allowed.length > 0) {
        const placeholders = allowed.map(() => "?").join(",");
        await dbOps.run(
          `UPDATE agents SET pending_poll_interval_seconds = ? WHERE id IN (${placeholders})`,
          [pollValue, ...allowed]
        );
      }
    }
  }
  
  res.json({ ok: true, message: "Settings saved." });
});

export default router;
