/**
 * Main fleet view.
 *
 * This page is intentionally stateful because it acts as the operator's control
 * surface: it shows the fleet, subscribes to live updates, opens install and
 * schedule dialogs, and queues actions against agents.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { 
  RefreshCw, 
  Search, 
  Columns, 
  ArrowUpCircle, 
  Clock, 
  Server, 
  CheckCircle2, 
  AlertCircle, 
  Settings2,
  MoreHorizontal,
  Download,
  Trash2,
  XCircle,
  ShieldCheck,
  Zap,
  Filter,
  Globe,
  LayoutGrid,
  List,
  Activity,
  ShieldAlert,
  Cpu
} from "lucide-react";
import { apiFetch } from "../lib/api.js";
import MetricBar, { MetricTrio } from "../components/MetricBar.jsx";
import { useI18n } from "../lib/i18n.js";
import StatusBadge from "../components/StatusBadge.jsx";
import Modal from "../components/Modal.jsx";
import ConfirmDialog from "../components/ConfirmDialog.jsx";
import DonutChart from "../components/DonutChart.jsx";
import { LinuxIcon, AppleIcon, WindowsIcon } from "../components/OsIcons.jsx";

// Group management: create/rename/delete, assign machines, run group actions.
function GroupsManager({ open, onClose, groups, agents, reload }) {
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  const call = async (fn) => {
    setBusy(true); setMsg("");
    try { await fn(); await reload(); }
    catch (err) { setMsg(err.message || "Erreur"); }
    finally { setBusy(false); }
  };

  const GROUP_ACTIONS = [
    { type: "CHECK_UPDATES", label: "Rechercher MAJ" },
    { type: "RUN_NOW", label: "Mettre à jour" },
    { type: "FETCH_INFO", label: "Rafraîchir infos" },
    { type: "UPDATE_AGENT", label: "MAJ agent" }
  ];

  return (
    <Modal open={open} title="Groupes de machines" size="2xl" onClose={onClose}>
      <div className="space-y-5">
        {msg ? <p className="text-sm text-red-400">{msg}</p> : null}

        {/* Create */}
        <div className="flex gap-2">
          <input className="input flex-1" placeholder="Nom du nouveau groupe…" value={newName}
            onChange={(e) => setNewName(e.target.value)} />
          <button className="btn btn-primary" disabled={busy || !newName.trim()}
            onClick={() => call(async () => {
              await apiFetch("/api/groups", { method: "POST", body: JSON.stringify({ name: newName.trim() }) });
              setNewName("");
            })}>
            Ajouter
          </button>
        </div>

        {/* Groups list */}
        <div className="space-y-2">
          {groups.length === 0 ? <p className="text-sm text-slate-500">Aucun groupe.</p> : null}
          {groups.map((g) => (
            <div key={g.id} className="rounded-lg bg-ink-800 p-3 space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <input
                  className="input flex-1 min-w-[140px] py-1"
                  defaultValue={g.name}
                  onBlur={(e) => {
                    const v = e.target.value.trim();
                    if (v && v !== g.name) call(() => apiFetch(`/api/groups/${g.id}`, { method: "PUT", body: JSON.stringify({ name: v }) }));
                  }}
                />
                <span className="text-xs text-slate-500">{g.agentCount} machine(s)</span>
                <button className="btn btn-secondary text-xs" disabled={busy}
                  onClick={() => call(() => apiFetch(`/api/groups/${g.id}`, { method: "DELETE" }))}>
                  Supprimer
                </button>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {GROUP_ACTIONS.map((a) => (
                  <button key={a.type} className="btn btn-secondary text-xs px-2 py-1" disabled={busy || g.agentCount === 0}
                    onClick={() => call(async () => {
                      const r = await apiFetch(`/api/groups/${g.id}/action`, { method: "POST", body: JSON.stringify({ type: a.type }) });
                      setMsg(`${a.label} : ${r.queued}/${r.total} en file`);
                    })}>
                    {a.label}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>

        {/* Assignment */}
        <div>
          <h4 className="mb-2 text-sm font-semibold text-slate-200">Affecter les machines</h4>
          <div className="max-h-[260px] space-y-1 overflow-auto">
            {agents.map((a) => (
              <div key={a.id} className="flex items-center justify-between gap-3 rounded bg-ink-900/50 px-3 py-1.5">
                <span className="truncate text-sm text-slate-200">{a.displayName}</span>
                <select
                  className="input w-44 py-1 text-sm"
                  value={a.groupId || ""}
                  onChange={(e) => call(() => apiFetch(`/api/agents/${a.id}/group`, {
                    method: "PUT",
                    body: JSON.stringify({ groupId: e.target.value ? Number(e.target.value) : null })
                  }))}
                >
                  <option value="">Sans groupe</option>
                  {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
                </select>
              </div>
            ))}
          </div>
        </div>
      </div>
    </Modal>
  );
}

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

// Use background polling only when the live event stream is not connected.
const FALLBACK_REFRESH_MS = 30000;
const ONLINE_THRESHOLD_SECONDS = 180;
const COLUMN_STORAGE_KEY = "aaul.columns";
const DEFAULT_COLUMNS = [
  "name",
  "host",
  "lastSeen",
  "lastRun",
  "status",
  "state",
  "exit",
  "version",
  "schedule",
  "command",
  "actions"
];

function formatBytes(value) {
  if (value === null || value === undefined) return "-";
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  let sizeIndex = 0;
  let size = Number(value);
  while (size >= 1024 && sizeIndex < sizes.length - 1) {
    size /= 1024;
    sizeIndex += 1;
  }
  return `${size.toFixed(1)} ${sizes[sizeIndex]}`;
}

function getOsIcon(osInfo) {
  if (!osInfo?.name) return null;
  const n = osInfo.name.toLowerCase();
  if (n.includes("windows")) return <WindowsIcon className="w-4 h-4 text-blue-400" />;
  if (n.includes("darwin") || n.includes("macos") || n.includes("mac os")) return <AppleIcon className="w-4 h-4 text-slate-300" />;
  return <LinuxIcon className="w-4 h-4 text-orange-400" />;
}

function StatCard({ label, value, color, icon: Icon }) {
  const colorMap = {
    brand: "text-brand-400 bg-brand-500/5 border-brand-500/10",
    emerald: "text-emerald-400 bg-emerald-500/5 border-emerald-500/10",
    amber: "text-amber-400 bg-amber-500/5 border-amber-500/10",
    red: "text-red-400 bg-red-500/5 border-red-500/10"
  };
  
  return (
    <div className={`rounded-2xl border p-5 flex flex-col gap-3 transition-all hover:bg-white/[0.02] ${colorMap[color] || colorMap.brand}`}>
      <div className="flex items-center justify-between">
        <div className="p-2 rounded-xl bg-white/5">
          <Icon size={18} />
        </div>
        <div className="text-2xl font-bold tracking-tight text-white">{value}</div>
      </div>
      <div className="text-[10px] font-bold uppercase tracking-[0.2em] text-slate-500">{label}</div>
    </div>
  );
}

export default function Dashboard() {
  const { t, lang } = useI18n();
  const navigate = useNavigate();
  const [agents, setAgents] = useState([]);
  // Aggregated vital signs across the fleet (averages + hosts over threshold).
  const [fleetHealth, setFleetHealth] = useState(null);
  const [latestVersion, setLatestVersion] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [liveIndicator, setLiveIndicator] = useState(false);
  const [scheduleAgent, setScheduleAgent] = useState(null);
  const [scheduleEnabled, setScheduleEnabled] = useState(true);
  const [scheduleTime, setScheduleTime] = useState("03:00");
  const [installAgent, setInstallAgent] = useState(null);
  const [installInfo, setInstallInfo] = useState(null);
  const [installPlatform, setInstallPlatform] = useState("linux");
  const [installError, setInstallError] = useState("");
  const [installLoading, setInstallLoading] = useState(false);
  const [openMenuId, setOpenMenuId] = useState(null);
  const [confirmAgent, setConfirmAgent] = useState(null);
  const [columnMenuOpen, setColumnMenuOpen] = useState(false);
  const [layoutMode, setLayoutMode] = useState(() => {
    if (typeof window !== "undefined") {
      const saved = window.localStorage.getItem("aaul.layoutMode");
      if (saved === "simple" || saved === "detailed") return saved;
    }
    return "simple";
  });

  const changeLayoutMode = (mode) => {
    setLayoutMode(mode);
    if (typeof window !== "undefined") {
      window.localStorage.setItem("aaul.layoutMode", mode);
    }
  };
  const [afterAgentsWidgets, setAfterAgentsWidgets] = useState([]);
  const [hostStats, setHostStats] = useState(null);
  const [searchTerm, setSearchTerm] = useState("");
  const [fleetFilter, setFleetFilter] = useState("all");
  const [viewMode, setViewMode] = useState("all"); // all | os | group
  const [groups, setGroups] = useState([]);
  const [groupsModalOpen, setGroupsModalOpen] = useState(false);
  const [dragId, setDragId] = useState(null);

  const loadGroups = useCallback(async () => {
    try {
      const data = await apiFetch("/api/groups");
      setGroups(data.groups || []);
    } catch {
      setGroups([]);
    }
  }, []);
  useEffect(() => { loadGroups(); }, [loadGroups]);
  const [confirmDialog, setConfirmDialog] = useState(null);
  const [noticeDialog, setNoticeDialog] = useState(null);
  const sseRef = useRef(null);

  const [visibleColumns, setVisibleColumns] = useState(() => {
    if (typeof window === "undefined") {
      return DEFAULT_COLUMNS;
    }
    try {
      const saved = JSON.parse(window.localStorage.getItem(COLUMN_STORAGE_KEY));
      if (Array.isArray(saved) && saved.length > 0) {
        return saved;
      }
    } catch (err) {
      return DEFAULT_COLUMNS;
    }
    return DEFAULT_COLUMNS;
  });

  const columns = useMemo(
    () => [
      { id: "name", label: t("dashboard.table.name") },
      { id: "host", label: t("dashboard.table.hostIp") },
      { id: "lastSeen", label: t("dashboard.table.lastSeen") },
      { id: "lastRun", label: t("dashboard.table.lastRun") },
      { id: "status", label: t("dashboard.table.status") },
      { id: "state", label: t("dashboard.table.state") },
      { id: "exit", label: t("dashboard.table.exit") },
      { id: "version", label: t("dashboard.table.version") },
      { id: "schedule", label: t("dashboard.table.schedule") },
      { id: "command", label: t("dashboard.table.command") },
      { id: "actions", label: t("dashboard.table.actions") }
    ],
    [t]
  );

  const isColumnVisible = (id) => visibleColumns.includes(id);

  const toggleColumn = (id) => {
    setVisibleColumns((prev) => {
      const isVisible = prev.includes(id);
      if (isVisible && prev.length === 1) {
        return prev;
      }
      if (isVisible) {
        return prev.filter((column) => column !== id);
      }
      return [...prev, id];
    });
  };

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    window.localStorage.setItem(COLUMN_STORAGE_KEY, JSON.stringify(visibleColumns));
  }, [visibleColumns]);

  const loadAgents = useCallback(
    async (options = {}) => {
      const { silent = false } = options;
      if (!silent) {
        setLoading(true);
      }
      setError("");
      try {
        const data = await apiFetch("/api/agents");
        setAgents(data.agents || []);
        if (data.latestVersion) {
          setLatestVersion(data.latestVersion);
        }
      } catch (err) {
        setError(err.message || t("errors.loadAgents"));
      } finally {
        if (!silent) {
          setLoading(false);
        }
      }
    },
    [t]
  );

  // Initial snapshot used before SSE updates start flowing.
  useEffect(() => {
    loadAgents();
  }, [loadAgents]);

  // Fleet health is a separate aggregate query, refreshed on its own slower
  // cadence — the underlying samples only change every few minutes.
  useEffect(() => {
    let mounted = true;
    const loadHealth = async () => {
      if (typeof document !== "undefined" && document.hidden) return;
      try {
        const data = await apiFetch("/api/agents/metrics/summary");
        if (mounted) setFleetHealth(data);
      } catch {
        if (mounted) setFleetHealth(null);
      }
    };
    loadHealth();
    const interval = setInterval(loadHealth, 30000);
    return () => {
      mounted = false;
      clearInterval(interval);
    };
  }, []);

  // Keep the table in sync without full page refreshes.
  useEffect(() => {
    let retryTimeout = null;
    let es = null;

    function connect() {
      es = new EventSource("/api/events");

      es.addEventListener("connected", () => {
        setLiveIndicator(true);
      });

      es.addEventListener("agent:update", () => {
        loadAgents({ silent: true });
      });

      es.onerror = () => {
        setLiveIndicator(false);
        es.close();
        retryTimeout = setTimeout(connect, 5000);
      };

      sseRef.current = es;
    }

    connect();

    return () => {
      clearTimeout(retryTimeout);
      if (sseRef.current) {
        sseRef.current.close();
      }
    };
  }, [loadAgents]);

  // Some deployments may proxy SSE poorly; polling keeps the page usable there too.
  useEffect(() => {
    const interval = setInterval(() => {
      if (!liveIndicator) {
        loadAgents({ silent: true });
      }
    }, FALLBACK_REFRESH_MS);
    return () => clearInterval(interval);
  }, [loadAgents, liveIndicator]);

  useEffect(() => {
    let mounted = true;
    const loadStats = async () => {
      try {
        const data = await apiFetch("/api/showinfohost/stats");
        if (mounted) setHostStats(data);
      } catch {
        if (mounted) setHostStats(null);
      }
    };
    loadStats();
    const interval = setInterval(loadStats, 1000);
    return () => {
      mounted = false;
      clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    const loadWidgets = async () => {
      try {
        const afterAgents = await apiFetch("/api/plugins/ui/dashboard:after-agents");
        setAfterAgentsWidgets(afterAgents.components || []);
      } catch {
        setAfterAgentsWidgets([]);
      }
    };
    loadWidgets();
  }, []);

  const renderWidget = (widget, idx) => {
    if (widget.type === "host-info" && widget.variant === "panel") {
      return <HostInfoPanel key={`${widget.plugin}-${idx}`} stats={hostStats} />;
    }
    return null;
  };

  useEffect(() => {
    const handleClick = (event) => {
      const target = event.target;
      if (!(target instanceof Element)) {
        return;
      }
      if (!target.closest("[data-menu-root]")) {
        setOpenMenuId(null);
        setColumnMenuOpen(false);
      }
    };
    document.addEventListener("click", handleClick);
    return () => document.removeEventListener("click", handleClick);
  }, []);

  const runCommand = async (path, confirmConfig = null) => {
    const execute = async () => {
      await apiFetch(path, { method: "POST" });
      await loadAgents();
    };

    if (confirmConfig) {
      setConfirmDialog({
        ...confirmConfig,
        onConfirm: async () => {
          setConfirmDialog(null);
          await execute();
        }
      });
      return;
    }

    await execute();
  };

  const updateAllOutdated = async () => {
    const outdatedCount = agents.filter((a) => a.isOutdated).length;
    if (outdatedCount === 0) {
      setNoticeDialog({
        title: t("dashboard.updateOutdated"),
        description: t("dashboard.updateOutdatedNone")
      });
      return;
    }
    setConfirmDialog({
      title: t("dashboard.updateOutdated"),
      description: t("dashboard.confirm.updateOutdated"),
      onConfirm: async () => {
        setConfirmDialog(null);
        await apiFetch("/api/agents/update-outdated", { method: "POST" });
        await loadAgents();
      }
    });
  };

  const [checkingUpdates, setCheckingUpdates] = useState(false);
  const checkAllUpdates = async () => {
    setCheckingUpdates(true);
    try {
      await apiFetch("/api/agents/commands/check-updates-all", { method: "POST" });
      setNoticeDialog({
        title: "Recherche des mises à jour",
        description: "Recherche lancée sur tous les appareils. Les résultats apparaîtront d'ici quelques minutes (état « Mise à jour requise »)."
      });
    } catch (err) {
      setNoticeDialog({ title: "Erreur", description: err.message || "Échec du lancement" });
    } finally {
      setCheckingUpdates(false);
    }
  };

  const openSchedule = (agent) => {
    setScheduleAgent(agent);
    setScheduleEnabled(agent.schedule?.enabled ?? true);
    setScheduleTime(agent.schedule?.dailyTime || "03:00");
  };

  const submitSchedule = async () => {
    if (!scheduleAgent) {
      return;
    }
    await apiFetch(`/api/agents/${scheduleAgent.id}/commands/schedule`, {
      method: "POST",
      body: JSON.stringify({ enabled: scheduleEnabled, dailyTime: scheduleTime })
    });
    setScheduleAgent(null);
    await loadAgents();
  };

  const openInstallInfo = async (agent) => {
    setOpenMenuId(null);
    setInstallAgent(agent);
    setInstallPlatform("linux");
    setInstallInfo(null);
    setInstallError("");
    setInstallLoading(true);
    try {
      const data = await apiFetch(`/api/agents/${agent.id}/install`);
      setInstallInfo(data);
    } catch (err) {
      setInstallError(err.message || t("errors.loadInstallInfo"));
    } finally {
      setInstallLoading(false);
    }
  };

  const copyInstallCommand = async () => {
    const command = installInfo?.installCommands?.[installPlatform] || installInfo?.installCommand;
    if (!command) {
      return;
    }
    await navigator.clipboard.writeText(command);
  };

  const deleteAgent = async (agent) => {
    const confirmText = agent.lastSeenAt
      ? t("dashboard.confirm.removeDevice", { name: agent.displayName })
      : t("dashboard.confirm.remove", { name: agent.displayName });
    setOpenMenuId(null);
    setConfirmDialog({
      title: agent.lastSeenAt
        ? t("dashboard.actions.removeDevice")
        : t("dashboard.actions.remove"),
      description: confirmText,
      tone: "danger",
      confirmLabel: agent.lastSeenAt
        ? t("dashboard.actions.removeDevice")
        : t("dashboard.actions.remove"),
      onConfirm: async () => {
        setConfirmDialog(null);
        await apiFetch(`/api/agents/${agent.id}`, { method: "DELETE" });
        await loadAgents();
      }
    });
  };

  // A machine that no longer exists never picks up its UNINSTALL, which would
  // otherwise wait forever. Deleting the agent also drops its queued commands.
  const forceRemoveAgent = (agent) => {
    setOpenMenuId(null);
    setConfirmDialog({
      title: t("dashboard.actions.forceRemove"),
      description: t("dashboard.confirm.forceRemove", { name: agent.displayName }),
      tone: "danger",
      confirmLabel: t("dashboard.actions.forceRemove"),
      onConfirm: async () => {
        setConfirmDialog(null);
        await apiFetch(`/api/agents/${agent.id}`, { method: "DELETE" });
        await loadAgents();
      }
    });
  };

  const confirmUninstall = async () => {
    if (!confirmAgent) {
      return;
    }
    await runCommand(`/api/agents/${confirmAgent.id}/commands/uninstall`);
    setConfirmAgent(null);
  };

  const getState = (lastSeenAt) => {
    if (!lastSeenAt) {
      return { label: t("state.offline"), className: "bg-red-500/10 text-red-400 border-red-500/20" };
    }
    const last = new Date(lastSeenAt).getTime();
    if (Number.isNaN(last)) {
      return { label: t("state.offline"), className: "bg-red-500/10 text-red-400 border-red-500/20" };
    }
    const online = Date.now() - last <= ONLINE_THRESHOLD_SECONDS * 1000;
    return online
      ? { label: t("state.online"), className: "bg-emerald-500/10 text-emerald-400 border-emerald-500/20" }
      : { label: t("state.offline"), className: "bg-red-500/10 text-red-400 border-red-500/20" };
  };

  const isAgentOnline = (lastSeenAt) => {
    if (!lastSeenAt) {
      return false;
    }
    const last = new Date(lastSeenAt).getTime();
    return !Number.isNaN(last) && Date.now() - last <= ONLINE_THRESHOLD_SECONDS * 1000;
  };

  const handleRowDoubleClick = (event, agentId) => {
    const target = event.target;
    if (target instanceof Element && target.closest("[data-menu-root]")) {
      return;
    }
    navigate(`/agents/${agentId}`);
  };

  const formatNet = (stats) => {
    if (!stats?.net || stats.net.supported === false) {
      return "-- / -- KB/s";
    }
    const rx = stats.net.rxKbps ?? 0;
    const tx = stats.net.txKbps ?? 0;
    return `${rx} / ${tx} KB/s`;
  };

  // Header cards and filter badges both read from the same derived counters.
  const stats = useMemo(() => {
    const total = agents.length;
    const online = agents.filter((a) => isAgentOnline(a.lastSeenAt)).length;
    const outdated = agents.filter((a) => a.isOutdated).length;
    const rebootRequired = agents.filter((a) => a.rebootRequired).length;
    const updatesRequired = agents.filter((a) => a.updatesAvailable > 0).length;
    return { total, online, outdated, rebootRequired, updatesRequired };
  }, [agents]);

  const filteredAgents = useMemo(() => {
    const term = searchTerm.trim().toLowerCase();
    return agents.filter((agent) => {
      const matchesSearch =
        !term ||
        agent.displayName?.toLowerCase().includes(term) ||
        agent.hostname?.toLowerCase().includes(term) ||
        agent.ip?.toLowerCase().includes(term) ||
        agent.id?.toLowerCase().includes(term);

      if (!matchesSearch) {
        return false;
      }

      if (fleetFilter === "online") {
        return isAgentOnline(agent.lastSeenAt);
      }
      if (fleetFilter === "offline") {
        return !isAgentOnline(agent.lastSeenAt);
      }
      if (fleetFilter === "outdated") {
        return agent.isOutdated;
      }
      if (fleetFilter === "reboot") {
        return agent.rebootRequired;
      }
      return true;
    });
  }, [agents, fleetFilter, searchTerm]);

  const osFamily = (a) => {
    const n = (a.osName || a.osInfo?.name || "").toLowerCase();
    if (n.includes("mac") || n.includes("darwin")) return "macOS";
    if (n.includes("windows")) return "Windows";
    if (n) return "Linux";
    return "Inconnu";
  };

  // Flatten the agents into display rows, inserting group headers for the
  // OS / Group views. The "all" view is a flat, drag-reorderable list.
  const displayRows = useMemo(() => {
    if (viewMode === "all") {
      return filteredAgents.map((a) => ({ type: "agent", agent: a }));
    }
    const buckets = new Map();
    for (const a of filteredAgents) {
      let key, label;
      if (viewMode === "os") {
        label = osFamily(a);
        key = label;
      } else {
        const g = groups.find((gr) => gr.id === a.groupId);
        label = g ? g.name : "Sans groupe";
        key = g ? `g${g.id}` : "none";
      }
      if (!buckets.has(key)) buckets.set(key, { label, items: [] });
      buckets.get(key).items.push(a);
    }
    const rows = [];
    for (const bucket of buckets.values()) {
      rows.push({ type: "header", label: bucket.label, count: bucket.items.length });
      for (const a of bucket.items) rows.push({ type: "agent", agent: a });
    }
    return rows;
  }, [filteredAgents, viewMode, groups]);

  const groupedBuckets = useMemo(() => {
    const buckets = new Map();
    if (viewMode === "all") {
      buckets.set("all", { label: null, items: filteredAgents });
    } else {
      for (const a of filteredAgents) {
        let key, label;
        if (viewMode === "os") {
          label = osFamily(a);
          key = label;
        } else {
          const g = groups.find((gr) => gr.id === a.groupId);
          label = g ? g.name : "Sans groupe";
          key = g ? `g${g.id}` : "none";
        }
        if (!buckets.has(key)) buckets.set(key, { label, items: [] });
        buckets.get(key).items.push(a);
      }
    }
    return Array.from(buckets.values());
  }, [filteredAgents, viewMode, groups]);

  const handleDrop = async (targetId) => {
    if (!dragId || dragId === targetId) { setDragId(null); return; }
    const ids = filteredAgents.map((a) => a.id);
    const from = ids.indexOf(dragId);
    const to = ids.indexOf(targetId);
    if (from < 0 || to < 0) { setDragId(null); return; }
    ids.splice(to, 0, ids.splice(from, 1)[0]);
    const byId = Object.fromEntries(agents.map((a) => [a.id, a]));
    setAgents(ids.map((id) => byId[id]).filter(Boolean));
    setDragId(null);
    try {
      await apiFetch("/api/agents/reorder", { method: "PUT", body: JSON.stringify({ orderedIds: ids }) });
    } catch { /* best effort */ }
  };

  // Fleet-wide vital signs, so pressure on any host is visible without
  // opening every card.
  const FleetHealthPanel = () => {
    if (!fleetHealth || fleetHealth.reportingAgents === 0) {
      return null;
    }
    const groups = [
      { key: "cpu", label: t("metrics.cpu"), items: fleetHealth.pressure?.cpu || [] },
      { key: "memory", label: t("metrics.memory"), items: fleetHealth.pressure?.memory || [] },
      { key: "disk", label: t("metrics.disk"), items: fleetHealth.pressure?.disk || [] }
    ];
    const anyPressure = groups.some((group) => group.items.length > 0);

    return (
      <div className="card space-y-5">
        {/* This panel averages the MANAGED MACHINES. The dashboard server's own
            usage is shown separately (top bar + "Dashboard host" panel), so the
            heading says explicitly what is being measured — three CPU figures on
            one page are otherwise impossible to tell apart. */}
        <div className="flex flex-wrap items-start justify-between gap-3 border-b border-white/5 pb-4">
          <div className="min-w-0">
            <h3 className="text-sm font-bold uppercase tracking-[0.3em] text-slate-500">
              {t("metrics.fleetTitle")}
            </h3>
            <p className="text-xs text-slate-500 mt-1">
              {t("metrics.fleetSubtitle", { n: fleetHealth.reportingAgents })}
            </p>
          </div>
          <span className="badge badge-neutral shrink-0">
            {t("metrics.reporting", {
              n: fleetHealth.reportingAgents,
              total: fleetHealth.totalAgents
            })}
          </span>
        </div>

        <div className="grid gap-3 sm:grid-cols-3">
          <div className="rounded-xl border border-white/5 bg-white/[0.02] p-4">
            <MetricBar
              label={t("metrics.avgCpu")}
              percent={fleetHealth.averages?.cpuPercent}
              icon={Cpu}
            />
          </div>
          <div className="rounded-xl border border-white/5 bg-white/[0.02] p-4">
            <MetricBar
              label={t("metrics.avgMemory")}
              percent={fleetHealth.averages?.memoryPercent}
              icon={Activity}
            />
          </div>
          <div className="rounded-xl border border-white/5 bg-white/[0.02] p-4">
            <MetricBar
              label={t("metrics.avgDisk")}
              percent={fleetHealth.averages?.diskPercent}
              icon={Server}
            />
          </div>
        </div>

        {anyPressure ? (
          <div className="space-y-3 pt-3 border-t border-white/5">
            <p className="text-[10px] font-bold uppercase tracking-widest text-amber-400">
              {t("metrics.underPressure")}
            </p>
            <div className="flex flex-wrap gap-2">
              {groups.flatMap((group) =>
                group.items.map((item) => (
                  <button
                    key={`${group.key}-${item.id}`}
                    type="button"
                    onClick={() => navigate(`/agents/${item.id}`)}
                    className="badge badge-warn !py-1.5 !px-3 hover:bg-amber-500/25 transition-colors"
                    title={item.mount || undefined}
                  >
                    {item.name} · {group.label} {Math.round(item.value)}%
                  </button>
                ))
              )}
            </div>
          </div>
        ) : (
          <p className="text-xs text-emerald-400 pt-3 border-t border-white/5">
            {t("metrics.allHealthy")}
          </p>
        )}
      </div>
    );
  };

  const HostInfoPanel = ({ stats: hostStats }) => (
    <div className="card !p-6 space-y-6">
      <div className="flex items-center justify-between border-b border-white/5 pb-4">
        <h3 className="text-sm font-bold uppercase tracking-[0.3em] text-slate-500">
          DASHBOARD HOST
        </h3>
        <div className="flex items-center gap-2 text-xs font-semibold text-brand-400">
          <Activity size={14} />
          <span>REAL-TIME MONITORING</span>
        </div>
      </div>
      <div className="grid gap-6 md:grid-cols-3">
        <div className="card !bg-white/[0.02] !p-5 flex flex-col gap-4">
          <div className="flex items-center gap-3">
             <div className="p-2 rounded-xl bg-brand-500/10 text-brand-400">
                <Server size={18} />
             </div>
             <div>
                <div className="text-[10px] font-bold text-slate-500 uppercase tracking-widest leading-none mb-1">Operating System</div>
                <div className="text-lg font-bold text-white leading-tight">{hostStats?.osName || "--"}</div>
             </div>
          </div>
          <div className="text-xs font-medium text-slate-500">{hostStats?.osVersion || ""}</div>
        </div>
        
        <div className="card !bg-white/[0.02] !p-5 space-y-4">
          <div className="flex items-center justify-between">
            <div className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">CPU LOAD</div>
            <div className="text-xs font-bold text-slate-400">{hostStats?.cpuCores ?? "--"} Cores / {hostStats?.cpuThreads ?? "--"} Threads</div>
          </div>
          <DonutChart
            used={hostStats?.cpu ?? 0}
            total={100}
            usedLabel="Used"
            freeLabel="Available"
            usedValue={`${hostStats?.cpu ?? "--"}%`}
            freeValue={`${hostStats ? 100 - (hostStats.cpu ?? 0) : "--"}%`}
            size={80}
            thickness={8}
            layout="stacked"
          />
        </div>

        <div className="card !bg-white/[0.02] !p-5 space-y-4">
           <div className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">MEMORY USAGE</div>
          <DonutChart
            used={hostStats?.memUsedBytes ?? 0}
            total={hostStats?.memTotalBytes ?? 0}
            usedLabel="Used"
            freeLabel="Available"
            usedValue={formatBytes(hostStats?.memUsedBytes)}
            freeValue={formatBytes((hostStats?.memTotalBytes || 0) - (hostStats?.memUsedBytes || 0))}
            size={80}
            thickness={8}
            layout="stacked"
          />
        </div>
      </div>
      
      <div className="grid gap-4 md:grid-cols-2 pt-4 border-t border-white/5">
         <div className="flex items-center gap-3 text-sm">
            <span className="text-slate-500 font-medium">IP ADDRESS:</span>
            <span className="font-mono font-semibold text-slate-200">{hostStats?.ip || "--"}</span>
         </div>
         <div className="flex items-center gap-3 text-sm justify-end">
            <span className="text-slate-500 font-medium">DISK FREE:</span>
            <span className="font-bold text-emerald-400">{hostStats?.diskFreeGb ?? "--"} GB <span className="text-slate-500 font-medium">OF {hostStats?.diskTotalGb ?? "--"} GB</span></span>
         </div>
      </div>
    </div>
  );

  return (
    <div className="space-y-8 animate-fade-in">
      {/* Header Section */}
      <div className="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
        <div className="space-y-2">
          <div className="flex items-center gap-3">
             <h2 className="text-3xl font-extrabold text-white tracking-tight">{t("dashboard.title")}</h2>
             {liveIndicator ? (
               <div className="flex items-center gap-2 px-2.5 py-1 rounded-full bg-emerald-500/10 border border-emerald-500/20 text-[10px] font-bold text-emerald-400 uppercase tracking-widest">
                  <div className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                  Live
               </div>
             ) : (
               <div className="flex items-center gap-2 px-2.5 py-1 rounded-full bg-slate-500/10 border border-slate-500/20 text-[10px] font-bold text-slate-400 uppercase tracking-widest">
                  <div className="w-1.5 h-1.5 rounded-full bg-slate-400" />
                  Syncing
               </div>
             )}
          </div>
          <p className="text-slate-400 font-medium">{t("dashboard.subtitle")}</p>
        </div>

        <div className="flex flex-wrap gap-3">
            <button className="btn btn-secondary" onClick={loadAgents}>
              <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
              <span>{t("dashboard.refresh")}</span>
            </button>
            <button className="btn btn-secondary" onClick={checkAllUpdates} disabled={checkingUpdates}>
              <Zap size={16} />
              <span>{checkingUpdates ? "Scanning..." : "Scan for Updates"}</span>
            </button>
            {latestVersion && stats.outdated > 0 && (
              <button
                className="btn btn-primary"
                onClick={updateAllOutdated}
              >
                <ArrowUpCircle size={16} />
                <span>Update Fleet ({stats.outdated})</span>
              </button>
            )}
        </div>
      </div>

      <FleetHealthPanel />

      {/* Stats Cards */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard label={t("dashboard.stats.total")} value={stats.total} color="brand" icon={Server} />
        <StatCard label={t("dashboard.stats.online")} value={stats.online} color="emerald" icon={CheckCircle2} />
        <StatCard label={t("dashboard.stats.updateRequired")} value={stats.updatesRequired} color="amber" icon={ArrowUpCircle} />
        <StatCard label={t("dashboard.stats.rebootRequired")} value={stats.rebootRequired} color="red" icon={AlertCircle} />
      </div>

      {/* Toolbar Section */}
      <div className="card p-6 flex flex-col gap-6">
          <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
             <div className="flex flex-wrap items-center gap-4">
                {/* View Switcher */}
                <div className="flex p-1 rounded-xl bg-black/20 border border-white/5 w-fit">
                   {[
                     { id: "all", label: "All Devices" },
                     { id: "os", label: "By OS" },
                     { id: "group", label: "By Group" }
                   ].map((v) => (
                     <button
                       key={v.id}
                       onClick={() => setViewMode(v.id)}
                       className={`px-4 py-2 rounded-lg text-xs font-bold uppercase tracking-wider transition-all ${
                         viewMode === v.id ? "bg-brand-500 text-white shadow-glow" : "text-slate-500 hover:text-slate-300"
                       }`}
                     >
                       {v.label}
                     </button>
                   ))}
                </div>

                {/* Layout Switcher */}
                <div className="flex p-1 rounded-xl bg-black/20 border border-white/5 w-fit">
                   <button
                     onClick={() => changeLayoutMode("simple")}
                     className={`px-3 py-2 rounded-lg text-xs font-bold uppercase tracking-wider transition-all flex items-center gap-2 ${
                       layoutMode === "simple" ? "bg-brand-500 text-white shadow-glow" : "text-slate-500 hover:text-slate-300"
                     }`}
                     title={t("dashboard.layoutSimple")}
                   >
                     <LayoutGrid size={14} />
                     <span>{t("dashboard.layoutSimple")}</span>
                   </button>
                   <button
                     onClick={() => changeLayoutMode("detailed")}
                     className={`px-3 py-2 rounded-lg text-xs font-bold uppercase tracking-wider transition-all flex items-center gap-2 ${
                       layoutMode === "detailed" ? "bg-brand-500 text-white shadow-glow" : "text-slate-500 hover:text-slate-300"
                     }`}
                     title={t("dashboard.layoutDetailed")}
                   >
                     <List size={14} />
                     <span>{t("dashboard.layoutDetailed")}</span>
                   </button>
                </div>
             </div>

             <div className="flex items-center gap-3">
                <button className="btn btn-secondary text-xs" onClick={() => setGroupsModalOpen(true)}>
                  <Settings2 size={14} />
                  Manage Groups
                </button>
                <div className="relative" data-menu-root>
                  <button
                    className={`btn btn-secondary text-xs ${columnMenuOpen ? 'bg-white/10' : ''}`}
                    onClick={() => {
                      setOpenMenuId(null);
                      setColumnMenuOpen(!columnMenuOpen);
                    }}
                  >
                    <Columns size={14} />
                    {t("dashboard.columns")}
                  </button>
                  {columnMenuOpen && (
                    <div className="absolute right-0 top-full z-50 mt-2 w-64 glass rounded-2xl p-4 shadow-soft animate-fade-in border border-white/10">
                      <div className="text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-4">Toggle Columns</div>
                      <div className="grid grid-cols-1 gap-1.5">
                        {columns.map((column) => (
                          <label
                            key={column.id}
                            className="flex items-center gap-3 p-2 rounded-lg hover:bg-white/5 cursor-pointer group"
                          >
                            <input
                              type="checkbox"
                              className="rounded border-white/10 bg-black/40 text-brand-500 focus:ring-brand-500/20"
                              checked={isColumnVisible(column.id)}
                              onChange={() => toggleColumn(column.id)}
                            />
                            <span className="text-sm font-medium text-slate-300 group-hover:text-white transition-colors">{column.label}</span>
                          </label>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
             </div>
          </div>

          <div className="flex flex-col lg:flex-row lg:items-center gap-4">
             <div className="relative flex-1 group">
                <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-500 group-focus-within:text-brand-400 transition-colors" size={18} />
                <input
                  className="input !pl-12"
                  placeholder={t("dashboard.searchPlaceholder")}
                  value={searchTerm}
                  onChange={(event) => setSearchTerm(event.target.value)}
                />
             </div>
             
             <div className="flex flex-wrap gap-2">
                {[
                  { id: "all", label: t("dashboard.filters.all") },
                  { id: "online", label: t("dashboard.filters.online") },
                  { id: "offline", label: t("dashboard.filters.offline") },
                  { id: "outdated", label: t("dashboard.filters.outdated") },
                  { id: "reboot", label: t("dashboard.filters.reboot") }
                ].map((filter) => (
                  <button
                    key={filter.id}
                    className={`px-4 py-2 rounded-xl text-xs font-bold uppercase tracking-wider border transition-all ${
                      fleetFilter === filter.id
                        ? "bg-brand-500/10 border-brand-500/30 text-brand-400 shadow-glow"
                        : "bg-white/5 border-white/5 text-slate-500 hover:border-white/10 hover:text-slate-300"
                    }`}
                    onClick={() => setFleetFilter(filter.id)}
                  >
                    {filter.label}
                  </button>
                ))}
             </div>
          </div>
         {layoutMode === "simple" ? (
        <div className="space-y-8 mt-6">
          {groupedBuckets.map((bucket) => {
            if (bucket.items.length === 0) return null;
            return (
              <div key={bucket.label || "all"} className="space-y-4">
                {bucket.label && (
                  <div className="flex items-center gap-2 pb-2 border-b border-white/5">
                    <div className="w-1.5 h-1.5 rounded-full bg-brand-500 animate-pulse" />
                    <h3 className="text-xs font-bold uppercase tracking-[0.2em] text-brand-400">
                      {bucket.label} <span className="text-slate-500 ml-1">({bucket.items.length})</span>
                    </h3>
                  </div>
                )}
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
                  {bucket.items.map((agent) => {
                    const state = getState(agent.lastSeenAt);
                    const isOnline = isAgentOnline(agent.lastSeenAt);
                    const isMenuOpen = openMenuId === agent.id;
                    return (
                      <div
                        key={agent.id}
                        onClick={() => navigate(`/agents/${agent.id}`)}
                        className={`card group/card cursor-pointer transition-all duration-300 hover:scale-[1.02] hover:-translate-y-0.5 border ${
                          isOnline 
                            ? "hover:border-emerald-500/20 hover:shadow-[0_8px_30px_rgb(16,185,129,0.03)]" 
                            : "hover:border-red-500/20 hover:shadow-[0_8px_30px_rgb(239,68,68,0.03)]"
                        } !p-5 flex flex-col justify-between min-h-[220px]`}
                      >
                        <div className="space-y-4">
                          {/* Card Header */}
                          <div className="flex items-start justify-between gap-2">
                            <div className="flex items-center gap-2.5 min-w-0">
                              <div className="p-2 rounded-xl bg-white/5 shrink-0 group-hover/card:bg-white/10 transition-colors">
                                {getOsIcon(agent.osInfo)}
                              </div>
                              <div className="min-w-0">
                                <h4 className="font-bold text-white tracking-tight truncate leading-tight group-hover/card:text-brand-400 transition-colors">
                                  {agent.displayName}
                                </h4>
                                <span className="text-[10px] font-mono text-slate-500 truncate block mt-0.5">
                                  v{agent.agentVersion || "-"}
                                </span>
                              </div>
                            </div>
                            
                            {/* Action Menu */}
                            <div className="relative shrink-0" data-menu-root>
                              <button
                                type="button"
                                className="p-1.5 rounded-lg border border-white/5 bg-white/[0.02] text-slate-400 hover:text-white hover:bg-white/10 transition-all active:scale-95"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setColumnMenuOpen(false);
                                  setOpenMenuId(openMenuId === agent.id ? null : agent.id);
                                }}
                              >
                                <MoreHorizontal size={16} />
                              </button>
                              {isMenuOpen && (
                                <div className="absolute right-0 top-full z-50 mt-1 w-56 glass rounded-2xl p-2 shadow-soft border border-white/10 text-left">
                                  {agent.lastSeenAt ? (
                                    <>
                                      <button
                                        type="button"
                                        className="flex items-center gap-3 w-full rounded-xl px-3 py-2 text-sm font-medium text-slate-200 hover:bg-white/5 hover:text-white transition-colors"
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          setOpenMenuId(null);
                                          runCommand(
                                            `/api/agents/${agent.id}/commands/run-now`,
                                            {
                                              title: t("dashboard.actions.runNow"),
                                              description: t("dashboard.confirm.runNow")
                                            }
                                          );
                                        }}
                                      >
                                        <Zap size={14} className="text-brand-400" />
                                        {t("dashboard.actions.runNow")}
                                      </button>
                                      <button
                                        type="button"
                                        className="flex items-center gap-3 w-full rounded-xl px-3 py-2 text-sm font-medium text-slate-200 hover:bg-white/5 hover:text-white transition-colors"
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          setOpenMenuId(null);
                                          openSchedule(agent);
                                        }}
                                      >
                                        <Clock size={14} className="text-brand-400" />
                                        {t("dashboard.actions.schedule")}
                                      </button>
                                      <button
                                        type="button"
                                        className={`flex items-center gap-3 w-full rounded-xl px-3 py-2 text-sm font-medium transition-colors hover:bg-white/5 ${agent.isOutdated ? "text-amber-400" : "text-slate-200 hover:text-white"}`}
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          setOpenMenuId(null);
                                          runCommand(
                                            `/api/agents/${agent.id}/commands/update-agent`,
                                            {
                                              title: t("dashboard.actions.updateAgent"),
                                              description: t("dashboard.confirm.updateAgent")
                                            }
                                          );
                                        }}
                                      >
                                        <ArrowUpCircle size={14} />
                                        {t("dashboard.actions.updateAgent")}
                                      </button>
                                      <div className="h-px bg-white/5 my-1" />
                                      <button
                                        type="button"
                                        className="flex items-center gap-3 w-full rounded-xl px-3 py-2 text-sm font-medium text-red-400 hover:bg-red-500/10 transition-colors"
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          setOpenMenuId(null);
                                          setConfirmAgent(agent);
                                        }}
                                      >
                                        <Trash2 size={14} />
                                        {t("dashboard.actions.uninstall")}
                                      </button>
                                      {agent.uninstallPending && (
                                        <button
                                          type="button"
                                          className="flex items-center gap-3 w-full rounded-xl px-3 py-2 text-sm font-medium text-red-400 hover:bg-red-500/10 transition-colors"
                                          onClick={(e) => {
                                            e.stopPropagation();
                                            forceRemoveAgent(agent);
                                          }}
                                        >
                                          <XCircle size={14} />
                                          {t("dashboard.actions.forceRemove")}
                                        </button>
                                      )}
                                    </>
                                  ) : (
                                    <>
                                      <button
                                        type="button"
                                        className="flex items-center gap-3 w-full rounded-xl px-3 py-2 text-sm font-medium text-slate-200 hover:bg-white/5 hover:text-white transition-colors"
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          openInstallInfo(agent);
                                        }}
                                      >
                                        <Download size={14} className="text-brand-400" />
                                        {t("dashboard.actions.installInfo")}
                                      </button>
                                      <button
                                        type="button"
                                        className="flex items-center gap-3 w-full rounded-xl px-3 py-2 text-sm font-medium text-red-400 hover:bg-red-500/10 transition-colors"
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          deleteAgent(agent);
                                        }}
                                      >
                                        <Trash2 size={14} />
                                        {t("dashboard.actions.remove")}
                                      </button>
                                    </>
                                  )}
                                </div>
                              )}
                            </div>
                          </div>

                          {/* Card Body */}
                          <div className="space-y-2.5 text-xs">
                            <div className="flex justify-between items-center gap-2">
                              <span className="text-slate-500 font-medium">IP / Hôte</span>
                              <span className="text-slate-200 font-mono text-[11px] truncate max-w-[140px]" title={agent.hostname}>
                                {agent.ip || "-"} · {agent.hostname || "-"}
                              </span>
                            </div>
                            <div className="flex justify-between items-center gap-2">
                              <span className="text-slate-500 font-medium">{t("dashboard.table.status")}</span>
                              <div className="flex items-center gap-1.5">
                                <span className={`badge ${state.className} !px-2 !py-0.5 text-[9px] font-bold`}>
                                  {state.label}
                                </span>
                                {isOnline && (
                                  <div className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                                )}
                              </div>
                            </div>
                            <div className="flex justify-between items-center gap-2">
                              <span className="text-slate-500 font-medium">{t("dashboard.table.lastSeen")}</span>
                              <span className="text-slate-300 font-semibold text-[11px]">
                                {formatDate(agent.lastSeenAt, lang)}
                              </span>
                            </div>
                          </div>
                        </div>

                        {/* Live vital signs, reported on every heartbeat. Kept
                            compact so a card still reads at a glance. */}
                        <div className="mt-3 pt-3 border-t border-white/5">
                          <MetricTrio
                            metrics={agent.metrics}
                            compact
                            labels={{
                              cpu: t("metrics.cpu"),
                              memory: t("metrics.memory"),
                              disk: t("metrics.disk")
                            }}
                            noDataLabel={t("metrics.noData")}
                          />
                        </div>

                        {/* Card Footer */}
                        <div className="mt-3 pt-3 border-t border-white/5 flex flex-wrap items-center justify-between gap-2">
                          <div className="flex flex-wrap gap-1">
                            {agent.securityUpdatesAvailable > 0 && (
                              <span className="badge badge-security text-[9px] font-extrabold" title={t("packagesAll.tileSecurity")}>
                                <ShieldAlert size={10} />
                                {agent.securityUpdatesAvailable}
                              </span>
                            )}
                            {agent.updatesAvailable > 0 && (
                              <span className="badge badge-warn text-[9px] font-extrabold">
                                {agent.updatesAvailable} {t("dashboard.updatesShort")}
                              </span>
                            )}
                            {agent.rebootRequired && (
                              <span className="badge bg-red-500/10 text-red-400 border border-red-500/20 text-[9px] font-extrabold">
                                {t("dashboard.badgeReboot")}
                              </span>
                            )}
                            {agent.isOutdated && (
                              <span className="badge bg-amber-500/10 text-amber-400 border border-amber-500/20 text-[9px] font-extrabold">
                                {t("dashboard.badgeOutdated")}
                              </span>
                            )}
                          </div>
                          
                          {agent.lastSeenAt && (
                            <button
                              type="button"
                              className="btn btn-secondary !py-1 !px-2.5 text-xs flex items-center gap-1 shrink-0 hover:bg-brand-500/10 hover:text-brand-400 hover:border-brand-500/20 transition-all"
                              onClick={(e) => {
                                e.stopPropagation();
                                runCommand(
                                  `/api/agents/${agent.id}/commands/run-now`,
                                  {
                                    title: t("dashboard.actions.runNow"),
                                    description: t("dashboard.confirm.runNow")
                                  }
                                );
                              }}
                            >
                              <Zap size={11} className="text-brand-400" />
                              <span>{t("dashboard.actions.runNow")}</span>
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
          {!loading && filteredAgents.length === 0 && (
            <div className="flex flex-col items-center gap-3 py-12 text-center card">
               <Search size={40} className="text-slate-700" />
               <p className="text-sm font-medium text-slate-500">{t("dashboard.noAgentsMatch")}</p>
            </div>
          )}
        </div>
      ) : (
        <div className="card !p-0 overflow-hidden flex flex-col mt-6">
          <div className="detailed-table-scroll overflow-x-auto">
            <table className="detailed-agent-table w-full min-w-[1120px] text-xs">
              <thead className="bg-ink-900/95 backdrop-blur-xl">
                <tr className="bg-white/[0.01]">
                  {columns
                    .filter((column) => isColumnVisible(column.id))
                    .map((column) => (
                      <th key={column.id} className="table-header">
                        {column.label}
                      </th>
                    ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-white/[0.03]">
                {displayRows.map((row) => {
                  if (row.type === "header") {
                    const span = columns.filter((c) => isColumnVisible(c.id)).length || 1;
                    return (
                      <tr key={`h-${row.label}`} className="bg-brand-500/[0.03]">
                        <td colSpan={span} className="px-6 py-3">
                          <div className="flex items-center gap-2">
                             <div className="w-1.5 h-1.5 rounded-full bg-brand-500" />
                             <span className="text-xs font-bold uppercase tracking-[0.2em] text-brand-400">
                               {row.label} <span className="text-slate-500 ml-1">({row.count})</span>
                             </span>
                          </div>
                        </td>
                      </tr>
                    );
                  }
                  const agent = row.agent;
                  const state = getState(agent.lastSeenAt);
                  const draggable = viewMode === "all";
                  const isOnline = isAgentOnline(agent.lastSeenAt);

                  return (
                    <tr
                      key={agent.id}
                      draggable={draggable}
                      onDragStart={draggable ? () => setDragId(agent.id) : undefined}
                      onDragOver={draggable ? (event) => event.preventDefault() : undefined}
                      onDrop={draggable ? () => handleDrop(agent.id) : undefined}
                      className={`table-row group/row cursor-pointer transition hover:bg-white/[0.03] ${dragId === agent.id ? "opacity-40" : ""}`}
                      onDoubleClick={(event) => handleRowDoubleClick(event, agent.id)}
                    >
                      {isColumnVisible("name") && (
                        <td className="px-4 py-5 align-top">
                          <div className="flex items-start gap-3">
                             <div className="mt-1">
                               {getOsIcon(agent.osInfo)}
                             </div>
                             <div className="flex flex-col gap-1.5 min-w-0">
                                <div className="font-bold text-white tracking-tight truncate leading-tight group-hover/row:text-brand-400 transition-colors">
                                  {agent.displayName}
                                </div>
                                <div className="flex items-center gap-2">
                                  {agent.isInternet ? (
                                    <span className="flex items-center gap-1 text-[9px] font-bold uppercase tracking-wider text-brand-400/80">
                                      <Globe size={10} /> Internet
                                    </span>
                                  ) : (
                                    <span className="flex items-center gap-1 text-[9px] font-bold uppercase tracking-wider text-slate-500">
                                      <ShieldCheck size={10} /> Local
                                    </span>
                                  )}
                                  {agent.rebootRequired && (
                                    <span className="w-1.5 h-1.5 rounded-full bg-red-400 animate-pulse" title="Reboot required" />
                                  )}
                                </div>
                             </div>
                          </div>
                        </td>
                      )}
                      
                      {isColumnVisible("host") && (
                        <td className="px-4 py-5 align-top">
                          <div className="flex flex-col gap-1">
                             <div className="text-slate-200 font-semibold truncate leading-tight">{agent.hostname || "-"}</div>
                             <div className="text-[11px] font-mono text-slate-500">{agent.ip || "-"}</div>
                          </div>
                        </td>
                      )}

                      {isColumnVisible("lastSeen") && (
                        <td className="px-4 py-5 align-top text-xs font-medium text-slate-400 whitespace-nowrap">
                          {formatDate(agent.lastSeenAt, lang)}
                        </td>
                      )}

                      {isColumnVisible("lastRun") && (
                        <td className="px-4 py-5 align-top text-xs font-medium text-slate-400 whitespace-nowrap">
                          {formatDate(agent.lastRunAt, lang)}
                        </td>
                      )}

                      {isColumnVisible("status") && (
                        <td className="px-4 py-5 align-top">
                          <div className="flex flex-col gap-2">
                            <StatusBadge label={agent.lastStatus} />
                            {agent.rebootRequired && (
                              <span className="badge bg-red-500/10 text-red-400 border border-red-500/20">
                                Reboot Req.
                              </span>
                            )}
                          </div>
                        </td>
                      )}

                      {isColumnVisible("state") && (
                        <td className="px-4 py-5 align-top">
                          <div className="flex flex-col gap-2">
                            <span className={`badge border whitespace-nowrap ${state.className}`}>
                              {state.label}
                            </span>
                            {agent.updatesAvailable > 0 && (
                              <button
                                onClick={(e) => { e.stopPropagation(); navigate(`/agents/${agent.id}/packages?tab=updates`); }}
                                className="badge bg-amber-500/10 text-amber-400 border border-amber-500/20 hover:bg-amber-500/20 transition-colors"
                              >
                                <ArrowUpCircle size={10} />
                                {agent.updatesAvailable} UPDATES
                              </button>
                            )}
                          </div>
                        </td>
                      )}

                      {isColumnVisible("exit") && (
                        <td className="px-4 py-5 align-top font-mono text-xs text-slate-400">
                          {agent.lastExitCode ?? "-"}
                        </td>
                      )}

                      {isColumnVisible("version") && (
                        <td className="px-4 py-5 align-top">
                          <div className="flex flex-col gap-1">
                            <span className="font-mono text-xs font-bold text-slate-200">
                              {agent.agentVersion || "-"}
                            </span>
                            {agent.isOutdated && (
                              <span className="text-[9px] font-bold text-amber-500 uppercase tracking-widest">
                                Outdated
                              </span>
                            )}
                          </div>
                        </td>
                      )}

                      {isColumnVisible("schedule") && (
                        <td className="px-4 py-5 align-top">
                          <div className="flex flex-col gap-1">
                             <div className="text-[10px] font-bold uppercase tracking-widest text-slate-500">
                                {agent.schedule?.enabled ? "Auto" : "Manual"}
                             </div>
                             <div className="text-xs font-semibold text-slate-300 flex items-center gap-1.5">
                                <Clock size={12} className="text-slate-500" />
                                {agent.schedule?.dailyTime || "--:--"}
                             </div>
                          </div>
                        </td>
                      )}

                      {isColumnVisible("command") && (
                        <td className="px-4 py-5 align-top">
                          {agent.pendingCommand ? (
                            <div className="flex flex-col gap-1.5">
                              <StatusBadge label={agent.pendingCommand.status} />
                              <div className="text-[10px] font-bold uppercase tracking-widest text-slate-500">
                                {agent.pendingCommand.type}
                              </div>
                              {agent.pendingCount > 1 && (
                                <div className="text-[10px] text-slate-500">
                                  {t("dashboard.queuedMore", { n: agent.pendingCount - 1 })}
                                </div>
                              )}
                            </div>
                          ) : (
                            <span className="text-[10px] font-bold uppercase tracking-widest text-slate-600">
                              Idle
                            </span>
                          )}
                        </td>
                      )}

                      {isColumnVisible("actions") && (
                        <td className="px-4 py-5 align-top">
                          <div className="relative inline-flex" data-menu-root>
                            <button
                              className="p-2 rounded-xl border border-white/5 bg-white/[0.02] text-slate-400 hover:text-white hover:bg-white/10 transition-all active:scale-90"
                              onClick={(e) => {
                                e.stopPropagation();
                                setColumnMenuOpen(false);
                                setOpenMenuId(openMenuId === agent.id ? null : agent.id);
                              }}
                            >
                              <MoreHorizontal size={18} />
                            </button>
                            {openMenuId === agent.id && (
                              <div className="absolute right-0 top-full z-50 mt-2 w-56 glass rounded-2xl p-2 shadow-soft border border-white/10">
                                {agent.lastSeenAt ? (
                                  <>
                                    <button
                                      className="flex items-center gap-3 w-full rounded-xl px-3 py-2.5 text-left text-sm font-medium text-slate-200 hover:bg-white/5 hover:text-white transition-colors"
                                      onClick={() =>
                                        (() => {
                                          setOpenMenuId(null);
                                          return runCommand(
                                            `/api/agents/${agent.id}/commands/run-now`,
                                            {
                                              title: t("dashboard.actions.runNow"),
                                              description: t("dashboard.confirm.runNow")
                                            }
                                          );
                                        })()
                                      }
                                    >
                                      <Zap size={16} className="text-brand-400" />
                                      {t("dashboard.actions.runNow")}
                                    </button>
                                    <button
                                      className="flex items-center gap-3 w-full rounded-xl px-3 py-2.5 text-left text-sm font-medium text-slate-200 hover:bg-white/5 hover:text-white transition-colors"
                                      onClick={() => {
                                        setOpenMenuId(null);
                                        openSchedule(agent);
                                      }}
                                    >
                                      <Clock size={16} className="text-brand-400" />
                                      {t("dashboard.actions.schedule")}
                                    </button>
                                    <button
                                      className={`flex items-center gap-3 w-full rounded-xl px-3 py-2.5 text-left text-sm font-medium transition-colors hover:bg-white/5 ${agent.isOutdated ? "text-amber-400" : "text-slate-200 hover:text-white"}`}
                                      onClick={() =>
                                        (() => {
                                          setOpenMenuId(null);
                                          return runCommand(
                                            `/api/agents/${agent.id}/commands/update-agent`,
                                            {
                                              title: t("dashboard.actions.updateAgent"),
                                              description: t("dashboard.confirm.updateAgent")
                                            }
                                          );
                                        })()
                                      }
                                    >
                                      <ArrowUpCircle size={16} />
                                      {t("dashboard.actions.updateAgent")}
                                    </button>
                                    <div className="h-px bg-white/5 my-1" />
                                    <button
                                      className="flex items-center gap-3 w-full rounded-xl px-3 py-2.5 text-left text-sm font-medium text-red-400 hover:bg-red-500/10 transition-colors"
                                      onClick={() => {
                                        setOpenMenuId(null);
                                        setConfirmAgent(agent);
                                      }}
                                    >
                                      <Trash2 size={16} />
                                      {t("dashboard.actions.uninstall")}
                                    </button>
                                    {agent.uninstallPending && (
                                      <button
                                        className="flex items-center gap-3 w-full rounded-xl px-3 py-2.5 text-left text-sm font-medium text-red-400 hover:bg-red-500/10 transition-colors"
                                        onClick={() => forceRemoveAgent(agent)}
                                      >
                                        <XCircle size={16} />
                                        {t("dashboard.actions.forceRemove")}
                                      </button>
                                    )}
                                  </>
                                ) : (
                                  <>
                                    <button
                                      className="flex items-center gap-3 w-full rounded-xl px-3 py-2.5 text-left text-sm font-medium text-slate-200 hover:bg-white/5 hover:text-white transition-colors"
                                      onClick={() => openInstallInfo(agent)}
                                    >
                                      <Download size={16} className="text-brand-400" />
                                      {t("dashboard.actions.installInfo")}
                                    </button>
                                    <button
                                      className="flex items-center gap-3 w-full rounded-xl px-3 py-2.5 text-left text-sm font-medium text-red-400 hover:bg-red-500/10 transition-colors"
                                      onClick={() => deleteAgent(agent)}
                                    >
                                      <Trash2 size={16} />
                                      {t("dashboard.actions.remove")}
                                    </button>
                                  </>
                                )}
                              </div>
                            )}
                          </div>
                        </td>
                      )}
                    </tr>
                  );
                })}
                {!loading && filteredAgents.length === 0 && (
                  <tr>
                    <td
                      colSpan={visibleColumns.length}
                      className="px-6 py-12 text-center"
                    >
                      <div className="flex flex-col items-center gap-3">
                         <Search size={40} className="text-slate-700" />
                         <p className="text-sm font-medium text-slate-500">{t("dashboard.noAgentsMatch")}</p>
                      </div>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
      </div>

      {afterAgentsWidgets.length > 0 && (
        <div className="space-y-6 animate-fade-in">
          {afterAgentsWidgets.map((widget, idx) => renderWidget(widget, idx))}
        </div>
      )}

      {/* Modals and Dialogs below remain functional, styling updated via global classes */}
      <Modal
        open={Boolean(scheduleAgent)}
        title={t("dashboard.scheduleModal.title", {
          name: scheduleAgent?.displayName || ""
        })}
        onClose={() => setScheduleAgent(null)}
      >
        <div className="space-y-6 p-2">
          <label className="flex items-center gap-4 cursor-pointer p-3 rounded-xl hover:bg-white/5 transition-colors group">
            <input
              type="checkbox"
              className="w-5 h-5 rounded border-white/10 bg-black/40 text-brand-500 focus:ring-brand-500/20"
              checked={scheduleEnabled}
              onChange={(event) => setScheduleEnabled(event.target.checked)}
            />
            <span className="text-sm font-medium text-slate-300 group-hover:text-white">{t("dashboard.scheduleModal.enableDaily")}</span>
          </label>
          <div className="space-y-3">
            <label className="text-[10px] font-bold uppercase tracking-[0.3em] text-slate-500">
              {t("dashboard.scheduleModal.dailyTime")}
            </label>
            <input
              className="input"
              type="time"
              value={scheduleTime}
              onChange={(event) => setScheduleTime(event.target.value)}
            />
          </div>
          <div className="flex justify-end gap-3 pt-4">
            <button
              className="btn btn-secondary"
              onClick={() => setScheduleAgent(null)}
            >
              {t("dashboard.scheduleModal.cancel")}
            </button>
            <button className="btn btn-primary" onClick={submitSchedule}>
              {t("dashboard.scheduleModal.save")}
            </button>
          </div>
        </div>
      </Modal>

      <Modal
        open={Boolean(installAgent)}
        title={t("dashboard.installModal.title", {
          name: installAgent?.displayName || ""
        })}
        onClose={() => setInstallAgent(null)}
      >
        <div className="space-y-6 p-2">
          {installLoading && (
            <div className="flex flex-col items-center gap-3 py-8 text-slate-500">
               <RefreshCw size={24} className="animate-spin" />
               <p className="text-sm font-medium">{t("dashboard.installModal.loading")}</p>
            </div>
          )}
          {installError && <div className="p-4 rounded-xl bg-red-500/10 border border-red-500/20 text-sm text-red-400">{installError}</div>}
          {installInfo && (
            <>
              <div className="flex p-1 rounded-xl bg-black/20 border border-white/5">
                {[
                  { id: "linux", label: "Linux" },
                  { id: "macos", label: "macOS" },
                  { id: "windows", label: "Windows" }
                ].map((platform) => (
                  <button
                    key={platform.id}
                    type="button"
                    className={`flex-1 rounded-lg px-4 py-2.5 text-xs font-bold uppercase tracking-wider transition-all ${
                      installPlatform === platform.id
                        ? "bg-brand-500 text-white shadow-glow"
                        : "text-slate-500 hover:text-slate-300"
                    }`}
                    onClick={() => setInstallPlatform(platform.id)}
                  >
                    {platform.label}
                  </button>
                ))}
              </div>
              <div className="space-y-2">
                <p className="text-[10px] font-bold uppercase tracking-[0.3em] text-slate-500">
                  {t("dashboard.installModal.agentId")}
                </p>
                <div className="p-4 rounded-xl bg-black/20 border border-white/5 font-mono text-xs text-brand-300 break-all leading-relaxed">
                  {installInfo.agentId}
                </div>
              </div>
              <div className="space-y-3">
                <p className="text-[10px] font-bold uppercase tracking-[0.3em] text-slate-500">
                  {t("dashboard.installModal.installCommand")}
                </p>
                <div className="relative group">
                   <div className="p-4 rounded-xl bg-black/20 border border-white/5 font-mono text-xs text-slate-200 break-all leading-relaxed min-h-[80px]">
                      {installInfo.installCommands?.[installPlatform] || installInfo.installCommand}
                   </div>
                   <button 
                     className="absolute right-3 bottom-3 btn btn-secondary !py-1.5 !px-3 !text-[10px] opacity-0 group-hover:opacity-100 transition-opacity"
                     onClick={copyInstallCommand}
                   >
                     {t("dashboard.installModal.copyCommand")}
                   </button>
                </div>
                {installInfo.installUrls?.[installPlatform] && (
                  <p className="text-[10px] text-slate-500 italic">
                    {t("dashboard.installModal.scriptUrl")}: {installInfo.installUrls[installPlatform]}
                  </p>
                )}
              </div>
            </>
          )}
        </div>
      </Modal>

      <Modal
        open={Boolean(confirmAgent)}
        title={t("dashboard.uninstallModal.title", {
          name: confirmAgent?.displayName || ""
        })}
        onClose={() => setConfirmAgent(null)}
      >
        <div className="space-y-6 p-2 text-center">
          <div className="w-16 h-16 rounded-3xl bg-red-500/10 border border-red-500/20 text-red-500 flex items-center justify-center mx-auto mb-2">
             <Trash2 size={32} />
          </div>
          <p className="text-sm font-medium text-slate-300 leading-relaxed">
            {t("dashboard.uninstallModal.description")}
          </p>
          <div className="flex gap-3 pt-4">
            <button className="btn btn-secondary flex-1" onClick={() => setConfirmAgent(null)}>
              {t("dashboard.uninstallModal.cancel")}
            </button>
            <button className="btn btn-danger flex-1 !bg-red-500/10 !text-red-400 hover:!bg-red-500/20" onClick={confirmUninstall}>
              {t("dashboard.uninstallModal.confirm")}
            </button>
          </div>
        </div>
      </Modal>

      <ConfirmDialog
        open={Boolean(confirmDialog)}
        title={confirmDialog?.title || ""}
        description={confirmDialog?.description || ""}
        confirmLabel={confirmDialog?.confirmLabel}
        tone={confirmDialog?.tone || "primary"}
        onClose={() => setConfirmDialog(null)}
        onConfirm={() => confirmDialog?.onConfirm?.()}
      />

      <ConfirmDialog
        open={Boolean(noticeDialog)}
        title={noticeDialog?.title || ""}
        description={noticeDialog?.description || ""}
        confirmLabel={t("common.ok")}
        hideCancel
        onClose={() => setNoticeDialog(null)}
        onConfirm={() => setNoticeDialog(null)}
      />

      <GroupsManager
        open={groupsModalOpen}
        onClose={() => setGroupsModalOpen(false)}
        groups={groups}
        agents={agents}
        reload={async () => { await loadGroups(); await loadAgents(); }}
      />
    </div>
  );
}
