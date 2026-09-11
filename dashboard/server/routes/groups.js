/**
 * Machine groups: CRUD + bulk actions on every agent of a group.
 */
import express from "express";
import { v4 as uuidv4 } from "uuid";
import { dbOps } from "../db/index.js";
import { requireAdmin } from "../middleware/auth.js";
import { broadcastSSE } from "../utils/sse.js";
import { GROUP_COMMAND_TYPES, validateCommandPayload } from "../utils/command-policy.js";
import { checkCommandQueue } from "../utils/command-queue.js";
import { applyAgentFilters } from "../plugins/plugin-loader.js";

const router = express.Router();

function isValidName(name) {
  return typeof name === "string" && name.trim().length > 0 && name.trim().length <= 64
    && !/[\r\n\t\0]/.test(name);
}

router.get("/", requireAdmin, async (req, res) => {
  const groups = await dbOps.all("SELECT * FROM groups ORDER BY position ASC, id ASC");
  const counts = await dbOps.all(
    "SELECT group_id, COUNT(*) AS count FROM agents WHERE group_id IS NOT NULL GROUP BY group_id"
  );
  const countByGroup = Object.fromEntries(counts.map((c) => [c.group_id, c.count]));
  res.json({
    ok: true,
    groups: groups.map((g) => ({
      id: g.id,
      name: g.name,
      color: g.color || null,
      position: g.position ?? 0,
      agentCount: countByGroup[g.id] || 0
    }))
  });
});

router.post("/", requireAdmin, async (req, res) => {
  const { name, color } = req.body || {};
  if (!isValidName(name)) {
    res.status(400).json({ error: "Invalid group name" });
    return;
  }
  const existing = await dbOps.get("SELECT id FROM groups WHERE name = ?", [name.trim()]);
  if (existing) {
    res.status(409).json({ error: "Group already exists" });
    return;
  }
  const max = await dbOps.get("SELECT COALESCE(MAX(position), -1) AS m FROM groups");
  await dbOps.run(
    "INSERT INTO groups (name, color, position, created_at) VALUES (?, ?, ?, ?)",
    [name.trim(), color || null, (max?.m ?? -1) + 1, new Date().toISOString()]
  );
  res.json({ ok: true });
});

router.put("/:id", requireAdmin, async (req, res) => {
  const { name, color } = req.body || {};
  const group = await dbOps.get("SELECT id FROM groups WHERE id = ?", [req.params.id]);
  if (!group) {
    res.status(404).json({ error: "Group not found" });
    return;
  }
  if (name !== undefined) {
    if (!isValidName(name)) {
      res.status(400).json({ error: "Invalid group name" });
      return;
    }
    await dbOps.run("UPDATE groups SET name = ? WHERE id = ?", [name.trim(), req.params.id]);
  }
  if (color !== undefined) {
    await dbOps.run("UPDATE groups SET color = ? WHERE id = ?", [color || null, req.params.id]);
  }
  res.json({ ok: true });
});

router.delete("/:id", requireAdmin, async (req, res) => {
  await dbOps.run("UPDATE agents SET group_id = NULL WHERE group_id = ?", [req.params.id]);
  await dbOps.run("DELETE FROM groups WHERE id = ?", [req.params.id]);
  res.json({ ok: true });
});

// Queue an action for every agent in the group. It joins each machine's queue;
// a machine is skipped when the same action is already waiting there, when it
// is being uninstalled, or when its queue is full.
// AAUL-Cloud: seuls les agents autorisés par les filtres de plugins reçoivent la commande.
router.post("/:id/action", requireAdmin, async (req, res) => {
  const { type } = req.body || {};
  if (!GROUP_COMMAND_TYPES.has(type)) {
    res.status(400).json({ error: "Unsupported group action" });
    return;
  }
  const policy = validateCommandPayload(type, null);
  if (!policy.ok) {
    res.status(400).json({ error: policy.error });
    return;
  }
  const agents = await dbOps.all("SELECT id FROM agents WHERE group_id = ?", [req.params.id]);
  let queued = 0;
  for (const agent of agents) {
    // AAUL-Cloud: ne pas exécuter de commande sur un agent exclu par les filtres
    if (!(await applyAgentFilters(agent, req))) continue;
    const queue = await checkCommandQueue(dbOps, agent.id, type, null);
    if (queue.error || queue.duplicateId) continue;
    const now = new Date().toISOString();
    await dbOps.run(
      "INSERT INTO commands (id, agent_id, type, payload_json, status, created_at, updated_at) VALUES (?, ?, ?, NULL, 'QUEUED', ?, ?)",
      [uuidv4(), agent.id, type, now, now]
    );
    queued += 1;
  }
  broadcastSSE("command:update", { groupId: Number(req.params.id) });
  res.json({ ok: true, queued, total: agents.length });
});

export default router;
