import config from "../config.js";
import { getSetting } from "./settings.js";

function sanitizeHost(value, fallback) {
  const raw = String(value || "").trim();
  if (/^[A-Za-z0-9.\-:\[\]]+$/.test(raw)) {
    return raw;
  }
  return fallback;
}

export async function resolveBaseUrl() {
  const publicIp = await getSetting("publicIp");
  const httpEnabled = config.http?.enabled !== false;
  const httpsEnabled = config.https?.enabled === true;

  let protocol = httpsEnabled ? "https" : "http";
  if (protocol === "http" && !httpEnabled && httpsEnabled) {
    protocol = "https";
  }

  const defaultHost = config.host && config.host !== "0.0.0.0" ? config.host : "localhost";
  const host = publicIp && publicIp.trim()
    ? sanitizeHost(publicIp.trim(), defaultHost)
    : defaultHost;

  const port = protocol === "https"
    ? (config.https?.apiPort || 3002)
    : (config.http?.apiPort || 3001);

  return `${protocol}://${host}:${port}`;
}
