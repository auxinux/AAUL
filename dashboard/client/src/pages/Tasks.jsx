import React, { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { 
  Clock, 
  RefreshCw, 
  Trash2, 
  Play, 
  CheckCircle2, 
  AlertCircle, 
  ChevronDown, 
  ChevronRight,
  Monitor,
  Activity,
  History,
  Info,
  XCircle,
  RotateCcw
} from "lucide-react";
import { apiFetch } from "../lib/api.js";
import { useI18n } from "../lib/i18n.js";
import StatusBadge from "../components/StatusBadge.jsx";

function formatDate(value, locale) {
  if (!value) return "-";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : d.toLocaleString(locale);
}

function duration(command) {
  const start = Date.parse(command.startedAt || command.createdAt);
  const end = Date.parse(command.completedAt || command.updatedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return "-";
  const seconds = Math.round((end - start) / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

export default function Tasks() {
  const navigate = useNavigate();
  const { t, lang } = useI18n();
  const [commands, setCommands] = useState([]);
  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [cancellingId, setCancellingId] = useState("");
  const [retryingId, setRetryingId] = useState("");
  const [purging, setPurging] = useState(false);
  const [statusFilter, setStatusFilter] = useState("");
  const [typeFilter, setTypeFilter] = useState("");
  const [agentFilter, setAgentFilter] = useState("");
  const [expandedId, setExpandedId] = useState("");

  const cancelAll = async () => {
    if (!window.confirm(`Cancel all ${commands.length} pending/running tasks?`)) return;
    setPurging(true);
    try {
      await apiFetch("/api/agents/commands/cancel-all", { method: "POST" });
      load();
    } catch (err) {
      setError(err.message || "Purge failed");
    } finally {
      setPurging(false);
    }
  };

  const load = async () => {
    try {
      const params = new URLSearchParams({ limit: "150" });
      if (statusFilter) params.set("status", statusFilter);
      if (typeFilter.trim()) params.set("type", typeFilter.trim());
      if (agentFilter.trim()) params.set("agentId", agentFilter.trim());
      const [activeData, historyData] = await Promise.all([
        apiFetch("/api/agents/commands/pending"),
        apiFetch(`/api/agents/commands/history?${params.toString()}`)
      ]);
      setCommands(activeData.commands || []);
      setHistory(historyData.commands || []);
      setError("");
    } catch (err) {
      setError(err.message || "Load failed");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    let events;
    try {
      events = new EventSource("/api/events");
      const refresh = () => load();
      events.addEventListener("command:update", refresh);
      events.addEventListener("agent:update", refresh);
    } catch {}
    const interval = setInterval(load, 10000);
    return () => {
      clearInterval(interval);
      if (events) events.close();
    };
  }, [statusFilter, typeFilter, agentFilter]);

  const cancelCommand = async (command) => {
    setCancellingId(command.id);
    try {
      await apiFetch(`/api/agents/${command.agentId}/commands/${command.id}/cancel`, { method: "POST" });
      load();
    } catch (err) {
      setError(err.message || "Cancel failed");
    } finally {
      setCancellingId("");
    }
  };

  const retryCommand = async (command) => {
    setRetryingId(command.id);
    try {
      await apiFetch(`/api/agents/commands/${command.id}/retry`, { method: "POST" });
      await load();
    } catch (err) {
      setError(err.message || "Retry failed");
    } finally {
      setRetryingId("");
    }
  };

  const commandDetails = (command) => {
    const parts = [];
    if (command.errorMessage) parts.push(`ERROR: ${command.errorMessage}`);
    if (command.payload) parts.push(`PAYLOAD: ${JSON.stringify(command.payload, null, 2)}`);
    if (command.result) parts.push(`RESULT: ${JSON.stringify(command.result, null, 2)}`);
    return parts.join("\n\n");
  };

  return (
    <div className="space-y-8 animate-fade-in">
      <div className="card !p-8">
        <div className="flex flex-col gap-4">
          <div className="flex items-center gap-3 text-brand-400">
             <Clock size={24} />
             <h2 className="text-3xl font-extrabold text-white tracking-tight">{t("nav.tasks")}</h2>
          </div>
          <p className="text-slate-400 font-medium max-w-2xl">Queue, recent history, and task control management.</p>
        </div>
      </div>

      {/* Active Tasks */}
      <div className="card !p-0 overflow-hidden">
        <div className="p-6 flex items-center justify-between border-b border-white/5">
          <div className="flex items-center gap-3">
             <div className="w-2 h-2 rounded-full bg-brand-500 animate-pulse" />
             <span className="text-sm font-bold uppercase tracking-widest text-slate-200">{commands.length} Active Tasks</span>
          </div>
          <div className="flex gap-3">
            {commands.length > 0 && (
              <button className="btn btn-danger text-xs !py-1.5" onClick={cancelAll} disabled={purging}>
                <XCircle size={14} />
                <span>{purging ? "Cancelling..." : "Cancel All"}</span>
              </button>
            )}
            <button className="btn btn-secondary text-xs !py-1.5" onClick={load}>
              <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
              <span>Refresh</span>
            </button>
          </div>
        </div>

        {error && <div className="m-6 p-4 rounded-xl bg-red-500/10 border border-red-500/20 text-red-400 text-sm">{error}</div>}

        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="bg-white/[0.01]">
                <th className="table-header">Device</th>
                <th className="table-header">Command Type</th>
                <th className="table-header">Status</th>
                <th className="table-header">Created</th>
                <th className="table-header text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/[0.03]">
              {commands.map((command) => (
                <tr key={command.id} className="hover:bg-white/[0.01] transition-colors">
                  <td className="px-4 py-4">
                    <button className="flex items-center gap-2 font-bold text-brand-400 hover:text-brand-300 transition-colors" onClick={() => navigate(`/agents/${command.agentId}`)}>
                      <Monitor size={14} />
                      {command.agentName}
                    </button>
                  </td>
                  <td className="px-4 py-4 font-mono text-[11px] font-bold text-slate-300 uppercase tracking-wider">{command.type}</td>
                  <td className="px-4 py-4"><StatusBadge label={command.status} /></td>
                  <td className="px-4 py-4 text-xs font-medium text-slate-500">{formatDate(command.createdAt, lang)}</td>
                  <td className="px-4 py-4 text-right">
                    <button className="p-2 rounded-lg bg-red-500/10 text-red-400 border border-red-500/20 hover:bg-red-500/20 transition-all disabled:opacity-30" disabled={cancellingId === command.id} onClick={() => cancelCommand(command)}>
                      {cancellingId === command.id ? <RefreshCw size={14} className="animate-spin" /> : <Trash2 size={14} />}
                    </button>
                  </td>
                </tr>
              ))}
              {!loading && commands.length === 0 && (
                <tr><td colSpan="5" className="px-4 py-12 text-center text-sm font-medium text-slate-500 italic">No pending tasks. Everything is up to date.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* History */}
      <div className="card !p-0 overflow-hidden">
        <div className="p-8 border-b border-white/5 space-y-6">
           <div className="flex items-center gap-3 text-slate-400 font-bold uppercase tracking-[0.2em] text-xs">
              <History size={16} />
              <span>Task History</span>
           </div>
           
           <div className="grid gap-4 md:grid-cols-4">
              <div className="space-y-2">
                 <label className="text-[10px] font-bold uppercase tracking-widest text-slate-500 ml-1">Status Filter</label>
                 <select className="input !py-2" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
                    <option value="">All Statuses</option>
                    <option value="QUEUED">Queued</option>
                    <option value="IN_PROGRESS">In Progress</option>
                    <option value="DONE">Done</option>
                    <option value="ERROR">Error</option>
                 </select>
              </div>
              <div className="space-y-2">
                 <label className="text-[10px] font-bold uppercase tracking-widest text-slate-500 ml-1">Command Type</label>
                 <input className="input !py-2" value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)} placeholder="e.g. RUN_NOW" />
              </div>
              <div className="space-y-2">
                 <label className="text-[10px] font-bold uppercase tracking-widest text-slate-500 ml-1">Device Search</label>
                 <input className="input !py-2" value={agentFilter} onChange={(e) => setAgentFilter(e.target.value)} placeholder="Agent ID or Name" />
              </div>
              <div className="flex items-end">
                 <button className="btn btn-secondary w-full" onClick={load}><RefreshCw size={14} /> Apply Filters</button>
              </div>
           </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="bg-white/[0.01]">
                <th className="table-header">Device</th>
                <th className="table-header">Type</th>
                <th className="table-header">Status</th>
                <th className="table-header">Duration</th>
                <th className="table-header">Created</th>
                <th className="table-header text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/[0.03]">
              {history.map((command) => {
                const details = commandDetails(command);
                const isExpanded = expandedId === command.id;
                return (
                  <React.Fragment key={command.id}>
                    <tr className={`hover:bg-white/[0.01] transition-colors ${isExpanded ? 'bg-white/[0.02]' : ''}`}>
                      <td className="px-4 py-4">
                        <button className="flex items-center gap-2 font-bold text-slate-300 hover:text-brand-400 transition-colors" onClick={() => navigate(`/agents/${command.agentId}`)}>
                          <Monitor size={14} />
                          {command.agentName}
                        </button>
                      </td>
                      <td className="px-4 py-4 font-mono text-[11px] font-bold text-slate-400 uppercase tracking-wider">{command.type}</td>
                      <td className="px-4 py-4"><StatusBadge label={command.status} /></td>
                      <td className="px-4 py-4 text-xs font-semibold text-slate-500">{duration(command)}</td>
                      <td className="px-4 py-4 text-xs font-medium text-slate-500">{formatDate(command.createdAt, lang)}</td>
                      <td className="px-4 py-4 text-right">
                        <div className="flex justify-end gap-2">
                          {details && (
                            <button className={`p-2 rounded-lg transition-all border ${isExpanded ? 'bg-brand-500/20 text-brand-400 border-brand-500/20' : 'bg-white/5 text-slate-500 border-white/5 hover:text-white hover:bg-white/10'}`} onClick={() => setExpandedId(isExpanded ? "" : command.id)}>
                               <Info size={14} />
                            </button>
                          )}
                          {["DONE", "ERROR"].includes(command.status) && (
                            <button className="p-2 rounded-lg bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 hover:bg-emerald-500/20 transition-all disabled:opacity-30" disabled={retryingId === command.id} onClick={() => retryCommand(command)}>
                               {retryingId === command.id ? <RefreshCw size={14} className="animate-spin" /> : <RotateCcw size={14} />}
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                    {isExpanded && details && (
                      <tr className="bg-black/40">
                        <td colSpan="6" className="px-6 py-6 animate-fade-in">
                          <div className="p-4 rounded-2xl bg-black/20 border border-white/5 font-mono text-[10px] text-slate-400 leading-relaxed overflow-x-auto custom-scrollbar">
                             <pre className="whitespace-pre-wrap">{details}</pre>
                          </div>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
              {history.length === 0 && (
                <tr><td colSpan="6" className="px-4 py-12 text-center text-sm font-medium text-slate-500 italic">No task history matches your filters.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
