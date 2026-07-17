import express from "express";
import bcrypt from "bcrypt";
import crypto from "crypto";
import { dbOps } from "../db/index.js";
import config from "../config.js";

const router = express.Router();
const loginAttempts = new Map();
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const MAX_LOGIN_ATTEMPTS = 5;

function isRateLimited(ip) {
  const now = Date.now();
  const attempts = (loginAttempts.get(ip) || []).filter((ts) => now - ts < LOGIN_WINDOW_MS);
  loginAttempts.set(ip, attempts);
  return attempts.length >= MAX_LOGIN_ATTEMPTS;
}

function recordFailedAttempt(ip) {
  const now = Date.now();
  const attempts = (loginAttempts.get(ip) || []).filter((ts) => now - ts < LOGIN_WINDOW_MS);
  attempts.push(now);
  loginAttempts.set(ip, attempts);
}

function clearFailedAttempts(ip) {
  loginAttempts.delete(ip);
}

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

function ensureCsrfToken(req) {
  if (!req.session.csrfToken) {
    req.session.csrfToken = crypto.randomBytes(32).toString("hex");
  }
  return req.session.csrfToken;
}

function setCsrfCookie(res, csrfToken) {
  res.cookie("csrf-token", csrfToken, {
    httpOnly: false,
    sameSite: "strict",
    secure: config.https?.enabled === true,
    path: "/"
  });
}

router.post("/login", async (req, res) => {
  const clientIp = req.ip || req.socket?.remoteAddress || "unknown";
  if (isRateLimited(clientIp)) {
    res.status(429).json({ error: "Too many failed login attempts. Try again later." });
    return;
  }

  const { username, password } = req.body || {};
  if (!username || !password) {
    res.status(400).json({ error: "Missing credentials" });
    return;
  }
  const user = await dbOps.get(
    "SELECT * FROM users WHERE username = ?",
    [username]
  );
  if (!user) {
    recordFailedAttempt(clientIp);
    res.status(401).json({ error: "Invalid credentials" });
    return;
  }
  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) {
    recordFailedAttempt(clientIp);
    res.status(401).json({ error: "Invalid credentials" });
    return;
  }
  clearFailedAttempts(clientIp);
  req.session.regenerate((err) => {
    if (err) {
      res.status(500).json({ error: "Login failed" });
      return;
    }
    req.session.userId = user.id;
    req.session.user = {
      id: user.id,
      username: user.username,
      isAdmin: Number(user.is_admin) === 1,
      mustChangePassword: Number(user.must_change_password) === 1
    };
    const csrfToken = ensureCsrfToken(req);
    req.session.save((saveErr) => {
      if (saveErr) {
        res.status(500).json({ error: "Login failed" });
        return;
      }
      setCsrfCookie(res, csrfToken);
      res.json({
        ok: true,
        user: {
          id: user.id,
          username: user.username,
          isAdmin: Number(user.is_admin) === 1,
          mustChangePassword: Number(user.must_change_password) === 1
        }
      });
    });
  });
});

router.post("/logout", async (req, res) => {
  if (!req.session) {
    res.json({ ok: true });
    return;
  }
  if (req.session.userId) {
    const expected = req.session.csrfToken;
    const provided = req.headers["x-csrf-token"];
    if (!safeTokenEquals(expected, provided)) {
      res.status(403).json({ error: "Invalid CSRF token" });
      return;
    }
  }
  req.session.destroy(() => {
    res.clearCookie("connect.sid");
    res.clearCookie("csrf-token");
    res.json({ ok: true });
  });
});

router.get("/me", async (req, res) => {
  if (!req.session || !req.session.userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const user = await dbOps.get(
    "SELECT id, username, created_at, COALESCE(is_admin, 0) AS is_admin, COALESCE(must_change_password, 0) AS must_change_password FROM users WHERE id = ?",
    [req.session.userId]
  );
  if (!user) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const csrfToken = ensureCsrfToken(req);
  req.session.user = {
    id: user.id,
    username: user.username,
    isAdmin: Number(user.is_admin) === 1,
    mustChangePassword: Number(user.must_change_password) === 1
  };
  setCsrfCookie(res, csrfToken);
  res.json({
    ok: true,
    user: {
      id: user.id,
      username: user.username,
      isAdmin: Number(user.is_admin) === 1,
      mustChangePassword: Number(user.must_change_password) === 1
    }
  });
});

router.post("/change-password", async (req, res) => {
  if (!req.session || !req.session.userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const expected = req.session.csrfToken;
  const provided = req.headers["x-csrf-token"];
  if (!safeTokenEquals(expected, provided)) {
    res.status(403).json({ error: "Invalid CSRF token" });
    return;
  }

  const { currentPassword, newPassword } = req.body || {};
  if (!currentPassword || !newPassword) {
    res.status(400).json({ error: "Missing currentPassword or newPassword" });
    return;
  }
  if (String(newPassword).length < 10) {
    res.status(400).json({ error: "New password must be at least 10 characters" });
    return;
  }

  const user = await dbOps.get("SELECT * FROM users WHERE id = ?", [req.session.userId]);
  if (!user) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const ok = await bcrypt.compare(String(currentPassword), user.password_hash);
  if (!ok) {
    res.status(401).json({ error: "Current password is invalid" });
    return;
  }

  const hash = await bcrypt.hash(String(newPassword), 10);
  await dbOps.run(
    "UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?",
    [hash, user.id]
  );

  req.session.user = {
    id: user.id,
    username: user.username,
    isAdmin: Number(user.is_admin) === 1,
    mustChangePassword: false
  };

  res.json({
    ok: true,
    user: req.session.user
  });
});

export default router;
