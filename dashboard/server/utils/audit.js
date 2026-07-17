import { v4 as uuidv4 } from "uuid";
import { dbOps } from "../db/index.js";

function safeDetails(details) {
  if (!details || typeof details !== "object") {
    return null;
  }
  const redacted = {};
  for (const [key, value] of Object.entries(details)) {
    if (/token|password|secret|pass|auth/i.test(key)) {
      redacted[key] = "[redacted]";
    } else {
      redacted[key] = value;
    }
  }
  return redacted;
}

export async function recordAuditEvent({
  actorUserId = null,
  action,
  entityType,
  entityId = null,
  agentId = null,
  details = null
}) {
  if (!action || !entityType) {
    return;
  }
  try {
    await dbOps.run(
      `INSERT INTO audit_events (
        id,
        actor_user_id,
        action,
        entity_type,
        entity_id,
        agent_id,
        details_json,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        uuidv4(),
        actorUserId,
        action,
        entityType,
        entityId,
        agentId,
        details ? JSON.stringify(safeDetails(details)) : null,
        new Date().toISOString()
      ]
    );
  } catch (err) {
    console.error("[audit] failed to record event:", err?.message || err);
  }
}

export function getActorUserId(req) {
  return req?.session?.userId || req?.session?.user?.id || req?.user?.id || null;
}
