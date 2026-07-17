/**
 * Authentication and authorization middleware shared across the dashboard API.
 *
 * Browser traffic uses sessions + CSRF validation.
 * Agent traffic uses bearer tokens, plus request signing for non-GET calls.
 */
import { dbOps } from "../db/index.js";
import crypto from "crypto";
import { hashToken } from "../utils/tokens.js";

const CSRF_UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const AGENT_SIGNATURE_MAX_AGE_SECONDS = 300;
const agentNonceCache = new Map();

// Compare secrets without leaking timing differences.
function safeTokenEquals(a, b) {
  if (typeof a !== "string" || typeof b !== "string") {
    return false;
  }
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) {
    return false;
  }
  return crypto.timingSafeEqual(left, right);
}

// Match Python's json.dumps(ensure_ascii=True): escape every non-ASCII code
// unit as \uXXXX (lowercase). Astral chars become surrogate pairs, exactly as
// CPython emits them, so signatures computed by the agent match here.
function escapeNonAscii(text) {
  return text.replace(/[^\x00-\x7F]/g, (ch) =>
    "\\u" + ch.charCodeAt(0).toString(16).padStart(4, "0")
  );
}

// Canonical JSON identical to the agent's json.dumps(payload, sort_keys=True,
// separators=(',',':'), ensure_ascii=True).
function canonicalJson(value) {
  return escapeNonAscii(JSON.stringify(canonicalizeValue(value)));
}

// HMAC verification must be deterministic, so we normalize object key order first.
function canonicalizeValue(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => canonicalizeValue(entry));
  }
  if (value && typeof value === "object" && !(value instanceof Date)) {
    return Object.keys(value)
      .sort()
      .reduce((acc, key) => {
        acc[key] = canonicalizeValue(value[key]);
        return acc;
      }, {});
  }
  return value;
}

// Nonces are cached in memory to block simple replay attempts within the validity window.
function purgeAgentNonces(agentId, nowSeconds) {
  const cache = agentNonceCache.get(agentId);
  if (!cache) {
    return new Set();
  }
  const fresh = new Set();
  for (const entry of cache) {
    const [nonce, timestamp] = entry.split(":", 2);
    const ts = Number.parseInt(timestamp, 10);
    if (Number.isFinite(ts) && nowSeconds - ts <= AGENT_SIGNATURE_MAX_AGE_SECONDS) {
      fresh.add(`${nonce}:${ts}`);
    }
  }
  agentNonceCache.set(agentId, fresh);
  return fresh;
}

// Signed agent requests protect mutable endpoints such as poll results and command results.
function verifyAgentSignature(req, agent, plaintextToken) {
  const signature = String(req.headers["x-signature"] || "");
  const timestamp = String(req.headers["x-timestamp"] || "");
  const nonce = String(req.headers["x-nonce"] || "");
  if (!signature || !timestamp || !nonce) {
    return { ok: false, error: "Missing request signature" };
  }

  const requestTime = Number.parseInt(timestamp, 10);
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (!Number.isFinite(requestTime) || Math.abs(nowSeconds - requestTime) > AGENT_SIGNATURE_MAX_AGE_SECONDS) {
    return { ok: false, error: "Expired request signature" };
  }

  const recentNonces = purgeAgentNonces(agent.id, nowSeconds);
  for (const entry of recentNonces) {
    const [seenNonce] = entry.split(":", 1);
    if (seenNonce === nonce) {
      return { ok: false, error: "Replay detected" };
    }
  }

  // Accept either signing scheme so old and new agents both work:
  //  1) raw body bytes  → modern agents sign the exact bytes they send
  //     (immune to JSON formatting differences: floats, key order, unicode).
  //  2) re-canonicalized → legacy agents that sign a canonical JSON form.
  const candidates = [];
  if (req.rawBody && req.rawBody.length) {
    candidates.push(`${timestamp}.${nonce}.${req.rawBody.toString("utf8")}`);
  }
  candidates.push(`${timestamp}.${nonce}.${canonicalJson(req.body || {})}`);

  const matches = candidates.some((message) => {
    const expected = crypto.createHmac("sha256", plaintextToken).update(message).digest("hex");
    return safeTokenEquals(expected, signature);
  });
  if (!matches) {
    return { ok: false, error: "Invalid request signature" };
  }

  recentNonces.add(`${nonce}:${requestTime}`);
  agentNonceCache.set(agent.id, recentNonces);
  return { ok: true };
}

export function requireAuth(req, res, next) {
  if (!req.session || !req.session.userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  if (CSRF_UNSAFE_METHODS.has(req.method.toUpperCase())) {
    const expected = req.session.csrfToken;
    const provided = req.headers["x-csrf-token"];
    if (!safeTokenEquals(expected, provided)) {
      res.status(403).json({ error: "Invalid CSRF token" });
      return;
    }
  }
  next();
}

export async function requireAdmin(req, res, next) {
  if (!req.session || !req.session.userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  if (CSRF_UNSAFE_METHODS.has(req.method.toUpperCase())) {
    const expected = req.session.csrfToken;
    const provided = req.headers["x-csrf-token"];
    if (!safeTokenEquals(expected, provided)) {
      res.status(403).json({ error: "Invalid CSRF token" });
      return;
    }
  }
  const user = await dbOps.get(
    "SELECT id, username, created_at, COALESCE(is_admin, 0) AS is_admin FROM users WHERE id = ?",
    [req.session.userId]
  );
  if (!user) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  if (Number(user.is_admin) !== 1) {
    res.status(403).json({ error: "Admin access required" });
    return;
  }
  req.session.user = {
    id: user.id,
    username: user.username,
    isAdmin: true
  };
  next();
}

export async function attachUser(req, res, next) {
  if (req.session && req.session.userId) {
    const user = await dbOps.get(
      "SELECT id, username, created_at, COALESCE(is_admin, 0) AS is_admin FROM users WHERE id = ?",
      [req.session.userId]
    );
    req.user = user
      ? {
          id: user.id,
          username: user.username,
          created_at: user.created_at,
          isAdmin: Number(user.is_admin) === 1
        }
      : null;
  } else {
    req.user = null;
  }
  next();
}

export async function requireAgentAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) {
    res.status(401).json({ error: "Missing token" });
    return;
  }
  const tokenHash = hashToken(token);
  const agent = await dbOps.get(
    "SELECT * FROM agents WHERE agent_api_token_hash = ? OR agent_api_token = ?",
    [tokenHash, token]
  );
  if (!agent) {
    res.status(401).json({ error: "Invalid token" });
    return;
  }
  if (req.method !== "GET") {
    const verification = verifyAgentSignature(req, agent, token);
    if (!verification.ok) {
      res.status(401).json({ error: verification.error });
      return;
    }
  }
  req.agent = agent;
  req.agentAuthToken = token;
  next();
}
