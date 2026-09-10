/**
 * Server-Sent Events (SSE) utility
 *
 * Manages connected browser clients and broadcasts real-time events
 * when agents check in or commands complete.
 */
import { dbOps } from "../db/index.js";
import { applyAgentFilters } from "../plugins/plugin-loader.js";

// res -> req, kept so agent-scoped events can be re-checked per client
// against the same filters a multi-tenant plugin applies to the REST API.
const clients = new Map();

/**
 * Register a new SSE client. Configures the response headers and
 * removes the client when the connection closes.
 */
export function addSSEClient(req, res) {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no"); // Disable nginx buffering
  res.flushHeaders();

  res.write("event: connected\ndata: {}\n\n");

  clients.set(res, req);

  req.on("close", () => {
    clients.delete(res);
  });
}

/**
 * Broadcast an SSE event to connected browser clients.
 *
 * AAUL-Cloud: when the payload names a specific agentId, each client is
 * re-checked against applyAgentFilters before receiving the event — without
 * this, a tenant-isolation plugin would hide another tenant's agents from
 * every REST endpoint but still leak their id and online/offline state
 * through this same stream, since it broadcast to every open browser tab.
 * Events without an agentId (e.g. "update:available") carry no tenant data
 * and are still sent to everyone.
 *
 * @param {string} event  - event name (e.g. "agent:update")
 * @param {object} data   - JSON-serialisable payload
 */
export async function broadcastSSE(event, data) {
  if (clients.size === 0) return;
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

  let agent = null;
  if (data && data.agentId !== undefined && data.agentId !== null) {
    try {
      agent = await dbOps.get("SELECT * FROM agents WHERE id = ?", [data.agentId]);
    } catch (err) {
      console.error("[SSE] Agent lookup failed:", err.message);
    }
  }

  for (const [res, req] of clients) {
    if (agent) {
      try {
        if (!(await applyAgentFilters(agent, req))) continue;
      } catch (err) {
        console.error("[SSE] Agent filter error:", err.message);
      }
    }
    try {
      res.write(payload);
    } catch {
      clients.delete(res);
    }
  }
}

/** Return the number of currently connected SSE clients. */
export function getSSEClientCount() {
  return clients.size;
}
