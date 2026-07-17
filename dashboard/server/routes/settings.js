// Endpoints for managing dashboard configuration settings. Settings are
// stored in the SQLite database and override config.json values.

import express from "express";
import config from "../config.js";
import { requireAdmin } from "../middleware/auth.js";
import { dbOps } from "../db/index.js";
import { getSettings, setSettings } from "../utils/settings.js";
import { resolveBaseUrl } from "../utils/base-url.js";

const router = express.Router();

/**
 * GET /api/settings
 * Retrieve current settings merged with defaults from config
 */
router.get("/", requireAdmin, async (req, res) => {
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
      internetBaseUrl: settings.internetBaseUrl || ""
    }
  });
});

/**
 * POST /api/settings
 * Update settings
 * Note: SSL and port changes require server restart to take effect
 */
router.post("/", requireAdmin, async (req, res) => {
  const {
    publicIp,
    defaultPollSeconds,
    agentLocalWebEnabled,
    agentLocalWebPort,
    internetBaseUrl
  } = req.body || {};

  const publicIpValue = publicIp ? String(publicIp).trim() : "";
  if (publicIpValue && !/^[A-Za-z0-9.\-:\[\]]+$/.test(publicIpValue)) {
    res.status(400).json({ error: "Invalid publicIp format" });
    return;
  }

  const nextPoll = defaultPollSeconds ? String(defaultPollSeconds) : "";
  if (nextPoll) {
    const pollValue = Number.parseInt(nextPoll, 10);
    if (!Number.isFinite(pollValue) || pollValue <= 0 || pollValue > 86400) {
      res.status(400).json({ error: "Invalid defaultPollSeconds value" });
      return;
    }
  }

  let internetBaseUrlValue = "";
  if (internetBaseUrl && String(internetBaseUrl).trim()) {
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
  const localWebPortValue = agentLocalWebPort ? Number.parseInt(agentLocalWebPort, 10) : 8080;
  if (!allowedPorts.includes(localWebPortValue)) {
    res.status(400).json({ error: `Invalid agentLocalWebPort. Allowed: ${allowedPorts.join(", ")}` });
    return;
  }
  
  const current = await getSettings();
  const currentPoll = current.defaultPollSeconds || String(config.agentDefaultPollSeconds);
  
  // Build settings object with all values
  const newSettings = {
    publicIp: publicIpValue,
    defaultPollSeconds: nextPoll,
    agentLocalWebEnabled: agentLocalWebEnabled ? "true" : "false",
    agentLocalWebPort: String(localWebPortValue),
    internetBaseUrl: internetBaseUrlValue
  };
  
  await setSettings(newSettings);
  
  // Update pending poll interval for all agents if changed
  if (nextPoll && nextPoll !== String(currentPoll)) {
    const pollValue = Number.parseInt(nextPoll, 10);
    if (Number.isFinite(pollValue) && pollValue > 0) {
      await dbOps.run(
        "UPDATE agents SET pending_poll_interval_seconds = ?",
        [pollValue]
      );
    }
  }
  
  res.json({ ok: true, message: "Settings saved." });
});

export default router;
