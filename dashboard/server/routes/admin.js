import express from "express";
import os from "os";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { requireAdmin } from "../middleware/auth.js";
import { dbOps } from "../db/index.js";
import { getActorUserId, recordAuditEvent } from "../utils/audit.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const configPath = path.join(__dirname, "..", "..", "config", "config.json");

import { getUpdateStatus, runUpdateCheck } from "../utils/update-check.js";

const router = express.Router();

router.get("/network-ips", requireAdmin, (req, res) => {
  const interfaces = os.networkInterfaces();
  const ips = [];

  Object.entries(interfaces).forEach(([name, entries]) => {
    if (!entries) {
      return;
    }
    entries.forEach((entry) => {
      if (entry.internal) {
        return;
      }
      const family = String(entry.family);
      if (family !== "IPv4" && family !== "4") {
        return;
      }
      ips.push({
        name,
        address: entry.address,
        family: "IPv4"
      });
    });
  });

  res.json({ ok: true, ips });
});

// Get current server configuration
router.get("/config", requireAdmin, async (req, res) => {
  try {
    const configData = JSON.parse(fs.readFileSync(configPath, "utf8"));
    res.json({
      ok: true,
      config: {
        host: configData.host || "0.0.0.0",
        http: {
          enabled: configData.http?.enabled !== false,
          apiPort: configData.http?.apiPort || 3001,
          webPort: configData.http?.webPort || 5173
        },
        https: {
          enabled: configData.https?.enabled || false,
          apiPort: configData.https?.apiPort || 3002,
          webPort: configData.https?.webPort || 5174,
          keyPath: configData.https?.keyPath || "./ssl/server.key",
          certPath: configData.https?.certPath || "./ssl/server.crt"
        },
        defaultApiProtocol: configData.defaultApiProtocol || "http"
      }
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: "Failed to read config" });
  }
});

// Update HTTP/HTTPS configuration
router.post("/config/server", requireAdmin, async (req, res) => {
  try {
    const { http, https, defaultApiProtocol } = req.body;
    
    const configData = JSON.parse(fs.readFileSync(configPath, "utf8"));
    
    // Update HTTP settings
    if (http) {
      if (!configData.http) configData.http = {};
      if (typeof http.enabled === "boolean") configData.http.enabled = http.enabled;
      if (typeof http.apiPort === "number") configData.http.apiPort = http.apiPort;
      if (typeof http.webPort === "number") configData.http.webPort = http.webPort;
    }
    
    // Update HTTPS settings
    if (https) {
      if (!configData.https) configData.https = {};
      if (typeof https.enabled === "boolean") configData.https.enabled = https.enabled;
      if (typeof https.apiPort === "number") configData.https.apiPort = https.apiPort;
      if (typeof https.webPort === "number") configData.https.webPort = https.webPort;
      if (typeof https.keyPath === "string") configData.https.keyPath = https.keyPath;
      if (typeof https.certPath === "string") configData.https.certPath = https.certPath;
    }
    
    // Update default API protocol
    if (defaultApiProtocol === "http" || defaultApiProtocol === "https") {
      configData.defaultApiProtocol = defaultApiProtocol;
    }
    
    // Validation: at least one protocol must be enabled
    if (configData.http?.enabled === false && configData.https?.enabled !== true) {
      return res.status(400).json({ 
        ok: false, 
        error: "At least one protocol (HTTP or HTTPS) must be enabled" 
      });
    }
    
    fs.writeFileSync(configPath, JSON.stringify(configData, null, 2));
    await recordAuditEvent({
      actorUserId: getActorUserId(req),
      action: "admin.config_updated",
      entityType: "server_config",
      entityId: "dashboard",
      details: {
        http: configData.http,
        https: {
          enabled: configData.https?.enabled,
          apiPort: configData.https?.apiPort,
          webPort: configData.https?.webPort,
          keyPath: configData.https?.keyPath,
          certPath: configData.https?.certPath
        },
        defaultApiProtocol: configData.defaultApiProtocol
      }
    });
    
    res.json({ ok: true, message: "Configuration updated. Restart server to apply changes." });
  } catch (err) {
    console.error("[Admin] Failed to update server config", err);
    res.status(500).json({ ok: false, error: "Failed to update config" });
  }
});

// Check if SSL certificates exist
router.get("/config/ssl-status", requireAdmin, async (req, res) => {
  try {
    const configData = JSON.parse(fs.readFileSync(configPath, "utf8"));
    const keyPath = path.join(__dirname, "..", "..", configData.https?.keyPath || "./ssl/server.key");
    const certPath = path.join(__dirname, "..", "..", configData.https?.certPath || "./ssl/server.crt");
    
    res.json({
      ok: true,
      keyExists: fs.existsSync(keyPath),
      certExists: fs.existsSync(certPath),
      keyPath: configData.https?.keyPath || "./ssl/server.key",
      certPath: configData.https?.certPath || "./ssl/server.crt"
    });
  } catch (err) {
    console.error("[Admin] Failed to inspect SSL status", err);
    res.status(500).json({ ok: false, error: "Failed to inspect SSL status" });
  }
});

// Restart server endpoint
router.post("/restart", requireAdmin, async (req, res) => {
  await recordAuditEvent({
    actorUserId: getActorUserId(req),
    action: "admin.restart_requested",
    entityType: "server",
    entityId: "dashboard"
  });
  res.json({ ok: true, message: "Server restarting..." });
  
  setTimeout(() => {
    console.log("[Admin] Server restart requested via API");
    process.exit(0);
  }, 500);
});

router.get("/audit", requireAdmin, async (req, res) => {
  const limit = Math.min(Number.parseInt(req.query.limit, 10) || 100, 500);
  const rows = await dbOps.all(
    `SELECT
      audit_events.*,
      users.username AS actor_username,
      agents.display_name AS agent_display_name
     FROM audit_events
     LEFT JOIN users ON users.id = audit_events.actor_user_id
     LEFT JOIN agents ON agents.id = audit_events.agent_id
     ORDER BY audit_events.created_at DESC
     LIMIT ?`,
    [limit]
  );
  res.json({
    ok: true,
    events: rows.map((row) => ({
      id: row.id,
      actorUserId: row.actor_user_id,
      actorUsername: row.actor_username || null,
      action: row.action,
      entityType: row.entity_type,
      entityId: row.entity_id,
      agentId: row.agent_id,
      agentDisplayName: row.agent_display_name || null,
      details: row.details_json ? JSON.parse(row.details_json) : null,
      createdAt: row.created_at
    }))
  });
});

router.get("/health", requireAdmin, async (req, res) => {
  const [agentCounts, commandCounts, notificationCounts, latestAudit] = await Promise.all([
    dbOps.get(
      `SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN COALESCE(is_online, 1) = 1 THEN 1 ELSE 0 END) AS online,
        SUM(CASE WHEN COALESCE(is_online, 1) = 0 THEN 1 ELSE 0 END) AS offline
       FROM agents`
    ),
    dbOps.all("SELECT status, COUNT(*) AS count FROM commands GROUP BY status"),
    dbOps.get(
      `SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN ok = 1 THEN 1 ELSE 0 END) AS ok,
        SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END) AS failed
       FROM notification_events`
    ),
    dbOps.get("SELECT created_at FROM audit_events ORDER BY created_at DESC LIMIT 1")
  ]);
  const configData = JSON.parse(fs.readFileSync(configPath, "utf8"));
  res.json({
    ok: true,
    health: {
      agents: {
        total: agentCounts?.total || 0,
        online: agentCounts?.online || 0,
        offline: agentCounts?.offline || 0
      },
      commands: Object.fromEntries(commandCounts.map((row) => [row.status, row.count])),
      notifications: {
        total: notificationCounts?.total || 0,
        ok: notificationCounts?.ok || 0,
        failed: notificationCounts?.failed || 0
      },
      server: {
        httpEnabled: configData.http?.enabled !== false,
        httpsEnabled: configData.https?.enabled === true,
        defaultApiProtocol: configData.defaultApiProtocol || "http"
      },
      latestAuditAt: latestAudit?.created_at || null
    }
  });
});

// ---------------------------------------------------------------------------
//  Published-version check
// ---------------------------------------------------------------------------

// Read the cached result. Never performs a network call, so the dashboard can
// render the badge instantly on every page load.
router.get("/update-check", requireAdmin, (req, res) => {
  res.json({ ok: true, status: getUpdateStatus() });
});

// A repeated click must not hammer the repository, so forced checks are
// throttled per process. The cached result is returned in the meantime.
const FORCE_MIN_INTERVAL_MS = 10000;
let lastForcedCheckAt = 0;

router.post("/update-check", requireAdmin, async (req, res) => {
  const now = Date.now();
  if (now - lastForcedCheckAt < FORCE_MIN_INTERVAL_MS) {
    res.json({ ok: true, throttled: true, status: getUpdateStatus() });
    return;
  }
  lastForcedCheckAt = now;
  // `force` bypasses the enabled flag: the manual button must work even when
  // the periodic check is turned off.
  const status = await runUpdateCheck({ force: true });
  res.json({ ok: true, throttled: false, status });
});

export default router;
