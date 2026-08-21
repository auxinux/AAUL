// Main entry point for the Express server. Supports HTTP and HTTPS
// simultaneously, each on its own port.

import express from "express";
import path from "path";
import fs from "fs";
import http from "http";
import https from "https";
import session from "express-session";
import connectSqlite3 from "connect-sqlite3";
import { fileURLToPath } from "url";
import config from "./config.js";
import { initDb } from "./db/index.js";
import { loadCertificates, watchCertificates } from "./utils/ssl.js";
import { loadAllPlugins, triggerHook, notifyServerReady } from "./plugins/plugin-loader.js";
import { addSSEClient } from "./utils/sse.js";
import { startMonitor } from "./utils/monitor.js";
import { requireAdmin } from "./middleware/auth.js";

// Route imports
import authRoutes from "./routes/auth.js";
import usersRoutes from "./routes/users.js";
import agentsRoutes from "./routes/agents.js";
import agentApiRoutes from "./routes/agent-api.js";
import installRoutes from "./routes/install.js";
import bundleRoutes from "./routes/bundle.js";
import adminRoutes from "./routes/admin.js";
import settingsRoutes from "./routes/settings.js";
import pluginsRoutes from "./routes/plugins.js";
import notificationsRoutes from "./routes/notifications.js";
import groupsRoutes from "./routes/groups.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, "..", "..");

await initDb();

const app = express();

const httpsEnabled = config.https?.enabled === true;
const httpEnabled = config.http?.enabled !== false;

app.disable("x-powered-by");
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-XSS-Protection", "1; mode=block");
  if (req.secure || httpsEnabled) {
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
  next();
});

// Always trust the first proxy so req.ip reflects the real client IP
// even behind an HTTP reverse proxy. Required for accurate rate-limiting.
app.set("trust proxy", 1);

// Body parsing middleware. Keep the exact raw body so agent request signatures
// can be verified against the literal bytes (no JSON re-serialization agreement
// needed — immune to float/key-order/unicode formatting differences).
app.use(express.json({
  limit: "1mb",
  verify: (req, res, buf) => { req.rawBody = buf; }
}));
app.use(express.urlencoded({ extended: false }));

const SQLiteStore = connectSqlite3(session);
const dbDir = path.dirname(path.resolve(config.dbPath));
const sessionDb = path.basename(
  config.dbPath.endsWith(".sqlite")
    ? config.dbPath.replace(/\.sqlite$/, ".sessions.sqlite")
    : `${config.dbPath}.sessions.sqlite`
);

app.use(
  session({
    store: new SQLiteStore({
      db: sessionDb,
      dir: dbDir,
      table: "sessions"
    }),
    secret: config.sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "strict",
      secure: httpsEnabled
    }
  })
);

app.get("/health", (req, res) => {
  res.json({ ok: true, timestamp: new Date().toISOString() });
});

app.use("/api/auth", authRoutes);
app.use("/api/users", usersRoutes);
app.use("/api/agents", agentsRoutes);
app.use("/api/agent", agentApiRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/settings", settingsRoutes);
app.use("/api/plugins", pluginsRoutes);
app.use("/api/notifications", notificationsRoutes);
app.use("/api/groups", groupsRoutes);

app.get("/api/events", requireAdmin, (req, res) => {
  addSSEClient(req, res);
});

app.use("/install", installRoutes);
app.use("/agent", bundleRoutes);

await loadAllPlugins(app);

const uiDist = path.join(rootDir, "dashboard", "client", "dist");
if (process.env.NODE_ENV === "production" && fs.existsSync(uiDist)) {
  app.use(express.static(uiDist));
  app.get("*", (req, res) => {
    res.sendFile(path.join(uiDist, "index.html"));
  });
}

const servers = [];
let httpServer = null;
let httpsServer = null;

if (httpEnabled) {
  const httpPort = config.http?.apiPort || 3001;
  httpServer = http.createServer(app);

  httpServer.listen(httpPort, config.host, () => {
    console.log(`HTTP API listening on http://${config.host}:${httpPort}`);
  });

  servers.push(httpServer);
}

if (httpsEnabled) {
  const httpsPort = config.https?.apiPort || 3002;
  const httpsOptions = loadCertificates({
    enabled: true,
    keyPath: config.https?.keyPath,
    certPath: config.https?.certPath,
    caPath: config.https?.caPath
  });

  if (httpsOptions) {
    httpsServer = https.createServer(httpsOptions, app);

    httpsServer.listen(httpsPort, config.host, () => {
      console.log(`HTTPS API listening on https://${config.host}:${httpsPort}`);
    });

    servers.push(httpsServer);

    watchCertificates(config.https, (newOptions) => {
      console.log("[SSL] Certificates changed. Restart server to apply.");
    });
  } else {
    console.error("HTTPS enabled but certificates failed to load!");
  }
}

console.log("");
console.log(`Agent Auto Update Dashboard - Server Started`);
if (httpEnabled) {
  console.log(`  HTTP API:  http://${config.host}:${config.http?.apiPort || 3001}`);
}
if (httpsEnabled) {
  console.log(`  HTTPS API: https://${config.host}:${config.https?.apiPort || 3002}`);
}
console.log(`  Default API Protocol: ${config.defaultApiProtocol || 'http'}`);
console.log("");

await triggerHook("server:start", config);
await notifyServerReady({ app, httpServer, httpsServer });

startMonitor();

const shutdown = async (signal) => {
  console.log(`Received ${signal}, shutting down gracefully...`);
  await triggerHook("server:stop");

  for (const server of servers) {
    server.close();
  }

  console.log("Server closed");
  process.exit(0);
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
