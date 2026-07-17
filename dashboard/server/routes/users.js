import express from "express";
import bcrypt from "bcrypt";
import { dbOps } from "../db/index.js";
import { requireAdmin } from "../middleware/auth.js";

const router = express.Router();

const MIN_PASSWORD_LENGTH = 10;

function isPasswordTooWeak(password) {
  return String(password).length < MIN_PASSWORD_LENGTH;
}

router.get("/", requireAdmin, async (req, res) => {
  const users = await dbOps.all(
    "SELECT id, username, created_at, COALESCE(is_admin, 0) AS is_admin, COALESCE(must_change_password, 0) AS must_change_password FROM users ORDER BY id ASC"
  );
  res.json({
    ok: true,
    users: users.map((user) => ({
      id: user.id,
      username: user.username,
      created_at: user.created_at,
      isAdmin: Number(user.is_admin) === 1,
      mustChangePassword: Number(user.must_change_password) === 1
    }))
  });
});

router.post("/", requireAdmin, async (req, res) => {
  const { username, password, isAdmin } = req.body || {};
  if (!username || !password) {
    res.status(400).json({ error: "Missing username or password" });
    return;
  }
  if (isPasswordTooWeak(password)) {
    res.status(400).json({ error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` });
    return;
  }
  const existing = await dbOps.get(
    "SELECT id FROM users WHERE username = ?",
    [username]
  );
  if (existing) {
    res.status(409).json({ error: "Username already exists" });
    return;
  }
  const hash = await bcrypt.hash(password, 10);
  const now = new Date().toISOString();
  await dbOps.run(
    "INSERT INTO users (username, password_hash, created_at, is_admin, must_change_password) VALUES (?, ?, ?, ?, 0)",
    [username, hash, now, isAdmin ? 1 : 0]
  );
  res.json({ ok: true });
});

router.put("/:id/password", requireAdmin, async (req, res) => {
  const { password } = req.body || {};
  if (!password) {
    res.status(400).json({ error: "Missing password" });
    return;
  }
  if (isPasswordTooWeak(password)) {
    res.status(400).json({ error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` });
    return;
  }
  const hash = await bcrypt.hash(password, 10);
  await dbOps.run("UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?", [
    hash,
    req.params.id
  ]);
  res.json({ ok: true });
});

router.put("/:id/admin", requireAdmin, async (req, res) => {
  const { isAdmin } = req.body || {};
  if (typeof isAdmin !== "boolean") {
    res.status(400).json({ error: "Missing isAdmin boolean" });
    return;
  }
  const target = await dbOps.get(
    "SELECT id, COALESCE(is_admin, 0) AS is_admin FROM users WHERE id = ?",
    [req.params.id]
  );
  if (!target) {
    res.status(404).json({ error: "User not found" });
    return;
  }
  if (String(req.session.userId) === String(req.params.id) && !isAdmin) {
    res.status(400).json({ error: "Cannot remove your own admin role" });
    return;
  }
  if (!isAdmin && Number(target.is_admin) === 1) {
    const adminCount = await dbOps.get(
      "SELECT COUNT(*) AS count FROM users WHERE COALESCE(is_admin, 0) = 1"
    );
    if (adminCount && Number(adminCount.count) <= 1) {
      res.status(400).json({ error: "At least one admin user is required" });
      return;
    }
  }
  await dbOps.run("UPDATE users SET is_admin = ? WHERE id = ?", [
    isAdmin ? 1 : 0,
    req.params.id
  ]);
  res.json({ ok: true });
});

router.delete("/:id", requireAdmin, async (req, res) => {
  if (String(req.session.userId) === String(req.params.id)) {
    res.status(400).json({ error: "Cannot delete your own account" });
    return;
  }
  const target = await dbOps.get(
    "SELECT id, COALESCE(is_admin, 0) AS is_admin FROM users WHERE id = ?",
    [req.params.id]
  );
  if (!target) {
    res.status(404).json({ error: "User not found" });
    return;
  }
  if (Number(target.is_admin) === 1) {
    const adminCount = await dbOps.get(
      "SELECT COUNT(*) AS count FROM users WHERE COALESCE(is_admin, 0) = 1"
    );
    if (adminCount && Number(adminCount.count) <= 1) {
      res.status(400).json({ error: "At least one admin user is required" });
      return;
    }
  }
  await dbOps.run("DELETE FROM users WHERE id = ?", [req.params.id]);
  res.json({ ok: true });
});

export default router;
