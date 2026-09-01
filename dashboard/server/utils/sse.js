/**
 * Server-Sent Events (SSE) utility
 *
 * Manages connected browser clients and broadcasts real-time events
 * when agents check in or commands complete.
 */

const clients = new Set();

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

  clients.add(res);

  req.on("close", () => {
    clients.delete(res);
  });
}

/**
 * Broadcast an SSE event to all connected browser clients.
 * @param {string} event  - event name (e.g. "agent:update")
 * @param {object} data   - JSON-serialisable payload
 */
export function broadcastSSE(event, data) {
  if (clients.size === 0) return;
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
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
