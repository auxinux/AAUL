import React, { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { 
  Package, 
  Search, 
  ArrowRight,
  Monitor,
  Globe,
  Cpu
} from "lucide-react";
import { apiFetch } from "../lib/api.js";
import { useI18n } from "../lib/i18n.js";

// Global entry point for package management: pick an agent, then jump to its
// per-agent packages page (/agents/:id/packages).
export default function PackagesHub() {
  const navigate = useNavigate();
  const { t } = useI18n();
  const [agents, setAgents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const data = await apiFetch("/api/agents");
        if (mounted) setAgents(data.agents || []);
      } catch (err) {
        if (mounted) setError(err.message || "Erreur de chargement");
      } finally {
        if (mounted) setLoading(false);
      }
    })();
    return () => { mounted = false; };
  }, []);

  const filtered = useMemo(() => {
    const f = filter.trim().toLowerCase();
    if (!f) return agents;
    return agents.filter(
      (a) =>
        (a.displayName || "").toLowerCase().includes(f) ||
        (a.hostname || "").toLowerCase().includes(f) ||
        (a.ip || "").toLowerCase().includes(f)
    );
  }, [agents, filter]);

  return (
    <div className="space-y-8 animate-fade-in">
      <div className="card !p-8">
        <div className="flex flex-col gap-4">
          <div className="flex items-center gap-3 text-brand-400">
             <Package size={24} />
             <h2 className="text-3xl font-extrabold text-white tracking-tight">
               {t("nav.packages")}
             </h2>
          </div>
          <p className="text-slate-400 font-medium max-w-2xl">
            Pick a device to list, search, and install or uninstall software packages directly from the dashboard.
          </p>
        </div>
      </div>

      <div className="card !p-8 space-y-8">
        <div className="relative group">
          <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-500 group-focus-within:text-brand-400 transition-colors" size={18} />
          <input
            className="input !pl-12"
            placeholder="Filter by name, host or IP..."
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
        </div>

        {loading && <div className="text-center py-12"><div className="w-8 h-8 border-4 border-brand-500/30 border-t-brand-500 rounded-full animate-spin mx-auto" /></div>}
        {error && <div className="p-4 rounded-xl bg-red-500/10 border border-red-500/20 text-red-400 text-sm">{error}</div>}

        {!loading && filtered.length === 0 ? (
          <div className="text-center py-12">
            <Package size={48} className="text-slate-700 mx-auto mb-4" />
            <p className="text-sm font-medium text-slate-500">No agents found matching your search.</p>
          </div>
        ) : null}

        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {filtered.map((agent) => (
            <button
              key={agent.id}
              onClick={() => navigate(`/agents/${agent.id}/packages`)}
              className="card !bg-white/[0.02] !p-6 flex flex-col gap-6 text-left hover:bg-brand-500/[0.03] hover:border-brand-500/20 transition-all group active:scale-[0.98]"
            >
              <div className="flex items-center justify-between">
                <div className="p-2 rounded-xl bg-white/5 text-slate-400 group-hover:text-brand-400 transition-colors">
                  <Monitor size={18} />
                </div>
                <div className={`w-2 h-2 rounded-full ${agent.isOnline ? "bg-emerald-400 animate-pulse" : "bg-red-400"}`} />
              </div>

              <div className="min-w-0">
                <div className="font-bold text-white tracking-tight truncate mb-1 group-hover:text-brand-400 transition-colors">
                  {agent.displayName || agent.id}
                </div>
                <div className="flex items-center gap-2 text-xs font-medium text-slate-500 truncate">
                   <span>{agent.hostname || "-"}</span>
                   <span>·</span>
                   <span className="font-mono">{agent.ip || "-"}</span>
                </div>
              </div>

              <div className="flex items-center justify-between pt-4 border-t border-white/5">
                 <div className="flex items-center gap-2 text-[10px] font-bold text-slate-500 uppercase tracking-widest">
                    <Cpu size={12} />
                    Manage Software
                 </div>
                 <ArrowRight size={14} className="text-slate-600 group-hover:text-brand-400 group-hover:translate-x-1 transition-all" />
              </div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
