import { spawn } from "child_process";
import path from "path";
import fs from "fs";
import readline from "readline";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");

// Load config to get HTTP/HTTPS settings
const configPath = path.join(rootDir, "config", "config.json");
let config = JSON.parse(fs.readFileSync(configPath, "utf8"));

const processes = {};
const startTimes = new Map();
let shuttingDown = false;

function httpEnabled() {
  return config.http?.enabled !== false;
}

function httpsEnabled() {
  return config.https?.enabled === true;
}

function getApiUrl(protocol) {
  if (protocol === "https" && httpsEnabled()) {
    const port = config.https?.apiPort || 3002;
    return `https://127.0.0.1:${port}`;
  }
  if (protocol === "http" && httpEnabled()) {
    const port = config.http?.apiPort || 3001;
    return `http://127.0.0.1:${port}`;
  }
  if (httpsEnabled()) {
    const port = config.https?.apiPort || 3002;
    return `https://127.0.0.1:${port}`;
  }
  const port = config.http?.apiPort || 3001;
  return `http://127.0.0.1:${port}`;
}

function start(name, command, env = {}) {
  if (processes[name] && !processes[name].killed) {
    console.log(`[dev] ${name} already running, stopping first...`);
    processes[name].kill("SIGINT");
  }

  const child = spawn(command, {
    cwd: rootDir,
    env: { ...process.env, ...env },
    shell: true,
    stdio: "inherit"
  });

  startTimes.set(name, Date.now());

  child.on("exit", (code, signal) => {
    if (signal) {
      return;
    }
    if (code !== 0) {
      console.log(`[dev] ${name} exited with code ${code}.`);
    }
    if (!shuttingDown && name === "server") {
      const startedAt = startTimes.get(name) || Date.now();
      const elapsed = Date.now() - startedAt;
      if (code !== 0 && elapsed < 2000) {
        console.log("[dev] API server failed quickly. Not restarting to avoid loop.");
        console.log("[dev] Check if port is in use and restart manually.");
        return;
      }
      console.log("[dev] API server exited. Restarting in 1s...");
      setTimeout(() => start("server", "node server/index.js"), 1000);
    }
  });

  processes[name] = child;
}

function stopAll() {
  shuttingDown = true;
  for (const [name, child] of Object.entries(processes)) {
    if (child && !child.killed) {
      console.log(`[dev] Stopping ${name}...`);
      child.kill("SIGINT");
    }
  }
}

function shutdown(code) {
  stopAll();
  process.exit(code ?? 0);
}

function restartAll() {
  console.log("\n[dev] Restarting all services...\n");
  shuttingDown = true;
  stopAll();
  setTimeout(() => {
    shuttingDown = false;
    startServices();
  }, 1000);
}

function startServices() {
  // Start API server
  start("server", "node server/index.js");

  // Start Vite HTTP server
  if (httpEnabled()) {
    const viteEnvHttp = {
      VITE_PROTOCOL: "http",
      VITE_PORT: String(config.http?.webPort || 5173),
      VITE_API_URL: getApiUrl("http")
    };
    start("client-http", "npm --prefix client run dev", viteEnvHttp);
  }

  // Start Vite HTTPS server
  if (httpsEnabled()) {
    const viteEnvHttps = {
      VITE_PROTOCOL: "https",
      VITE_PORT: String(config.https?.webPort || 5174),
      VITE_API_URL: getApiUrl("https")
    };
    start("client-https", "npm --prefix client run dev", viteEnvHttps);
  }
}

function enableHttp() {
  console.log("\n[dev] Enabling HTTP mode...\n");
  config.http = config.http || {};
  config.http.enabled = true;
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  restartAll();
}

function showHelp() {
  console.log(`
  ╔════════════════════════════════════════════╗
  ║         Dev Server Commands                ║
  ╠════════════════════════════════════════════╣
  ║  r + Enter     Restart all services        ║
  ║  q + Enter     Stop and quit               ║
  ║  http + Enter  Enable HTTP mode            ║
  ║  h + Enter     Show this help              ║
  ╚════════════════════════════════════════════╝
  `);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

// Start services
console.log(`
╔════════════════════════════════════════════════════════════╗
║           Agent Auto Update - Dev Server                   ║
╠════════════════════════════════════════════════════════════╣
║  HTTP:      ${httpEnabled() ? `Enabled (API ${config.http?.apiPort || 3001}, WEB ${config.http?.webPort || 5173})` : "Disabled"}   ║
║  HTTPS:     ${httpsEnabled() ? `Enabled (API ${config.https?.apiPort || 3002}, WEB ${config.https?.webPort || 5174})` : "Disabled"}  ║
║  Default:   ${(config.defaultApiProtocol || "http").toUpperCase().padEnd(33)}║
╠════════════════════════════════════════════════════════════╣
║  Commands:  r=restart  q=quit  http=enable HTTP  h=help    ║
╚════════════════════════════════════════════════════════════╝
`);

startServices();

// Interactive terminal
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

rl.on("line", (input) => {
  const cmd = input.trim().toLowerCase();
  switch (cmd) {
    case "r":
      restartAll();
      break;
    case "q":
      shutdown(0);
      break;
    case "http":
      enableHttp();
      break;
    case "h":
      showHelp();
      break;
    default:
      if (cmd) {
        console.log(`Unknown command: ${cmd}. Type 'h' for help.`);
      }
  }
});

rl.on("close", () => {
  shutdown(0);
});