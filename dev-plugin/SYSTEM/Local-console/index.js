import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import os from "os";
import crypto from "crypto";
import { requireAdmin } from "../../middleware/auth.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function renderHtml() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Local Console</title>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/xterm@5.3.0/css/xterm.min.css" />
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: #0b1220;
      color: #e2e8f0;
      font-family: ui-sans-serif, system-ui, -apple-system, sans-serif;
      height: 100vh;
      display: flex;
      flex-direction: column;
    }
    header {
      padding: 12px 20px;
      background: #0f172a;
      border-bottom: 1px solid #1f2937;
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex-shrink: 0;
    }
    .header-left {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .header-left strong { font-size: 16px; }
    .hint { font-size: 12px; color: #94a3b8; }
    .status {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 13px;
    }
    .status-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: #ef4444;
    }
    .status-dot.connected { background: #10b981; }
    .btn {
      background: #334155;
      border: none;
      color: white;
      padding: 6px 12px;
      border-radius: 6px;
      cursor: pointer;
      font-size: 13px;
      transition: background 0.15s;
    }
    .btn:hover { background: #475569; }
    .btn-danger { background: #dc2626; }
    .btn-danger:hover { background: #ef4444; }
    #terminal-container {
      flex: 1;
      padding: 12px;
      overflow: hidden;
    }
    #terminal {
      height: 100%;
      border-radius: 8px;
      overflow: hidden;
    }
    .back-link {
      color: #60a5fa;
      text-decoration: none;
      font-size: 13px;
    }
    .back-link:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <header>
    <div class="header-left">
      <a href="/" class="back-link">← Dashboard</a>
      <strong>Local Console</strong>
      <span class="hint">Admin only</span>
    </div>
    <div class="status">
      <div class="status-dot" id="statusDot"></div>
      <span id="statusText">Connecting...</span>
      <button class="btn" id="reconnectBtn" style="display:none;">Reconnect</button>
    </div>
  </header>
  <div id="terminal-container">
    <div id="terminal"></div>
  </div>

  <script src="https://cdn.jsdelivr.net/npm/xterm@5.3.0/lib/xterm.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/xterm-addon-fit@0.8.0/lib/xterm-addon-fit.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/xterm-addon-web-links@0.9.0/lib/xterm-addon-web-links.min.js"></script>
  <script>
    const term = new Terminal({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
      theme: {
        background: '#0f172a',
        foreground: '#e2e8f0',
        cursor: '#10b981',
        cursorAccent: '#0f172a',
        selection: 'rgba(16, 185, 129, 0.3)',
        black: '#1e293b',
        red: '#ef4444',
        green: '#10b981',
        yellow: '#f59e0b',
        blue: '#3b82f6',
        magenta: '#a855f7',
        cyan: '#06b6d4',
        white: '#e2e8f0',
        brightBlack: '#475569',
        brightRed: '#f87171',
        brightGreen: '#34d399',
        brightYellow: '#fbbf24',
        brightBlue: '#60a5fa',
        brightMagenta: '#c084fc',
        brightCyan: '#22d3ee',
        brightWhite: '#f8fafc'
      }
    });

    const fitAddon = new FitAddon.FitAddon();
    const webLinksAddon = new WebLinksAddon.WebLinksAddon();

    term.loadAddon(fitAddon);
    term.loadAddon(webLinksAddon);
    term.open(document.getElementById('terminal'));
    fitAddon.fit();

    const statusDot = document.getElementById('statusDot');
    const statusText = document.getElementById('statusText');
    const reconnectBtn = document.getElementById('reconnectBtn');

    let ws = null;
    let reconnectAttempts = 0;
    const maxReconnectAttempts = 5;

    function updateStatus(connected, text) {
      statusDot.classList.toggle('connected', connected);
      statusText.textContent = text;
      reconnectBtn.style.display = connected ? 'none' : 'inline-block';
    }

    function connect() {
      const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      updateStatus(false, 'Connecting...');
      reconnectBtn.style.display = 'none';

      fetch('/api/local-console/ws-info', { credentials: 'include' })
        .then((res) => {
          if (!res.ok) {
            throw new Error('Unauthorized');
          }
          return res.json();
        })
        .then((info) => {
          if (!info.wsToken) {
            throw new Error('Missing websocket token');
          }
          const wsPath = info.wsPath || '/api/local-console/ws';
          const wsUrl = protocol + '//' + location.host + wsPath + '?token=' + encodeURIComponent(info.wsToken);
          ws = new WebSocket(wsUrl);

          ws.onopen = () => {
            updateStatus(true, 'Connected');
            reconnectAttempts = 0;
            ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
          };

          ws.onmessage = (event) => {
            term.write(event.data);
          };

          ws.onclose = (event) => {
            updateStatus(false, 'Disconnected');
            if (reconnectAttempts < maxReconnectAttempts && event.code !== 4403) {
              reconnectAttempts++;
              setTimeout(connect, 1000 * reconnectAttempts);
              updateStatus(false, 'Reconnecting (' + reconnectAttempts + '/' + maxReconnectAttempts + ')...');
            }
          };

          ws.onerror = () => {
            updateStatus(false, 'Connection error');
          };
        })
        .catch(() => {
          updateStatus(false, 'Authentication required');
        });
    }

    term.onData((data) => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'input', data }));
      }
    });

    window.addEventListener('resize', () => {
      fitAddon.fit();
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
      }
    });

    reconnectBtn.addEventListener('click', () => {
      reconnectAttempts = 0;
      connect();
    });

    connect();
    term.focus();
  </script>
</body>
</html>`;
}

const ptySessions = new Map();
const wsAuthTokens = new Map();
const WS_TOKEN_TTL_MS = 60 * 1000;

function cleanupExpiredWsTokens() {
  const now = Date.now();
  for (const [token, expiresAt] of wsAuthTokens.entries()) {
    if (expiresAt <= now) {
      wsAuthTokens.delete(token);
    }
  }
}

function issueWsToken() {
  cleanupExpiredWsTokens();
  const token = crypto.randomBytes(32).toString("hex");
  wsAuthTokens.set(token, Date.now() + WS_TOKEN_TTL_MS);
  return token;
}

function consumeWsToken(token) {
  cleanupExpiredWsTokens();
  if (!token || !wsAuthTokens.has(token)) {
    return false;
  }
  wsAuthTokens.delete(token);
  return true;
}

export default {
  name: "local-console",
  version: "2.0.0",
  displayName: "Local Console",
  description: "Real interactive terminal for the dashboard host (admin only)",

  _wss: null,

  async onLoad(context) {
    const { registerRoute, registerUI, log } = context;

    registerUI("nav:item", {
      label: "Console",
      href: "/local-console",
      icon: "🖥️",
      adminOnly: true
    });

    registerRoute("/local-console", {
      method: "GET",
      middleware: [requireAdmin],
      handler: (req, res) => {
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.send(renderHtml());
      }
    });

    registerRoute("/api/local-console/ws-info", {
      method: "GET",
      middleware: [requireAdmin],
      handler: (req, res) => {
        const wsToken = issueWsToken();
        res.json({ ok: true, wsPath: "/api/local-console/ws", wsToken });
      }
    });

    log("info", "Local Console plugin loaded. WebSocket will be initialized on server start.");
  },

  async onServerReady(context) {
    const { httpServer, httpsServer, log } = context;

    try {
      const { WebSocketServer } = await import("ws");
      let pty;
      try {
        pty = await import("@homebridge/node-pty-prebuilt-multiarch");
      } catch {
        pty = await import("node-pty");
      }

      const setupWss = (server, protocol) => {
        const wss = new WebSocketServer({
          noServer: true
        });

        server.on("upgrade", (request, socket, head) => {
          const url = new URL(request.url, `http://${request.headers.host}`);
          if (url.pathname !== "/api/local-console/ws") {
            return;
          }

          // Reject cross-site WebSocket hijacking. A missing Origin is
          // rejected too: real browsers always send it, so an absent
          // header signals a non-browser/forged client.
          const origin = request.headers.origin;
          const reqHost = request.headers.host;
          if (!origin) {
            socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
            socket.destroy();
            return;
          }
          try {
            const originHost = new URL(origin).host;
            if (originHost !== reqHost) {
              socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
              socket.destroy();
              return;
            }
          } catch {
            socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
            socket.destroy();
            return;
          }

          const token = url.searchParams.get("token");
          if (!consumeWsToken(token)) {
            socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
            socket.destroy();
            return;
          }

          wss.handleUpgrade(request, socket, head, (ws) => {
            wss.emit("connection", ws, request);
          });
        });

        wss.on("connection", async (ws, req) => {
          log("info", `Terminal WebSocket connection established (${protocol})`);

          const shellArgs = process.platform === "win32" ? [] : ["-l"];
          const possibleShells = process.platform === "win32"
            ? ["powershell.exe", "cmd.exe"]
            : ["/bin/sh", "/bin/bash", "/bin/zsh", process.env.SHELL].filter(Boolean);

          const resolvedShells = possibleShells.filter((candidate) => {
            try {
              fs.accessSync(candidate, fs.constants.X_OK);
              return true;
            } catch {
              return false;
            }
          });

          if (resolvedShells.length === 0) {
            ws.send("\r\n\x1b[31mError: No executable shell found on server.\x1b[0m\r\n");
            ws.close(1011, "No shell available");
            return;
          }

          const cwdCandidates = [process.env.HOME, os.homedir(), process.cwd(), "/"].filter(Boolean);
          const resolvedCwds = cwdCandidates.filter((candidate) => {
            try {
              return fs.statSync(candidate).isDirectory();
            } catch {
              return false;
            }
          });

          const baseEnv = {
            TERM: "xterm-256color",
            COLORTERM: "truecolor",
            LANG: process.env.LANG || "en_US.UTF-8",
            PATH: process.env.PATH || "/usr/bin:/bin:/usr/sbin:/sbin",
            HOME: process.env.HOME || os.homedir() || "/"
          };

          // Try each shell against each candidate cwd until one spawns successfully.
          let ptyProcess;
          let lastError;
          for (const shell of resolvedShells) {
            for (const cwd of resolvedCwds) {
              try {
                log("info", `Using shell: ${shell} (cwd=${cwd})`);
                ptyProcess = pty.spawn(shell, shellArgs, {
                  name: "xterm-256color",
                  cols: 80,
                  rows: 24,
                  cwd,
                  env: baseEnv
                });
                break;
              } catch (err) {
                lastError = err;
                const code = err?.code ? ` code=${err.code}` : "";
                const errno = err?.errno ? ` errno=${err.errno}` : "";
                const syscall = err?.syscall ? ` syscall=${err.syscall}` : "";
                log("warn", `PTY spawn failed for ${shell} (cwd=${cwd}): ${err.message}${code}${errno}${syscall}`);
              }
            }
            if (ptyProcess) break;
          }

          if (!ptyProcess) {
            const message = lastError?.message || "Unknown error";
            const code = lastError?.code ? ` code=${lastError.code}` : "";
            const errno = lastError?.errno ? ` errno=${lastError.errno}` : "";
            const syscall = lastError?.syscall ? ` syscall=${lastError.syscall}` : "";
            log("error", `Failed to spawn PTY after retries: ${message}${code}${errno}${syscall}`);
            ws.send(`\r\n\x1b[31mError: Failed to start terminal: ${message}\x1b[0m\r\n`);
            ws.close(1011, "PTY spawn failed");
            return;
          }

          ptySessions.set(ws, ptyProcess);

          ptyProcess.onData((data) => {
            if (ws.readyState === 1) { // WebSocket.OPEN
              ws.send(data);
            }
          });

          ptyProcess.onExit(({ exitCode }) => {
            log("info", `Terminal process exited with code ${exitCode}`);
            ptySessions.delete(ws);
            if (ws.readyState === 1) {
              ws.close(1000, "Process exited");
            }
          });

          ws.on("message", (message) => {
            try {
              const msg = JSON.parse(message.toString());

              if (msg.type === "input") {
                ptyProcess.write(msg.data);
              } else if (msg.type === "resize") {
                ptyProcess.resize(msg.cols || 80, msg.rows || 24);
              }
            } catch (e) {
              // Not JSON — treat as raw input
              ptyProcess.write(message.toString());
            }
          });

          ws.on("close", () => {
            log("info", "Terminal WebSocket closed");
            const pty = ptySessions.get(ws);
            if (pty) {
              pty.kill();
              ptySessions.delete(ws);
            }
          });

          ws.on("error", (err) => {
            log("error", `WebSocket error: ${err.message}`);
            const pty = ptySessions.get(ws);
            if (pty) {
              pty.kill();
              ptySessions.delete(ws);
            }
          });
        });

        return wss;
      };

      if (httpServer) {
        this._wssHttp = setupWss(httpServer, "HTTP");
        log("info", "WebSocket server attached to HTTP server");
      }

      if (httpsServer) {
        this._wssHttps = setupWss(httpsServer, "HTTPS");
        log("info", "WebSocket server attached to HTTPS server");
      }
    } catch (err) {
      log("error", `Failed to initialize WebSocket/PTY: ${err.message}`);
    }
  },

  async onUnload() {
    for (const [ws, pty] of ptySessions) {
      pty.kill();
      ws.close(1001, "Plugin unloading");
    }
    ptySessions.clear();

    if (this._wssHttp) {
      this._wssHttp.close();
      this._wssHttp = null;
    }
    if (this._wssHttps) {
      this._wssHttps.close();
      this._wssHttps = null;
    }
  }
};
