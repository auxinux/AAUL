// Rules for a machine's command queue, shared by the dashboard routes, group
// actions and the local CLI so the three cannot drift apart. The poll route
// hands out the oldest QUEUED command once nothing is IN_PROGRESS, so each
// machine runs its commands one at a time, in the order they were sent.

export const MAX_PENDING_COMMANDS = 10;

// Returns { error, status } when refused, { duplicateId } when the same command
// is already waiting, or {} when the command can join the queue.
export async function checkCommandQueue(dbOps, agentId, type, payload) {
  const pending = await dbOps.all(
    "SELECT id, type, status, payload_json FROM commands WHERE agent_id = ? AND status IN ('QUEUED','IN_PROGRESS') ORDER BY created_at ASC",
    [agentId]
  );
  // Nothing may follow an uninstall: the machine will not come back for it.
  if (pending.some((command) => command.type === "UNINSTALL")) {
    return { error: "Agent is being uninstalled", status: 409 };
  }
  const serializedPayload = payload ? JSON.stringify(payload) : null;
  const duplicate = pending.find(
    (command) =>
      command.status === "QUEUED" &&
      command.type === type &&
      (command.payload_json || null) === serializedPayload
  );
  if (duplicate) {
    return { duplicateId: duplicate.id };
  }
  if (pending.length >= MAX_PENDING_COMMANDS) {
    return { error: `Command queue is full (${MAX_PENDING_COMMANDS} pending)`, status: 409 };
  }
  return {};
}
