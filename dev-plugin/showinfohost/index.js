import fs from "fs";
import os from "os";
import { execSync } from "child_process";
import { requireAuth } from "../../middleware/auth.js";

let lastCpuSample = null;
let lastNetSample = null;

function getCpuUsage() {
  const cpus = os.cpus();
  let idle = 0;
  let total = 0;

  for (const cpu of cpus) {
    for (const type in cpu.times) {
      total += cpu.times[type];
    }
    idle += cpu.times.idle;
  }

  if (!lastCpuSample) {
    lastCpuSample = { idle, total };
    return 0;
  }

  const idleDelta = idle - lastCpuSample.idle;
  const totalDelta = total - lastCpuSample.total;
  lastCpuSample = { idle, total };

  if (totalDelta <= 0) return 0;
  const usage = 100 - Math.round((idleDelta / totalDelta) * 100);
  return Math.max(0, Math.min(100, usage));
}

function readProcNetDev() {
  const procPath = "/proc/net/dev";
  if (!fs.existsSync(procPath)) return null;
  const content = fs.readFileSync(procPath, "utf8");
  const lines = content.split("\n").slice(2);
  let rx = 0;
  let tx = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    const [iface, data] = line.split(":");
    const parts = data.trim().split(/\s+/);
    rx += Number(parts[0] || 0);
    tx += Number(parts[8] || 0);
  }
  return { rx, tx };
}

function readNetstatBytes() {
  try {
    const output = execSync("netstat -ib -n", { stdio: ["ignore", "pipe", "ignore"] })
      .toString();
    const lines = output.split("\n").slice(1);
    let rx = 0;
    let tx = 0;
    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 10) continue;
      const iBytes = Number(parts[6] || 0);
      const oBytes = Number(parts[9] || 0);
      if (Number.isFinite(iBytes)) rx += iBytes;
      if (Number.isFinite(oBytes)) tx += oBytes;
    }
    return { rx, tx };
  } catch {
    return null;
  }
}

function getNetworkUsage() {
  const now = Date.now();
  const current = readProcNetDev() || readNetstatBytes();
  if (!current) {
    return { rxKbps: 0, txKbps: 0, supported: false };
  }

  if (!lastNetSample) {
    lastNetSample = { ...current, ts: now };
    return { rxKbps: 0, txKbps: 0, supported: true };
  }

  const elapsed = (now - lastNetSample.ts) / 1000;
  if (elapsed <= 0) {
    return { rxKbps: 0, txKbps: 0, supported: true };
  }

  const rxKbps = Math.max(0, ((current.rx - lastNetSample.rx) / 1024) / elapsed);
  const txKbps = Math.max(0, ((current.tx - lastNetSample.tx) / 1024) / elapsed);
  lastNetSample = { ...current, ts: now };

  return {
    rxKbps: Math.round(rxKbps),
    txKbps: Math.round(txKbps),
    supported: true
  };
}

function getPrimaryIp() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const addr of nets[name] || []) {
      if (addr.family === "IPv4" && !addr.internal) {
        return addr.address;
      }
    }
  }
  return "";
}

function getDiskInfo() {
  try {
    if (fs.statfsSync) {
      const stats = fs.statfsSync(process.cwd());
      const total = stats.bsize * stats.blocks;
      const free = stats.bsize * stats.bavail;
      return {
        diskTotalGb: Math.round(total / 1024 / 1024 / 1024),
        diskFreeGb: Math.round(free / 1024 / 1024 / 1024)
      };
    }
  } catch {}
  return { diskTotalGb: null, diskFreeGb: null };
}

function getStats() {
  const cpu = getCpuUsage();
  const cpuInfo = os.cpus();
  const cpuThreads = cpuInfo.length;
  const cpuCores = cpuInfo.length;
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;
  const memPercent = Math.round((usedMem / totalMem) * 100);
  const net = getNetworkUsage();
  const ip = getPrimaryIp();
  const disk = getDiskInfo();
  const osName = `${os.type()} ${os.arch()}`;
  const osVersion = os.release();

  return {
    time: new Date().toLocaleTimeString(),
    cpu,
    cpuCores,
    cpuThreads,
    memPercent,
    memUsedMb: Math.round(usedMem / 1024 / 1024),
    memTotalMb: Math.round(totalMem / 1024 / 1024),
    memUsedBytes: usedMem,
    memTotalBytes: totalMem,
    net,
    ip,
    osName,
    osVersion,
    ...disk
  };
}

function renderTopbar() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Show Info Host - Topbar</title>
  <style>
    body { margin: 0; background: transparent; color: #e2e8f0; font-family: ui-sans-serif, system-ui, -apple-system, sans-serif; }
    .bar { display: grid; grid-template-columns: 1fr auto 1fr; align-items: center; gap: 12px; background: #0f172a; border: 1px solid #1f2937; border-radius: 12px; padding: 10px 16px; }
    .time { justify-self: center; font-size: 18px; font-weight: 600; }
    .right { justify-self: end; display: flex; gap: 12px; font-size: 12px; color: #94a3b8; }
    .metric { display: inline-flex; align-items: center; gap: 6px; }
    .dot { width: 6px; height: 6px; border-radius: 50%; background: #10b981; }
  </style>
</head>
<body>
  <div class="bar">
    <div></div>
    <div class="time" id="time">--:--:--</div>
    <div class="right">
      <div class="metric"><span class="dot"></span><span id="cpu">CPU --%</span></div>
      <div class="metric"><span class="dot"></span><span id="ram">RAM --%</span></div>
      <div class="metric"><span class="dot"></span><span id="net">NET --/-- KB/s</span></div>
    </div>
  </div>

  <script>
    async function refresh() {
      try {
        const res = await fetch('/api/showinfohost/stats', { credentials: 'include' });
        const data = await res.json();
        document.getElementById('time').textContent = data.time;
        document.getElementById('cpu').textContent = 'CPU ' + data.cpu + '%';
        document.getElementById('ram').textContent = 'RAM ' + data.memPercent + '%';
        const rx = data.net?.rxKbps ?? 0;
        const tx = data.net?.txKbps ?? 0;
        document.getElementById('net').textContent = 'NET ' + rx + '/' + tx + ' KB/s';
      } catch (e) {}
    }
    refresh();
    setInterval(refresh, 1000);
  </script>
</body>
</html>`;
}

function renderPanel() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Show Info Host - Panel</title>
  <style>
    body { margin: 0; background: transparent; color: #e2e8f0; font-family: ui-sans-serif, system-ui, -apple-system, sans-serif; }
    .wrap { background: #0f172a; border: 1px solid #1f2937; border-radius: 12px; padding: 16px; }
    .grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }
    .card { background: #0b1220; border: 1px solid #1f2937; border-radius: 12px; padding: 12px; }
    .label { font-size: 12px; color: #94a3b8; }
    .value { font-size: 22px; font-weight: 600; margin-top: 6px; }
    .sub { font-size: 12px; color: #64748b; margin-top: 6px; }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="grid">
      <div class="card">
        <div class="label">Local Time</div>
        <div class="value" id="time">--:--:--</div>
      </div>
      <div class="card">
        <div class="label">CPU Usage</div>
        <div class="value" id="cpu">--%</div>
      </div>
      <div class="card">
        <div class="label">RAM Usage</div>
        <div class="value" id="ram">--%</div>
        <div class="sub" id="ramDetail">-- / -- MB</div>
      </div>
      <div class="card" style="grid-column: span 3;">
        <div class="label">Network</div>
        <div class="value" id="net">-- / -- KB/s</div>
      </div>
    </div>
  </div>

  <script>
    async function refresh() {
      try {
        const res = await fetch('/api/showinfohost/stats', { credentials: 'include' });
        const data = await res.json();
        document.getElementById('time').textContent = data.time;
        document.getElementById('cpu').textContent = data.cpu + '%';
        document.getElementById('ram').textContent = data.memPercent + '%';
        document.getElementById('ramDetail').textContent = data.memUsedMb + ' / ' + data.memTotalMb + ' MB';
        const rx = data.net?.rxKbps ?? 0;
        const tx = data.net?.txKbps ?? 0;
        document.getElementById('net').textContent = rx + ' / ' + tx + ' KB/s';
      } catch (e) {}
    }
    refresh();
    setInterval(refresh, 1000);
  </script>
</body>
</html>`;
}

export default {
  name: "showinfohost",
  version: "1.0.0",
  displayName: "Show Info Host",
  description: "Real-time host info widgets for the dashboard",

  async onLoad(context) {
    const { registerRoute, registerUI } = context;

    registerUI("layout:topbar", {
      type: "host-info",
      variant: "topbar"
    });

    registerUI("dashboard:after-agents", {
      type: "host-info",
      variant: "panel"
    });

    registerRoute("/showinfohost/topbar", {
      method: "GET",
      middleware: [requireAuth],
      handler: (req, res) => {
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.send(renderTopbar());
      }
    });

    registerRoute("/showinfohost/panel", {
      method: "GET",
      middleware: [requireAuth],
      handler: (req, res) => {
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.send(renderPanel());
      }
    });

    registerRoute("/api/showinfohost/stats", {
      method: "GET",
      middleware: [requireAuth],
      handler: (req, res) => {
        res.json(getStats());
      }
    });
  }
};
