/**
 * Notification channels (Email via SMTP / SMS via Twilio).
 *
 * Configuration lives in the `settings` table. Secrets (SMTP password, Twilio
 * auth token) are stored encrypted with the dashboard data-protection key
 * (see utils/tokens.js) and never returned to the client in clear text.
 */
import { getSettings, setSetting, getSetting } from "./settings.js";
import { encryptSecret, decryptSecret } from "./tokens.js";
import { dbOps } from "../db/index.js";
import { v4 as uuidv4 } from "uuid";

// Notification TYPES. Each type can be enabled/disabled and routed per channel.
// `repeatMinutes` (device_down only): re-notify a still-open problem at most
// once per interval (0 = notify a single time, never repeat).
export const NOTIFY_TYPES = ["deviceDown", "deviceUp", "updateAvailable", "other"];

const DEFAULT_TYPES = {
  deviceDown:      { enabled: true,  email: true,  sms: false, repeatMinutes: 60 },
  deviceUp:        { enabled: true,  email: true,  sms: false },
  updateAvailable: { enabled: false, email: true,  sms: false },
  other:           { enabled: false, email: true,  sms: false }
};

// In-memory de-duplication: lastSent timestamp (ms) per "type:key".
const _lastSent = new Map();

// Plain (non-secret) settings keys.
const KEYS = {
  emailEnabled: "alertEmailEnabled",
  smtpHost: "smtpHost",
  smtpPort: "smtpPort",
  smtpSecure: "smtpSecure",
  smtpUser: "smtpUser",
  smtpPassEnc: "smtpPassEnc",
  emailFrom: "alertEmailFrom",
  emailTo: "alertEmailTo",
  smsEnabled: "alertSmsEnabled",
  twilioSid: "twilioAccountSid",
  twilioTokenEnc: "twilioAuthTokenEnc",
  twilioFrom: "twilioFrom",
  smsTo: "alertSmsTo"
};

function splitRecipients(value) {
  return String(value || "")
    .split(/[,;\s]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function safeDecrypt(value) {
  if (!value) return "";
  try {
    return decryptSecret(value) || "";
  } catch {
    return "";
  }
}

/** Full config including decrypted secrets — server-side use only. */
export async function getNotificationConfig() {
  const s = await getSettings();
  return {
    email: {
      enabled: s[KEYS.emailEnabled] === "true",
      host: s[KEYS.smtpHost] || "",
      port: Number.parseInt(s[KEYS.smtpPort], 10) || 587,
      secure: s[KEYS.smtpSecure] === "true",
      user: s[KEYS.smtpUser] || "",
      pass: safeDecrypt(s[KEYS.smtpPassEnc]),
      from: s[KEYS.emailFrom] || s[KEYS.smtpUser] || "",
      to: splitRecipients(s[KEYS.emailTo])
    },
    sms: {
      enabled: s[KEYS.smsEnabled] === "true",
      accountSid: s[KEYS.twilioSid] || "",
      authToken: safeDecrypt(s[KEYS.twilioTokenEnc]),
      from: s[KEYS.twilioFrom] || "",
      to: splitRecipients(s[KEYS.smsTo])
    }
  };
}

/** Per-type configuration (stored as a JSON blob in settings). */
export async function getTypesConfig() {
  const raw = await getSetting("notifyTypes");
  let stored = {};
  if (raw) {
    try { stored = JSON.parse(raw); } catch { stored = {}; }
  }
  const merged = {};
  for (const type of NOTIFY_TYPES) {
    merged[type] = { ...DEFAULT_TYPES[type], ...(stored[type] || {}) };
  }
  return merged;
}

async function saveTypesConfig(types) {
  if (!types || typeof types !== "object") return;
  const current = await getTypesConfig();
  for (const type of NOTIFY_TYPES) {
    if (types[type]) {
      current[type] = { ...current[type], ...types[type] };
      if (current[type].repeatMinutes !== undefined) {
        const n = Number.parseInt(current[type].repeatMinutes, 10);
        current[type].repeatMinutes = Number.isFinite(n) && n >= 0 ? n : 0;
      }
    }
  }
  await setSetting("notifyTypes", JSON.stringify(current));
}

/** Public view: secrets are replaced by booleans (`*Set`), never the value. */
export async function getNotificationConfigPublic() {
  const cfg = await getNotificationConfig();
  const types = await getTypesConfig();
  return {
    email: {
      enabled: cfg.email.enabled,
      host: cfg.email.host,
      port: cfg.email.port,
      secure: cfg.email.secure,
      user: cfg.email.user,
      passSet: Boolean(cfg.email.pass),
      from: cfg.email.from,
      to: cfg.email.to.join(", ")
    },
    sms: {
      enabled: cfg.sms.enabled,
      accountSid: cfg.sms.accountSid,
      authTokenSet: Boolean(cfg.sms.authToken),
      from: cfg.sms.from,
      to: cfg.sms.to.join(", ")
    },
    types
  };
}

/**
 * Persist config from the admin form. Secret fields are only updated when a
 * non-empty value is provided, so leaving them blank keeps the stored secret.
 */
export async function saveNotificationConfig(body = {}) {
  const email = body.email || {};
  const sms = body.sms || {};

  await setSetting(KEYS.emailEnabled, email.enabled ? "true" : "false");
  if (email.host !== undefined) await setSetting(KEYS.smtpHost, String(email.host || ""));
  if (email.port !== undefined) await setSetting(KEYS.smtpPort, String(Number.parseInt(email.port, 10) || 587));
  await setSetting(KEYS.smtpSecure, email.secure ? "true" : "false");
  if (email.user !== undefined) await setSetting(KEYS.smtpUser, String(email.user || ""));
  if (email.from !== undefined) await setSetting(KEYS.emailFrom, String(email.from || ""));
  if (email.to !== undefined) await setSetting(KEYS.emailTo, splitRecipients(email.to).join(","));
  if (email.pass) await setSetting(KEYS.smtpPassEnc, encryptSecret(String(email.pass)));

  await setSetting(KEYS.smsEnabled, sms.enabled ? "true" : "false");
  if (sms.accountSid !== undefined) await setSetting(KEYS.twilioSid, String(sms.accountSid || ""));
  if (sms.from !== undefined) await setSetting(KEYS.twilioFrom, String(sms.from || ""));
  if (sms.to !== undefined) await setSetting(KEYS.smsTo, splitRecipients(sms.to).join(","));
  if (sms.authToken) await setSetting(KEYS.twilioTokenEnc, encryptSecret(String(sms.authToken)));

  if (body.types) await saveTypesConfig(body.types);
}

async function sendEmail(cfg, subject, text) {
  if (!cfg.host || cfg.to.length === 0) {
    return { ok: false, error: "Email not configured (host/recipients missing)" };
  }
  // nodemailer is an optional dependency; fail gracefully if not installed.
  let nodemailer;
  try {
    nodemailer = (await import("nodemailer")).default;
  } catch {
    return { ok: false, error: "nodemailer not installed on the server" };
  }
  try {
    const transporter = nodemailer.createTransport({
      host: cfg.host,
      port: cfg.port,
      secure: cfg.secure,
      auth: cfg.user ? { user: cfg.user, pass: cfg.pass } : undefined
    });
    await transporter.sendMail({
      from: cfg.from || cfg.user,
      to: cfg.to.join(", "),
      subject,
      text
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err?.message || "Email send failed" };
  }
}

async function sendSms(cfg, text) {
  // Trim to avoid trailing spaces/newlines pasted into the fields, which break
  // Twilio Basic auth (error 20003 "invalid username").
  const accountSid = String(cfg.accountSid || "").trim();
  const authToken = String(cfg.authToken || "").trim();
  const from = String(cfg.from || "").trim();
  if (!accountSid || !authToken || !from || cfg.to.length === 0) {
    return { ok: false, error: "SMS not configured (Twilio SID/token/from/recipients missing)" };
  }
  if (!accountSid.startsWith("AC")) {
    return { ok: false, error: "Twilio Account SID must start with 'AC' (use the Account SID, not an API key or Messaging SID)" };
  }
  const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Messages.json`;
  const auth = Buffer.from(`${accountSid}:${authToken}`).toString("base64");
  const errors = [];
  for (const to of cfg.to) {
    try {
      const params = new URLSearchParams({ To: to, From: from, Body: text });
      const res = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Basic ${auth}`,
          "Content-Type": "application/x-www-form-urlencoded"
        },
        body: params.toString()
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        errors.push(`${to}: HTTP ${res.status} ${detail.slice(0, 200)}`);
      }
    } catch (err) {
      errors.push(`${to}: ${err?.message || "request failed"}`);
    }
  }
  return errors.length ? { ok: false, error: errors.join("; ") } : { ok: true };
}

async function recordNotificationEvent(subject, body, channel, result) {
  try {
    await dbOps.run(
      `INSERT INTO notification_events (
        id,
        subject,
        body,
        channel,
        ok,
        error_message,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        uuidv4(),
        subject,
        body,
        channel,
        result?.ok ? 1 : 0,
        result?.ok ? null : result?.error || "Notification failed",
        new Date().toISOString()
      ]
    );
  } catch (err) {
    console.error("[notifications] failed to record event:", err?.message || err);
  }
}

/**
 * Send a TYPED notification, with de-duplication so a single problem never
 * floods the recipients.
 *
 * @param {string} type  one of NOTIFY_TYPES
 * @param {object} opts  { key, subject, text }
 *   - key: stable identifier of the underlying problem (e.g. agent id). Used
 *     for de-dup; the same key won't be re-sent unless allowed by repeatMinutes.
 *
 * Rules:
 *   - Type disabled            → nothing sent.
 *   - First occurrence of key  → sent once.
 *   - Same key again:
 *       · deviceDown with repeatMinutes>0 → re-sent only once per interval.
 *       · otherwise                        → suppressed until clearEvent(type,key).
 * Returns per-channel results (or { skipped:true }). Never throws.
 */
export async function notifyEvent(type, { key, subject, text } = {}) {
  const types = await getTypesConfig();
  const typeCfg = types[type];
  if (!typeCfg || !typeCfg.enabled) {
    return { skipped: true, reason: "type disabled" };
  }

  const dedupKey = `${type}:${key || subject || ""}`;
  const now = Date.now();
  const last = _lastSent.get(dedupKey);
  if (last !== undefined) {
    const repeatMs = Number(typeCfg.repeatMinutes || 0) * 60 * 1000;
    if (repeatMs <= 0 || now - last < repeatMs) {
      return { skipped: true, reason: "deduplicated" };
    }
  }

  const cfg = await getNotificationConfig();
  const results = {};
  if (typeCfg.email && cfg.email.enabled) {
    results.email = await sendEmail(cfg.email, subject, text);
    await recordNotificationEvent(subject, text, "email", results.email);
  }
  if (typeCfg.sms && cfg.sms.enabled) {
    results.sms = await sendSms(cfg.sms, `${subject} — ${text}`);
    await recordNotificationEvent(subject, text, "sms", results.sms);
  }

  // Only record as "sent" if at least one channel was actually attempted.
  if (results.email || results.sms) {
    _lastSent.set(dedupKey, now);
  }
  return results;
}

/** Reset de-dup state for a (type,key) so the next occurrence notifies again. */
export function clearEvent(type, key) {
  _lastSent.delete(`${type}:${key || ""}`);
}

/** Send a test message on the channels the caller asks for. */
export async function sendTest({ channel } = {}) {
  const cfg = await getNotificationConfig();
  const subject = "AAUL — Test notification";
  const text = `Ceci est un test envoyé depuis le dashboard AAUL à ${new Date().toLocaleString()}.`;
  const results = {};
  if (channel === "email" || channel === "both" || !channel) {
    results.email = await sendEmail(cfg.email, subject, text);
  }
  if (channel === "sms" || channel === "both" || !channel) {
    results.sms = await sendSms(cfg.sms, `${subject} — ${text}`);
  }
  return results;
}
