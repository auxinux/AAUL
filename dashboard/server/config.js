// Loads configuration from config.json and environment variables.
// Environment variables take precedence over file configuration.

import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import crypto from "crypto";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, "..", "..");
const envPath = path.join(rootDir, "dashboard", ".env");

if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath });
}

const configPath = path.join(rootDir, "dashboard", "config", "config.json");
const fileConfig = JSON.parse(fs.readFileSync(configPath, "utf8"));

function parseHttpFromEnv() {
  if (process.env.HTTP_ENABLED === undefined
      && process.env.HTTP_API_PORT === undefined
      && process.env.HTTP_WEB_PORT === undefined) {
    return undefined;
  }
  return {
    enabled: process.env.HTTP_ENABLED === "false" ? false : true,
    apiPort: process.env.HTTP_API_PORT ? Number(process.env.HTTP_API_PORT) : 3001,
    webPort: process.env.HTTP_WEB_PORT ? Number(process.env.HTTP_WEB_PORT) : 5173
  };
}

function parseHttpsFromEnv() {
  if (process.env.HTTPS_ENABLED === undefined
      && process.env.HTTPS_API_PORT === undefined
      && process.env.HTTPS_WEB_PORT === undefined
      && process.env.HTTPS_KEY_PATH === undefined
      && process.env.HTTPS_CERT_PATH === undefined) {
    return undefined;
  }
  return {
    enabled: process.env.HTTPS_ENABLED === "true",
    apiPort: process.env.HTTPS_API_PORT ? Number(process.env.HTTPS_API_PORT) : 3002,
    webPort: process.env.HTTPS_WEB_PORT ? Number(process.env.HTTPS_WEB_PORT) : 5174,
    keyPath: process.env.HTTPS_KEY_PATH || "./ssl/server.key",
    certPath: process.env.HTTPS_CERT_PATH || "./ssl/server.crt",
    caPath: process.env.HTTPS_CA_PATH || ""
  };
}

// Overrides config.json values when set
const envConfig = {
  host: process.env.HOST,
  dbPath: process.env.DB_PATH,
  sessionSecret: process.env.SESSION_SECRET,
  allowHttpInstall: process.env.ALLOW_HTTP_INSTALL === "true" ? true : 
                    process.env.ALLOW_HTTP_INSTALL === "false" ? false : undefined,
  agentDefaultPollSeconds: process.env.AGENT_DEFAULT_POLL_SECONDS
    ? Number(process.env.AGENT_DEFAULT_POLL_SECONDS)
    : undefined,
  agentDefaultScheduleEnabled: process.env.AGENT_DEFAULT_SCHEDULE_ENABLED
    ? Number(process.env.AGENT_DEFAULT_SCHEDULE_ENABLED)
    : undefined,
  agentDefaultDailyTime: process.env.AGENT_DEFAULT_DAILY_TIME,
  logLevel: process.env.LOG_LEVEL,
  http: parseHttpFromEnv(),
  https: parseHttpsFromEnv(),
  defaultApiProtocol: process.env.DEFAULT_API_PROTOCOL,
  agentAutoUpdateEnabled: process.env.AGENT_AUTO_UPDATE_ENABLED === undefined
    ? undefined
    : process.env.AGENT_AUTO_UPDATE_ENABLED === "true",
  agentLocalWebEnabled: process.env.AGENT_LOCAL_WEB_ENABLED === "true" ? true : undefined,
  agentLocalWebPort: process.env.AGENT_LOCAL_WEB_PORT 
    ? Number(process.env.AGENT_LOCAL_WEB_PORT) 
    : undefined
};

const config = {
  ...fileConfig,
  ...Object.fromEntries(
    Object.entries(envConfig).filter(([, value]) => value !== undefined)
  )
};

function resolveDashboardPath(targetPath) {
  if (!targetPath) {
    return path.join(rootDir, "dashboard");
  }
  if (path.isAbsolute(targetPath)) {
    return targetPath;
  }
  return path.resolve(path.join(rootDir, "dashboard"), targetPath);
}

function ensureSecretFile(filePath, bytes) {
  if (fs.existsSync(filePath)) {
    const existing = fs.readFileSync(filePath, "utf8").trim();
    if (existing) {
      try {
        fs.chmodSync(filePath, 0o600);
      } catch {
        // Best effort only
      }
      return existing;
    }
  }

  const generated = crypto.randomBytes(bytes).toString("hex");
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${generated}\n`, { mode: 0o600 });
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // Best effort only
  }
  return generated;
}

const runtimeDbPath = resolveDashboardPath(config.dbPath || "./dashboard.sqlite");
config.dbPath = runtimeDbPath;
const runtimeDir = path.dirname(runtimeDbPath);
const sessionSecretPath = path.join(runtimeDir, ".session-secret");
const dataProtectionKeyPath = path.join(runtimeDir, ".data-protection-key");

if (!config.sessionSecret || config.sessionSecret === "change-me") {
  config.sessionSecret = ensureSecretFile(sessionSecretPath, 48);
  console.warn(
    `[SECURITY] SESSION_SECRET was missing/default. A persistent secret was stored in ${sessionSecretPath}.`
  );
}

config.dataProtectionKey =
  process.env.DATA_PROTECTION_KEY || ensureSecretFile(dataProtectionKeyPath, 32);

// Ensure HTTP/HTTPS config exists with defaults
if (!config.http) {
  config.http = {
    enabled: true,
    apiPort: 3001,
    webPort: 5173
  };
}

if (!config.https) {
  config.https = {
    enabled: false,
    apiPort: 3002,
    webPort: 5174,
    keyPath: "./ssl/server.key",
    certPath: "./ssl/server.crt",
    caPath: ""
  };
}

if (!config.defaultApiProtocol) {
  config.defaultApiProtocol = "http";
}

if (typeof config.agentAutoUpdateEnabled !== "boolean") {
  config.agentAutoUpdateEnabled = true;
}

export default config;
