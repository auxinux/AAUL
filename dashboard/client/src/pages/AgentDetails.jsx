import React, { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { 
  ArrowLeft, 
  RefreshCw, 
  Cpu, 
  HardDrive, 
  Network, 
  Package, 
  Activity, 
  Monitor,
  Settings,
  Shield,
  ShieldCheck,
  AlertTriangle,
  Zap,
  Globe,
  Clock,
  Info,
  Copy,
  Check,
  ExternalLink,
  ClipboardList,
  Gauge,
  MemoryStick,
  Users as UsersIcon
} from "lucide-react";
import { apiFetch } from "../lib/api.js";
import { useI18n } from "../lib/i18n.js";
import DonutChart from "../components/DonutChart.jsx";
import MetricBar, { Sparkline } from "../components/MetricBar.jsx";
import { LinuxIcon, AppleIcon, WindowsIcon } from "../components/OsIcons.jsx";

const POLL_INTERVAL_MS = 2000;
const MAX_POLL_ATTEMPTS = 120;

function formatDate(value, locale) {
  if (!value) {
    return "-";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleString(locale);
}

function formatBytes(size) {
  if (size === null || size === undefined || size === 0) {
    return "0 B";
  }
  if (size < 1024) {
    return `${size} B`;
  }
  if (size < 1024 * 1024) {
    return `${(size / 1024).toFixed(1)} KB`;
  }
  if (size < 1024 * 1024 * 1024) {
    return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  }
  return `${(size / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatDuration(totalSeconds) {
  if (totalSeconds === null || totalSeconds === undefined) {
    return "-";
  }
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) {
    return `${days}d ${hours}h ${minutes}m`;
  }
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`;
  }
  return `${seconds}s`;
}

export default function AgentDetails() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { t, lang } = useI18n();
  const [agent, setAgent] = useState(null);
  const [info, setInfo] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [error, setError] = useState("");
  const [infoError, setInfoError] = useState("");
  const [autoRequested, setAutoRequested] = useState(false);
  
  // Install command state
  const [installBundle, setInstallBundle] = useState(null);
  const [installPlatform, setInstallPlatform] = useState("linux");
  const [installCopied, setInstallCopied] = useState(false);

  // Local web interface state
  const [localWebEnabled, setLocalWebEnabled] = useState(false);
  const [localWebPort, setLocalWebPort] = useState(8180);
  const [localWebSaving, setLocalWebSaving] = useState(false);
  const [localWebMessage, setLocalWebMessage] = useState("");
  const allowedPorts = [8080, 8090, 8180, 8190];

  // Monitoring (down detection) state
  // Metric history for the sparklines. Loaded separately from the agent record
  // because it is a different shape and a different refresh cadence.
  const [metricHistory, setMetricHistory] = useState([]);

  const [monitorEnabled, setMonitorEnabled] = useState(true);
  const [monitorSaving, setMonitorSaving] = useState(false);

  // Antivirus health. The snapshot comes with the agent record; a check or a
  // scan replaces it with the fresh command result.
  const [antivirus, setAntivirus] = useState(null);
  const [antivirusCheckedAt, setAntivirusCheckedAt] = useState(null);
  const [antivirusBusy, setAntivirusBusy] = useState("");
  const [antivirusError, setAntivirusError] = useState("");
  const [antivirusMessage, setAntivirusMessage] = useState("");

  const saveMonitor = async (enabled) => {
    setMonitorSaving(true);
    setMonitorEnabled(enabled);
    try {
      await apiFetch(`/api/agents/${id}/monitor`, {
        method: "PUT",
        body: JSON.stringify({ enabled })
      });
    } catch {
      setMonitorEnabled(!enabled); // revert on failure
    } finally {
      setMonitorSaving(false);
    }
  };

  function copyInstallCommand() {
    const cmd = installBundle?.commands?.[installPlatform];
    if (!cmd) {
      return;
    }
    navigator.clipboard.writeText(cmd).then(() => {
      setInstallCopied(true);
      setTimeout(() => setInstallCopied(false), 2000);
    });
  }

  const loadAgent = async () => {
    setLoading(true);
    setError("");
    try {
      const data = await apiFetch(`/api/agents/${id}`);
      setAgent(data.agent || null);
      setInfo(data.info || null);
      setInstallBundle(
        data.install
          ? {
              commands: {
                linux: data.install.linux,
                macos: data.install.macos,
                windows: data.install.windows
              },
              urls: data.install.urls || {}
            }
          : null
      );
      // Load local web settings from agent
      if (data.agent?.localWeb) {
        setLocalWebEnabled(data.agent.localWeb.enabled);
        setLocalWebPort(data.agent.localWeb.port || 8180);
      }
      if (data.agent?.antivirus !== undefined) {
        setAntivirus(data.agent.antivirus);
        setAntivirusCheckedAt(data.agent.antivirusCheckedAt || null);
      }
      if (data.agent && data.agent.monitorEnabled !== undefined) {
        setMonitorEnabled(data.agent.monitorEnabled);
      }
    } catch (err) {
      setError(err.message || t("errors.loadAgentInfo"));
    } finally {
      setLoading(false);
    }
  };
  
  const saveLocalWebSettings = async () => {
    setLocalWebSaving(true);
    setLocalWebMessage("");
    try {
      await apiFetch(`/api/agents/${id}/local-web`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          enabled: localWebEnabled,
          port: localWebPort
        })
      });
      setLocalWebMessage(t("details.localWebSaved"));
      setTimeout(() => setLocalWebMessage(""), 3000);
    } catch (err) {
      setLocalWebMessage(err.message || t("errors.saveFailed"));
    } finally {
      setLocalWebSaving(false);
    }
  };

  useEffect(() => {
    loadAgent();
    setAutoRequested(false);
    
    // Auto-refresh agent data every 60 seconds
    const interval = setInterval(() => {
      loadAgent();
      // Also refresh system info if not currently refreshing
      if (!refreshing && !waiting) {
        refreshInfo();
      }
    }, 60000);
    
    return () => clearInterval(interval);
  }, [id]);

  const pollCommand = async (commandId) => {
    for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt += 1) {
      const data = await apiFetch(`/api/agents/${id}/commands/${commandId}`);
      if (data.command?.status === "DONE" || data.command?.status === "ERROR") {
        return data.command;
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
    throw new Error(t("errors.commandTimeout"));
  };

  const refreshInfo = async () => {
    setRefreshing(true);
    setInfoError("");
    setWaiting(true);
    try {
      const result = await apiFetch(`/api/agents/${id}/commands/info`, {
        method: "POST"
      });
      const command = await pollCommand(result.commandId);
      if (command.status === "ERROR") {
        setInfoError(command.errorMessage || t("errors.commandFailed"));
      } else {
        setInfo(command.result || null);
      }
    } catch (err) {
      setInfoError(err.message || t("errors.commandFailed"));
    } finally {
      setWaiting(false);
      setRefreshing(false);
    }
  };

  const checkAntivirus = async () => {
    setAntivirusBusy("status");
    setAntivirusError("");
    setAntivirusMessage("");
    try {
      const result = await apiFetch(`/api/agents/${id}/antivirus/status`, { method: "POST" });
      const command = await pollCommand(result.commandId);
      if (command.status === "ERROR") {
        setAntivirusError(command.errorMessage || t("errors.commandFailed"));
        return;
      }
      setAntivirus(command.result || null);
      setAntivirusCheckedAt(new Date().toISOString());
    } catch (err) {
      setAntivirusError(err.message || t("errors.commandFailed"));
    } finally {
      setAntivirusBusy("");
    }
  };

  const runAntivirusScan = async (scanType) => {
    setAntivirusBusy(scanType);
    setAntivirusError("");
    setAntivirusMessage("");
    try {
      const result = await apiFetch(`/api/agents/${id}/antivirus/scan`, {
        method: "POST",
        body: JSON.stringify({ scanType })
      });
      let command;
      try {
        command = await pollCommand(result.commandId);
      } catch {
        // A full scan runs far longer than the polling budget. It is still
        // going on the machine, and loadAgent() will pick up the stored
        // result — so this is information, not a failure.
        setAntivirusMessage(t("antivirus.scanStillRunning"));
        return;
      }
      if (command.status === "ERROR") {
        setAntivirusError(command.errorMessage || t("errors.commandFailed"));
        return;
      }
      const scan = command.result || {};
      const found = Number(scan.threatsFound) || 0;
      setAntivirusMessage(
        found > 0 ? t("antivirus.scanInfected", { n: found }) : t("antivirus.scanClean")
      );
      // The verdict belongs to the agent: re-read it rather than patching the
      // snapshot here from the scan alone.
      await checkAntivirus();
    } catch (err) {
      setAntivirusError(err.message || t("errors.commandFailed"));
    } finally {
      setAntivirusBusy("");
    }
  };

  useEffect(() => {
    if (loading || refreshing || autoRequested) {
      return;
    }
    if (agent && !info) {
      setAutoRequested(true);
      refreshInfo();
    }
  }, [agent, autoRequested, info, loading, refreshing]);

  const memory = info?.memory;
  const cpu = info?.cpu;
  const osInfo = info?.os;
  const packageManager = info?.packageManager;
  const disks = info?.disks || [];
  const ips = info?.ips || [];
  const gpus = info?.gpu || [];
  const repositories = info?.repositories || [];
  const packagesInstalled = info?.packagesInstalled ?? null;
  const infoUpdated = info?.collectedAt || agent?.lastInfoUpdatedAt;
  const uptimeSeconds =
    info?.uptimeSeconds ?? agent?.uptimeSeconds ?? null;
  const rebootRequired =
    info?.rebootRequired !== undefined
      ? info?.rebootRequired
      : agent?.rebootRequired;

  useEffect(() => {
    let mounted = true;
    const loadHistory = async () => {
      try {
        const data = await apiFetch(`/api/agents/${id}/metrics/history?hours=24`);
        if (mounted) setMetricHistory(data.points || []);
      } catch {
        if (mounted) setMetricHistory([]);
      }
    };
    loadHistory();
    // History moves slowly (one sample per 5 minutes server-side), so a
    // one-minute refresh is more than enough.
    const interval = setInterval(loadHistory, 60000);
    return () => {
      mounted = false;
      clearInterval(interval);
    };
  }, [id]);

  const metrics = agent?.metrics || null;

  return (
    <div className="space-y-8 animate-fade-in">
      {/* Header Card */}
      <div className="card !p-8">
        <div className="flex flex-col justify-between gap-6 md:flex-row md:items-center">
          <div className="flex flex-col gap-4">
            <button 
              onClick={() => navigate("/dashboard")}
              className="flex items-center gap-2 text-xs font-bold uppercase tracking-widest text-slate-500 hover:text-brand-400 transition-colors w-fit"
            >
              <ArrowLeft size={14} />
              {t("details.back")}
            </button>
            
            <div className="flex flex-col gap-2">
              <div className="flex items-center gap-3">
                <h2 className="text-3xl font-extrabold text-white tracking-tight">
                  {agent?.displayName || t("details.title")}
                </h2>
                {agent && (
                  <div className={`flex items-center gap-2 px-2.5 py-1 rounded-full border text-[10px] font-bold uppercase tracking-widest ${
                    agent.isOnline
                      ? "bg-emerald-500/10 border-emerald-500/20 text-emerald-400"
                      : "bg-red-500/10 border-red-500/20 text-red-400"
                  }`}>
                    <div className={`w-1.5 h-1.5 rounded-full ${agent.isOnline ? "bg-emerald-400 animate-pulse" : "bg-red-400"}`} />
                    {agent.isOnline ? "Online" : "Offline"}
                  </div>
                )}
              </div>
              
              {agent && (
                <div className="flex items-center gap-4 text-xs font-medium text-slate-500">
                  <div className="flex items-center gap-1.5">
                    <Monitor size={14} />
                    <span>{agent.hostname || "-"}</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <Globe size={14} />
                    <span>{agent.ip || "-"}</span>
                  </div>
                  {!agent.isOnline && agent.offlineSince && (
                     <div className="flex items-center gap-1.5 text-red-400/80">
                        <Clock size={14} />
                        <span>Offline since {formatDate(agent.offlineSince, lang)}</span>
                     </div>
                  )}
                </div>
              )}
            </div>
          </div>
          
          <div className="flex items-center gap-3">
            <button
              className="btn btn-primary"
              onClick={refreshInfo}
              disabled={refreshing}
            >
              <RefreshCw size={16} className={refreshing ? 'animate-spin' : ''} />
              <span>{refreshing ? t("details.refreshing") : t("details.refresh")}</span>
            </button>
          </div>
        </div>
      </div>

      {loading && <div className="flex justify-center py-12"><RefreshCw size={32} className="animate-spin text-brand-500" /></div>}
      {error && <div className="p-4 rounded-xl bg-red-500/10 border border-red-500/20 text-red-400 text-sm">{error}</div>}
      {waiting && (
         <div className="flex items-center gap-2 text-xs font-bold text-brand-400 animate-pulse">
            <Activity size={14} />
            {t("details.waiting")}
         </div>
      )}
      {infoError && <div className="p-4 rounded-xl bg-red-500/10 border border-red-500/20 text-red-400 text-sm">{infoError}</div>}

      {/* Live vital signs — the numbers that answer "is this host healthy right
          now?", refreshed on every agent check-in rather than on demand. */}
      <div className="card !p-6 sm:!p-8 space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/5 pb-4">
          <div className="flex items-center gap-3">
            <Gauge size={18} className="text-brand-400" />
            <div>
              <h3 className="text-sm font-bold uppercase tracking-[0.3em] text-slate-500">
                {t("metrics.title")}
              </h3>
              <p className="text-xs text-slate-500 mt-0.5">{t("metrics.subtitle")}</p>
            </div>
          </div>
          {agent?.metricsUpdatedAt && (
            <span className="text-[10px] font-medium uppercase tracking-widest text-slate-500">
              {t("metrics.updatedAt", { time: formatDate(agent.metricsUpdatedAt, lang) })}
            </span>
          )}
        </div>

        {!metrics ? (
          <div className="empty-state">
            <Gauge size={36} className="text-slate-700" />
            <p className="empty-state-title">{t("metrics.noData")}</p>
            <p className="empty-state-hint">{t("metrics.noDataHint")}</p>
          </div>
        ) : (
          <>
            <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
              <div className="card !bg-white/[0.02] !p-5 space-y-3">
                <MetricBar label={t("metrics.cpu")} percent={metrics.cpuPercent} icon={Cpu} />
                <div className="flex items-center justify-between text-[10px] text-slate-500">
                  <span>{t("metrics.load")}</span>
                  <span className="font-mono text-slate-400">
                    {metrics.loadAverage
                      ? `${metrics.loadAverage["1m"] ?? "—"} / ${metrics.loadAverage["5m"] ?? "—"} / ${metrics.loadAverage["15m"] ?? "—"}`
                      : "—"}
                  </span>
                </div>
                <Sparkline
                  points={metricHistory.map((point) => point.cpuPercent)}
                  label={t("metrics.cpu")}
                  width={220}
                />
              </div>

              <div className="card !bg-white/[0.02] !p-5 space-y-3">
                <MetricBar
                  label={t("metrics.memory")}
                  percent={metrics.memory?.percent}
                  icon={MemoryStick}
                  hint={
                    metrics.memory?.totalBytes
                      ? `${formatBytes(metrics.memory.usedBytes)} / ${formatBytes(metrics.memory.totalBytes)}`
                      : null
                  }
                />
                {metrics.swap && (
                  <MetricBar label={t("metrics.swap")} percent={metrics.swap.percent} compact />
                )}
                <Sparkline
                  points={metricHistory.map((point) => point.memoryPercent)}
                  label={t("metrics.memory")}
                  width={220}
                  color="#33f0b5"
                />
              </div>

              <div className="card !bg-white/[0.02] !p-5 space-y-3">
                <MetricBar
                  label={t("metrics.disk")}
                  percent={metrics.disk?.root?.percent}
                  icon={HardDrive}
                  hint={
                    metrics.disk?.root?.totalBytes
                      ? `${metrics.disk.root.mount} · ${formatBytes(metrics.disk.root.freeBytes)} ${t("details.available")}`
                      : null
                  }
                />
                {/* Only worth showing when it is not the same volume as /. */}
                {metrics.disk?.busiest && metrics.disk.busiest.mount !== metrics.disk.root?.mount && (
                  <MetricBar
                    label={metrics.disk.busiest.mount}
                    percent={metrics.disk.busiest.percent}
                    compact
                  />
                )}
                <Sparkline
                  points={metricHistory.map((point) => point.diskPercent)}
                  label={t("metrics.disk")}
                  width={220}
                  color="#f59e0b"
                />
              </div>
            </div>

            <div className="flex flex-wrap gap-x-8 gap-y-2 text-xs text-slate-500 pt-2 border-t border-white/5">
              {metrics.cpuCount != null && (
                <span className="flex items-center gap-2">
                  <Cpu size={13} /> {metrics.cpuCount} {t("details.threads")}
                </span>
              )}
              {metrics.processCount != null && (
                <span className="flex items-center gap-2">
                  <Activity size={13} /> {metrics.processCount} {t("metrics.processes")}
                </span>
              )}
              {metrics.loggedInUsers != null && (
                <span className="flex items-center gap-2">
                  <UsersIcon size={13} /> {metrics.loggedInUsers} {t("metrics.sessions")}
                </span>
              )}
            </div>
          </>
        )}
      </div>

      <div className="grid gap-8 lg:grid-cols-[1fr_380px]">
        {/* Left Column: Core System Info */}
        <div className="space-y-8">
          {/* OS & Basic Info */}
          <div className="card !p-8 space-y-8">
            <div className="flex items-center justify-between border-b border-white/5 pb-4">
              <h3 className="text-sm font-bold uppercase tracking-[0.3em] text-slate-500">
                {t("details.system")}
              </h3>
              <Info size={16} className="text-slate-600" />
            </div>
            
            {!info && !loading ? (
              <p className="text-sm text-slate-500 italic">{t("details.noInfo")}</p>
            ) : null}

            <div className="grid gap-8 md:grid-cols-2">
               {osInfo && (
                  <div className="flex items-start gap-4">
                     <div className="p-3 rounded-2xl bg-brand-500/10 text-brand-400">
                        {osInfo.name?.toLowerCase().includes('windows') ? <WindowsIcon size={24} /> : 
                         osInfo.name?.toLowerCase().includes('darwin') ? <AppleIcon size={24} /> : 
                         <LinuxIcon size={24} />}
                     </div>
                     <div className="flex flex-col gap-1">
                        <div className="text-lg font-bold text-white leading-tight">{osInfo.prettyName || "-"}</div>
                        <div className="text-xs font-medium text-slate-500">
                           {t("details.osName")}: {osInfo.name} · v{osInfo.version}
                        </div>
                     </div>
                  </div>
               )}
               
               <div className="space-y-4">
                  {packageManager && (
                    <div className="flex items-center gap-3 text-xs">
                       <span className="text-slate-500 font-bold uppercase tracking-wider">{t("details.packageManager")}:</span>
                       <span className="px-2 py-0.5 rounded-md bg-white/5 border border-white/5 text-slate-300 font-mono">{packageManager}</span>
                    </div>
                  )}
                  {uptimeSeconds !== null && (
                    <div className="flex items-center gap-3 text-xs">
                       <span className="text-slate-500 font-bold uppercase tracking-wider">{t("details.uptime")}:</span>
                       <span className="text-slate-200 font-semibold">{formatDuration(uptimeSeconds)}</span>
                    </div>
                  )}
                  {rebootRequired && (
                    <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-red-500/10 border border-red-500/20 text-xs font-bold text-red-400">
                       <Zap size={14} />
                       {t("details.rebootRequired")}
                    </div>
                  )}
               </div>
            </div>

            {infoUpdated && (
              <div className="text-[10px] font-bold uppercase tracking-widest text-slate-600 text-right pt-4 border-t border-white/5">
                {t("details.lastUpdated", { time: formatDate(infoUpdated, lang) })}
              </div>
            )}
          </div>

          <div className="grid gap-8 md:grid-cols-2">
            {/* CPU Usage */}
            <div className="card !p-8 flex flex-col gap-6">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-bold uppercase tracking-[0.3em] text-slate-500">
                  {t("details.cpu")}
                </h3>
                <Cpu size={16} className="text-brand-400" />
              </div>
              
              {cpu ? (
                <div className="space-y-6">
                  <div className="space-y-2">
                    <div className="text-sm font-bold text-white truncate" title={cpu.model}>
                      {cpu.model || "-"}
                    </div>
                    <div className="flex gap-4 text-[10px] font-bold uppercase tracking-wider text-slate-500">
                      <span>{t("details.cores")}: <span className="text-slate-300 ml-1">{cpu.cores ?? "-"}</span></span>
                      <span>{t("details.threads")}: <span className="text-slate-300 ml-1">{cpu.threads ?? "-"}</span></span>
                    </div>
                  </div>
                  
                  {cpu.usagePercent !== undefined && cpu.usagePercent !== null && (
                    <div className="flex justify-center pt-2">
                      <DonutChart
                        used={cpu.usagePercent}
                        total={100}
                        usedLabel={t("details.used")}
                        freeLabel={t("details.available")}
                        usedValue={`${cpu.usagePercent}%`}
                        freeValue={`${(100 - cpu.usagePercent).toFixed(1)}%`}
                        size={110}
                        thickness={10}
                        layout="stacked"
                      />
                    </div>
                  )}
                </div>
              ) : (
                <p className="text-sm text-slate-500 italic">{t("details.noInfo")}</p>
              )}
            </div>

            {/* Memory Usage */}
            <div className="card !p-8 flex flex-col gap-6">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-bold uppercase tracking-[0.3em] text-slate-500">
                  {t("details.memory")}
                </h3>
                <Activity size={16} className="text-emerald-400" />
              </div>
              
              {memory ? (
                <div className="space-y-6">
                  <div className="text-xs font-bold text-slate-500 uppercase tracking-wider">
                    {t("details.total")}: <span className="text-slate-200 ml-2">{formatBytes(memory.totalBytes)}</span>
                  </div>
                  <div className="flex justify-center pt-2">
                    <DonutChart
                      used={memory.usedBytes}
                      total={memory.totalBytes}
                      usedLabel={t("details.used")}
                      freeLabel={t("details.available")}
                      usedValue={formatBytes(memory.usedBytes)}
                      freeValue={formatBytes(memory.availableBytes)}
                      size={110}
                      thickness={10}
                      layout="stacked"
                    />
                  </div>
                </div>
              ) : (
                <p className="text-sm text-slate-500 italic">{t("details.noInfo")}</p>
              )}
            </div>
          </div>

          {/* Disks Usage */}
          <div className="card !p-8 space-y-6">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-bold uppercase tracking-[0.3em] text-slate-500">
                {t("details.disks")}
              </h3>
              <HardDrive size={16} className="text-slate-500" />
            </div>
            
            {disks.length ? (
              <div className="grid gap-4 md:grid-cols-2">
                {disks.map((disk) => (
                  <div
                    key={`${disk.device}-${disk.mount}`}
                    className="flex flex-col gap-4 p-5 rounded-2xl bg-white/[0.02] border border-white/5 hover:bg-white/[0.04] transition-colors"
                  >
                    <div className="flex items-center justify-between">
                       <div className="min-w-0">
                          <div className="text-sm font-bold text-white truncate">{disk.mount}</div>
                          <div className="text-[10px] font-mono text-slate-500 truncate mt-1">{disk.device}</div>
                       </div>
                       <span className="px-2 py-0.5 rounded bg-black/40 text-[9px] font-bold text-slate-400 uppercase tracking-widest">{disk.fsType}</span>
                    </div>

                    <DonutChart
                      used={disk.usedBytes}
                      total={disk.sizeBytes}
                      usedLabel={t("details.used")}
                      freeLabel={t("details.available")}
                      usedValue={formatBytes(disk.usedBytes)}
                      freeValue={formatBytes(disk.availBytes)}
                      size={64}
                      thickness={6}
                    />
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-slate-500 italic">{t("details.noDisks")}</p>
            )}
          </div>
        </div>

        {/* Right Column: Secondary Info & Controls */}
        <div className="space-y-8">
          {/* IP Addresses */}
          <div className="card !p-6 space-y-4">
            <div className="flex items-center gap-3 text-brand-400">
               <Network size={16} />
               <h3 className="text-[10px] font-bold uppercase tracking-[0.2em]">{t("details.ips")}</h3>
            </div>
            {ips.length ? (
              <div className="flex flex-wrap gap-2">
                {ips.map((ip) => (
                  <span key={ip} className="px-3 py-1.5 rounded-lg bg-black/40 border border-white/5 font-mono text-xs text-slate-300">
                    {ip}
                  </span>
                ))}
              </div>
            ) : (
              <p className="text-xs text-slate-500 italic">{t("details.noIps")}</p>
            )}
          </div>

          {/* Packages Shortcut */}
          <button
            type="button"
            onClick={() => navigate(`/agents/${id}/packages`)}
            className="card !p-6 group w-full flex flex-col gap-4 text-left hover:bg-brand-500/[0.03] hover:border-brand-500/20 transition-all active:scale-[0.98]"
          >
            <div className="flex items-center justify-between">
               <div className="flex items-center gap-3 text-slate-500 group-hover:text-brand-400 transition-colors">
                  <Package size={16} />
                  <h3 className="text-[10px] font-bold uppercase tracking-[0.2em]">{t("details.packages")}</h3>
               </div>
               <ArrowLeft size={14} className="rotate-180 text-slate-600 group-hover:text-brand-400 transition-all group-hover:translate-x-1" />
            </div>
            {packagesInstalled !== null ? (
              <div className="text-2xl font-bold text-white">
                {packagesInstalled} <span className="text-sm font-medium text-slate-500">Installed</span>
              </div>
            ) : (
              <p className="text-sm text-slate-500 italic">{t("details.noInfo")}</p>
            )}
          </button>

          {/* Antivirus health */}
          <div className="card !p-6 space-y-5">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-3 text-emerald-400">
                <ShieldCheck size={16} />
                <h3 className="text-[10px] font-bold uppercase tracking-[0.2em]">{t("antivirus.title")}</h3>
              </div>
              <button
                type="button"
                className="btn-ghost !px-3 !py-1.5 text-xs"
                onClick={checkAntivirus}
                disabled={Boolean(antivirusBusy)}
              >
                <RefreshCw size={12} className={antivirusBusy === "status" ? "animate-spin" : ""} />
                {antivirusBusy === "status" ? t("antivirus.checking") : t("antivirus.check")}
              </button>
            </div>

            {!antivirus ? (
              <p className="text-xs text-slate-500 leading-relaxed">{t("antivirus.neverChecked")}</p>
            ) : (
              <div className="space-y-4">
                <div className="flex items-center gap-3">
                  <span
                    className={`px-2.5 py-1 rounded-lg text-[10px] font-bold uppercase tracking-wider ${
                      !antivirus.installed
                        ? "bg-red-500/10 text-red-400"
                        : antivirus.healthy
                        ? "bg-emerald-500/10 text-emerald-400"
                        : "bg-amber-500/10 text-amber-400"
                    }`}
                  >
                    {!antivirus.installed
                      ? t("antivirus.notInstalled")
                      : antivirus.healthy
                      ? t("antivirus.healthy")
                      : t("antivirus.unhealthy")}
                  </span>
                  {antivirus.product && (
                    <span className="text-sm font-bold text-white">{antivirus.product}</span>
                  )}
                  {antivirus.version && (
                    <span className="text-xs text-slate-500 font-mono">{antivirus.version}</span>
                  )}
                </div>

                {Array.isArray(antivirus.issues) && antivirus.issues.length > 0 && (
                  <ul className="space-y-1.5">
                    {antivirus.issues.map((issue) => (
                      <li key={issue} className="flex items-start gap-2 text-xs text-amber-400/90">
                        <AlertTriangle size={12} className="mt-0.5 shrink-0" />
                        <span>{issue}</span>
                      </li>
                    ))}
                  </ul>
                )}

                {antivirus.installed && (
                  <div className="space-y-2 pt-1">
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-slate-500">{t("antivirus.realtime")}</span>
                      <span className={antivirus.realtimeEnabled ? "text-emerald-400" : "text-amber-400"}>
                        {antivirus.realtimeEnabled ? t("antivirus.realtimeOn") : t("antivirus.realtimeOff")}
                      </span>
                    </div>
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-slate-500">{t("antivirus.signatures")}</span>
                      <span className={antivirus.upToDate ? "text-emerald-400" : "text-amber-400"}>
                        {antivirus.upToDate ? t("antivirus.upToDate") : t("antivirus.outdated")}
                        {antivirus.signatureAgeDays !== null && antivirus.signatureAgeDays !== undefined && (
                          <span className="text-slate-500">
                            {" · "}
                            {t("antivirus.signatureAge", { n: antivirus.signatureAgeDays })}
                          </span>
                        )}
                      </span>
                    </div>
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-slate-500">{t("antivirus.lastScan")}</span>
                      <span className="text-slate-300">
                        {antivirus.lastScanAt
                          ? `${formatDate(antivirus.lastScanAt, lang)}${antivirus.lastScanType ? ` (${antivirus.lastScanType})` : ""}`
                          : t("antivirus.lastScanNever")}
                      </span>
                    </div>
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-slate-500">{t("antivirus.threats")}</span>
                      <span className={antivirus.threatsFound > 0 ? "text-red-400 font-bold" : "text-emerald-400"}>
                        {antivirus.threatsFound > 0
                          ? t("antivirus.threatsFound", { n: antivirus.threatsFound })
                          : t("antivirus.threatsNone")}
                      </span>
                    </div>
                  </div>
                )}

                {Array.isArray(antivirus.threats) && antivirus.threats.length > 0 && (
                  <div className="space-y-1.5 pt-1">
                    {antivirus.threats.slice(0, 10).map((threat, index) => (
                      <div
                        key={`${threat.name}-${index}`}
                        className="p-2.5 rounded-xl bg-red-500/[0.06] border border-red-500/10 space-y-1"
                      >
                        <div className="text-xs font-bold text-red-300 break-all">{threat.name}</div>
                        {threat.path && (
                          <div className="text-[10px] text-slate-500 font-mono break-all">{threat.path}</div>
                        )}
                        <div className="text-[10px] text-slate-500 uppercase tracking-wider">
                          {[threat.severity, threat.action].filter(Boolean).join(" · ")}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {antivirus?.installed && (
              <div className="space-y-2 pt-1">
                {antivirus.scanSupported ? (
                  <div className="flex gap-2">
                    <button
                      type="button"
                      className="btn-secondary !py-2 text-xs flex-1"
                      onClick={() => runAntivirusScan("quick")}
                      disabled={Boolean(antivirusBusy)}
                    >
                      {antivirusBusy === "quick" ? t("antivirus.scanning") : t("antivirus.quickScan")}
                    </button>
                    <button
                      type="button"
                      className="btn-secondary !py-2 text-xs flex-1"
                      onClick={() => runAntivirusScan("full")}
                      disabled={Boolean(antivirusBusy)}
                    >
                      {antivirusBusy === "full" ? t("antivirus.scanning") : t("antivirus.fullScan")}
                    </button>
                  </div>
                ) : (
                  <p className="text-[10px] text-slate-500 leading-relaxed">{t("antivirus.scanSupportedNo")}</p>
                )}
              </div>
            )}

            {antivirusMessage && <p className="text-xs text-brand-300">{antivirusMessage}</p>}
            {antivirusError && (
              <p className="text-xs text-red-400">{t("antivirus.failed", { error: antivirusError })}</p>
            )}
            {antivirusCheckedAt && (
              <p className="text-[10px] text-slate-600">
                {t("antivirus.checkedAt", { time: formatDate(antivirusCheckedAt, lang) })}
              </p>
            )}
          </div>

          {/* Monitoring Settings */}
          <div className="card !p-6 space-y-6">
             <div className="flex items-center gap-3 text-red-400">
                <Shield size={16} />
                <h3 className="text-[10px] font-bold uppercase tracking-[0.2em]">Monitoring</h3>
             </div>
             <p className="text-xs text-slate-500 leading-relaxed">
               Enable offline detection and Email/SMS alerts for this specific device.
             </p>
             <label className="flex items-center gap-4 cursor-pointer group p-3 rounded-xl hover:bg-white/5 transition-colors">
                <div className="relative">
                  <input
                    type="checkbox"
                    checked={monitorEnabled}
                    disabled={monitorSaving}
                    onChange={(e) => saveMonitor(e.target.checked)}
                    className="peer sr-only"
                  />
                  <div className="w-10 h-6 bg-slate-800 rounded-full peer-checked:bg-emerald-500/20 transition-colors" />
                  <div className="absolute left-1 top-1 w-4 h-4 bg-slate-500 rounded-full transition-all peer-checked:left-5 peer-checked:bg-emerald-400" />
                </div>
                <span className="text-sm font-bold text-slate-300 group-hover:text-white transition-colors">Down Detection</span>
             </label>
          </div>

          {/* Local Web Interface */}
          <div className="card !p-6 space-y-6">
            <div className="flex items-center justify-between">
               <div className="flex items-center gap-3 text-brand-400">
                  <Zap size={16} />
                  <h3 className="text-[10px] font-bold uppercase tracking-[0.2em]">{t("details.localWebTitle")}</h3>
               </div>
               {localWebEnabled && (agent?.ip || agent?.hostname) && (
                <a
                  href={`http://${agent.ip || agent.hostname}:${localWebPort}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="p-1.5 rounded-lg bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20 transition-colors"
                >
                  <ExternalLink size={14} />
                </a>
              )}
            </div>

            <p className="text-xs text-slate-500 leading-relaxed">
              Expose a local web interface on the agent for direct access to logs and system status.
            </p>

            <div className="space-y-4">
               <label className="flex items-center gap-4 cursor-pointer group p-3 rounded-xl hover:bg-white/5 transition-colors">
                  <div className="relative">
                    <input
                      type="checkbox"
                      checked={localWebEnabled}
                      onChange={(e) => setLocalWebEnabled(e.target.checked)}
                      className="peer sr-only"
                    />
                    <div className="w-10 h-6 bg-slate-800 rounded-full peer-checked:bg-brand-500/20 transition-colors" />
                    <div className="absolute left-1 top-1 w-4 h-4 bg-slate-500 rounded-full transition-all peer-checked:left-5 peer-checked:bg-brand-500" />
                  </div>
                  <span className="text-sm font-bold text-slate-300 group-hover:text-white transition-colors">{t("details.enableLocalWeb")}</span>
               </label>

               <div className="space-y-2">
                  <label className="text-[10px] font-bold uppercase tracking-widest text-slate-500">{t("details.localWebPort")}</label>
                  <select
                    value={localWebPort}
                    onChange={(e) => setLocalWebPort(parseInt(e.target.value, 10))}
                    disabled={!localWebEnabled}
                    className="input !py-2 disabled:opacity-30 transition-opacity"
                  >
                    {allowedPorts.map((port) => (
                      <option key={port} value={port}>{port}</option>
                    ))}
                  </select>
               </div>
               
               <div className="flex items-center justify-between gap-4 pt-2">
                  <button
                    className="btn btn-primary flex-1"
                    onClick={saveLocalWebSettings}
                    disabled={localWebSaving}
                  >
                    {localWebSaving ? t("common.saving") : t("common.save")}
                  </button>
                  {localWebMessage && (
                    <span className={`text-[10px] font-bold uppercase tracking-wider ${localWebMessage.includes("error") || localWebMessage.includes("Erreur") ? "text-red-400" : "text-emerald-400"}`}>
                      {localWebMessage}
                    </span>
                  )}
               </div>
            </div>
          </div>
          
          {/* GPU Info if exists */}
          {gpus.length > 0 && (
            <div className="card !p-6 space-y-4">
              <div className="flex items-center gap-3 text-amber-400">
                 <Zap size={16} />
                 <h3 className="text-[10px] font-bold uppercase tracking-[0.2em]">{t("details.gpu")}</h3>
              </div>
              <div className="space-y-2">
                {gpus.map((gpu) => (
                  <div key={gpu} className="text-xs font-semibold text-slate-300 p-3 rounded-xl bg-black/20 border border-white/5">
                    {gpu}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Repositories */}
          <div className="card !p-6 space-y-4">
            <div className="flex items-center gap-3 text-slate-500">
               <ClipboardList size={16} />
               <h3 className="text-[10px] font-bold uppercase tracking-[0.2em]">{t("details.repositories")}</h3>
            </div>
            {repositories.length ? (
              <div className="max-h-[300px] overflow-y-auto space-y-2 pr-2 custom-scrollbar">
                {repositories.map((repo) => (
                  <div key={repo} className="p-2.5 rounded-lg bg-black/20 border border-white/5 text-[10px] font-mono text-slate-400 break-all leading-relaxed">
                    {repo}
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-xs text-slate-500 italic">{t("details.noRepos")}</p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
