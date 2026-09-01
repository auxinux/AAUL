/**
 * Notification & monitoring settings API (admin only).
 *
 * - GET  /api/notifications        → current config (secrets masked) + monitoring
 * - POST /api/notifications        → save config + monitoring settings
 * - POST /api/notifications/test   → send a test message ({ channel })
 */
import express from "express";
import { requireAdmin } from "../middleware/auth.js";
import { getSetting, setSetting } from "../utils/settings.js";
import { dbOps } from "../db/index.js";
import { getActorUserId, recordAuditEvent } from "../utils/audit.js";
import {
  getNotificationConfig,
  getNotificationConfigPublic,
  saveNotificationConfig,
  sendTest
} from "../utils/notifications.js";

const router = express.Router();

function hasRecipients(value) {
  return Array.isArray(value)
    ? value.length > 0
    : String(value || "").split(/[,;\s]+/).some(Boolean);
}

async function validateNotificationConfig(notifications) {
  const current = await getNotificationConfig();
  const email = { ...current.email, ...(notifications.email || {}) };
  const sms = { ...current.sms, ...(notifications.sms || {}) };
  if (!notifications.email?.pass) email.pass = current.email.pass;
  if (!notifications.sms?.authToken) sms.authToken = current.sms.authToken;

  if (email.enabled) {
    const port = Number.parseInt(email.port, 10);
    if (!String(email.host || "").trim()) return "SMTP host is required when email alerts are enabled";
    if (!Number.isFinite(port) || port < 1 || port > 65535) return "SMTP port must be between 1 and 65535";
    if (!String(email.from || email.user || "").trim()) return "Email sender address is required";
    if (!hasRecipients(email.to)) return "At least one email recipient is required";
    if (String(email.user || "").trim() && !String(email.pass || "").trim()) return "SMTP password is required for the configured user";
  }

  if (sms.enabled) {
    if (!String(sms.accountSid || "").trim().startsWith("AC")) return "Twilio Account SID must start with AC";
    if (!String(sms.authToken || "").trim()) return "Twilio Auth Token is required";
    if (!String(sms.from || "").trim()) return "Twilio sender number is required";
    if (!hasRecipients(sms.to)) return "At least one SMS recipient is required";
  }
  return null;
}

async function getMonitoring() {
  const enabled = (await getSetting("downMonitoringEnabled")) !== "false"; // default ON
  const threshold = Number.parseInt(await getSetting("downThresholdSeconds"), 10);
  return {
    enabled,
    thresholdSeconds: Number.isFinite(threshold) && threshold >= 30 ? threshold : 120
  };
}

router.get("/", requireAdmin, async (req, res) => {
  const notifications = await getNotificationConfigPublic();
  const monitoring = await getMonitoring();
  res.json({ ok: true, notifications, monitoring });
});

router.post("/", requireAdmin, async (req, res) => {
  const { notifications, monitoring } = req.body || {};

  if (notifications) {
    const validationError = await validateNotificationConfig(notifications);
    if (validationError) {
      res.status(400).json({ error: validationError });
      return;
    }
    await saveNotificationConfig(notifications);
    await recordAuditEvent({
      actorUserId: getActorUserId(req),
      action: "notifications.config_updated",
      entityType: "notifications",
      entityId: "default",
      details: {
        emailEnabled: Boolean(notifications.email?.enabled),
        smsEnabled: Boolean(notifications.sms?.enabled)
      }
    });
  }

  if (monitoring) {
    await setSetting("downMonitoringEnabled", monitoring.enabled ? "true" : "false");
    if (monitoring.thresholdSeconds !== undefined) {
      const value = Number.parseInt(monitoring.thresholdSeconds, 10);
      if (!Number.isFinite(value) || value < 30 || value > 86400) {
        res.status(400).json({ error: "thresholdSeconds must be between 30 and 86400" });
        return;
      }
      await setSetting("downThresholdSeconds", String(value));
    }
    await recordAuditEvent({
      actorUserId: getActorUserId(req),
      action: "notifications.monitoring_updated",
      entityType: "monitoring",
      entityId: "down",
      details: {
        enabled: Boolean(monitoring.enabled),
        thresholdSeconds: monitoring.thresholdSeconds
      }
    });
  }

  res.json({ ok: true, message: "Notification settings saved." });
});

router.post("/test", requireAdmin, async (req, res) => {
  const channel = req.body?.channel || "both";
  if (!["email", "sms", "both"].includes(channel)) {
    res.status(400).json({ error: "Invalid channel" });
    return;
  }
  const results = await sendTest({ channel });
  const anyOk = Object.values(results).some((r) => r?.ok);
  const failures = Object.entries(results)
    .filter(([, result]) => !result?.ok)
    .map(([name, result]) => `${name}: ${result?.error || "test failed"}`);
  await recordAuditEvent({
    actorUserId: getActorUserId(req),
    action: "notifications.test_sent",
    entityType: "notifications",
    entityId: channel,
    details: { channel, ok: anyOk }
  });
  res.status(anyOk ? 200 : 400).json({
    ok: anyOk,
    results,
    error: failures.join("; ") || "Notification test failed"
  });
});

router.get("/history", requireAdmin, async (req, res) => {
  const limit = Math.min(Number.parseInt(req.query.limit, 10) || 100, 500);
  const rows = await dbOps.all(
    "SELECT * FROM notification_events ORDER BY created_at DESC LIMIT ?",
    [limit]
  );
  res.json({
    ok: true,
    events: rows.map((row) => ({
      id: row.id,
      subject: row.subject,
      body: row.body,
      channel: row.channel,
      ok: row.ok === 1,
      errorMessage: row.error_message,
      createdAt: row.created_at
    }))
  });
});

export default router;
