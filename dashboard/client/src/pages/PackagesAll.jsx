import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Package,
  RefreshCw,
  Info,
  CheckSquare,
  Square,
  Download,
  Search,
  ShieldAlert,
  Server,
  Layers,
  ArrowUpDown,
  X
} from "lucide-react";
import { apiFetch } from "../lib/api.js";
import { useI18n } from "../lib/i18n.js";
import Modal from "../components/Modal.jsx";
import ConfirmDialog from "../components/ConfirmDialog.jsx";

/**
 * Fleet-wide ("Tout") package view.
 *
 * The question this page answers is "what do I have to patch, and how much of
 * my fleet does it touch?" — so the two things it puts first are the security
 * flag and the number of impacted hosts, and it can be reduced to security-only
 * with a single toggle.
 */
export default function PackagesAll() {
  const navigate = useNavigate();
  const { t } = useI18n();

  const [tab, setTab] = useState("updates"); // updates | installed
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [data, setData] = useState(null); // { installed, updates, stats }
  const [scanning, setScanning] = useState(false);

  const [selected, setSelected] = useState({}); // pkg name -> true
  const [busyUpdate, setBusyUpdate] = useState(false);
  const [message, setMessage] = useState("");

  const [machinesModal, setMachinesModal] = useState(null); // { title, agents }
  const [confirm, setConfirm] = useState(null);
  const [filter, setFilter] = useState("");
  const [securityOnly, setSecurityOnly] = useState(false);
  const [sortBy, setSortBy] = useState("impact"); // impact | name

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    setError("");
    try {
      const res = await apiFetch("/api/agents/packages/all");
      setData(res);
    } catch (err) {
      setError(err.message || t("errors.loadFailed"));
    } finally {
      if (!silent) setLoading(false);
    }
  }, [t]);

  useEffect(() => { load(); }, [load]);

  const scanFleet = async () => {
    setScanning(true);
    setMessage("");
    try {
      // Phase 1: list installed packages on every agent (one command per agent).
      const res = await apiFetch("/api/agents/packages/scan-all", { method: "POST" });
      setMessage(t("packagesAll.scanPhaseList", { n: res.queued }));
      // Wait for PACKAGES_LIST to drain before queueing CHECK_UPDATES —
      // agents process one command at a time.
      await waitForCommands("PACKAGES_LIST");

      // Phase 2: check available updates on every agent.
      await apiFetch("/api/agents/commands/check-updates-all", { method: "POST" });
      setMessage(t("packagesAll.scanPhaseUpdates"));
      await waitForCommands("CHECK_UPDATES");

      await load(true);
      setMessage(t("packagesAll.scanDone"));
    } catch (err) {
      setError(err.message || t("packagesAll.scanFailed"));
    } finally {
      setScanning(false);
    }
  };

  // Poll the pending-commands list until no command of the given type remains
  // (bounded, so offline agents cannot hang the scan forever).
  const waitForCommands = async (type) => {
    for (let i = 0; i < 120; i += 1) {
      const pending = await apiFetch("/api/agents/commands/pending");
      const stillPending = (pending.commands || []).some((c) => c.type === type);
      if (!stillPending) return;
      await new Promise((r) => setTimeout(r, 2000));
    }
  };

  const applyUpdate = async (names) => {
    setConfirm(null);
    if (!names.length) { setMessage(t("packagesAll.noSelection")); return; }
    setBusyUpdate(true);
    setMessage("");
    try {
      const res = await apiFetch("/api/agents/packages/bulk-update", {
        method: "POST",
        body: JSON.stringify({ names })
      });
      setMessage(t("packagesAll.updateQueued", { n: res.queued }));
      setSelected({});
      setTimeout(() => load(true), 2500);
    } catch (err) {
      setMessage(err.message || t("errors.loadFailed"));
    } finally {
      setBusyUpdate(false);
    }
  };

  const stats = data?.stats || {};

  const filteredUpdates = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    let list = data?.updates || [];
    if (securityOnly) list = list.filter((u) => u.security);
    if (needle) list = list.filter((u) => u.name.toLowerCase().includes(needle));
    if (sortBy === "name") {
      list = [...list].sort((a, b) => a.name.localeCompare(b.name));
    }
    // Otherwise keep the server order: security first, then blast radius.
    return list;
  }, [data, filter, securityOnly, sortBy]);

  const filteredInstalled = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    let list = data?.installed || [];
    if (needle) list = list.filter((p) => p.name.toLowerCase().includes(needle));
    if (sortBy === "impact") {
      list = [...list].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
    }
    return list;
  }, [data, filter, sortBy]);

  const toggle = (name) => setSelected((s) => ({ ...s, [name]: !s[name] }));
  const selectAll = (list) =>
    setSelected(list.reduce((acc, item) => ({ ...acc, [item.name]: true }), {}));
  const clearSel = () => setSelected({});

  const selectedNames = useMemo(
    () => Object.keys(selected).filter((k) => selected[k]),
    [selected]
  );

  const securityNames = useMemo(
    () => (data?.updates || []).filter((u) => u.security).map((u) => u.name),
    [data]
  );

  const renderMachines = (agents) => (
    <ul className="divide-y divide-white/5 rounded-xl border border-white/10 max-h-[320px] overflow-auto">
      {(agents || []).map((a) => (
        <li key={`${a.id}-${a.name}`}>
          <button
            className="w-full text-left px-3 py-3 flex items-center justify-between gap-3 hover:bg-white/[0.04] transition-colors"
            onClick={() => navigate(`/agents/${a.id}`)}
          >
            <span className="flex items-center gap-2 min-w-0">
              {a.security ? (
                <ShieldAlert size={14} className="text-red-400 shrink-0" />
              ) : (
                <Server size={14} className="text-slate-500 shrink-0" />
              )}
              <span className="text-sm font-medium text-slate-200 truncate">{a.name}</span>
            </span>
            <span className="text-[11px] font-mono text-slate-500 shrink-0">
              {a.newVersion || a.hostname || a.ip || ""}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );

  const InfoBadge = ({ onClick, title }) => (
    <button
      type="button"
      onClick={(e) => { e.preventDefault(); e.stopPropagation(); onClick(); }}
      title={title || t("packagesAll.details")}
      aria-label={title || t("packagesAll.details")}
      className="shrink-0 w-6 h-6 rounded-full bg-sky-500/15 border border-sky-400/30 text-sky-400 flex items-center justify-center hover:bg-sky-500/30 transition-colors"
    >
      <Info size={12} strokeWidth={3} />
    </button>
  );

  const SummaryTile = ({ icon: Icon, label, value, tone = "brand", hint }) => {
    const tones = {
      brand: "text-brand-400 bg-brand-500/10 border-brand-500/20",
      red: "text-red-400 bg-red-500/10 border-red-500/20",
      amber: "text-amber-400 bg-amber-500/10 border-amber-500/20",
      slate: "text-slate-400 bg-white/5 border-white/10"
    };
    return (
      <div className="card !p-4 sm:!p-5 flex items-center gap-4">
        <div className={`p-2.5 rounded-xl border shrink-0 ${tones[tone]}`}>
          <Icon size={18} />
        </div>
        <div className="min-w-0">
          <div className="text-xl sm:text-2xl font-extrabold text-white tabular-nums leading-tight">
            {value}
          </div>
          <div className="text-[10px] font-bold uppercase tracking-widest text-slate-500 truncate">
            {label}
          </div>
          {hint ? <div className="text-[10px] text-slate-500 truncate">{hint}</div> : null}
        </div>
      </div>
    );
  };

  return (
    <div className="space-y-5 sm:space-y-6 animate-fade-in">
      {/* Header */}
      <div className="card">
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-3 text-brand-400">
            <Package size={22} className="shrink-0" />
            <h2 className="page-title">{t("packagesAll.title")}</h2>
          </div>
          <p className="page-subtitle max-w-2xl">{t("packagesAll.subtitle")}</p>
        </div>
      </div>

      {/* At-a-glance summary — the fleet's patch posture in four numbers. */}
      <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        <SummaryTile
          icon={ShieldAlert}
          tone="red"
          value={stats.securityUpdates ?? 0}
          label={t("packagesAll.tileSecurity")}
          hint={t("packagesAll.tileSecurityHint", { n: stats.agentsWithSecurityUpdates ?? 0 })}
        />
        <SummaryTile
          icon={Download}
          tone="amber"
          value={stats.totalUpdates ?? 0}
          label={t("packagesAll.tileUpdates")}
          hint={t("packagesAll.tileUpdatesHint", { n: stats.agentsWithUpdates ?? 0 })}
        />
        <SummaryTile
          icon={Server}
          tone="brand"
          value={`${stats.scannedForUpdates ?? 0}/${stats.totalAgents ?? 0}`}
          label={t("packagesAll.tileScanned")}
        />
        <SummaryTile
          icon={Layers}
          tone="slate"
          value={stats.totalInstalled ?? 0}
          label={t("packagesAll.tileInstalled")}
        />
      </div>

      <div className="card space-y-4">
        {/* Toolbar */}
        <div className="flex flex-col sm:flex-row sm:items-center gap-3">
          <button className="btn btn-primary w-full sm:w-auto" onClick={scanFleet} disabled={scanning}>
            <RefreshCw size={16} className={scanning ? "animate-spin" : ""} />
            {scanning ? t("packagesAll.scanning") : t("packagesAll.scanFleet")}
          </button>

          <div className="segmented sm:ml-auto">
            {[
              { id: "updates", label: t("packagesAll.tabUpdates") },
              { id: "installed", label: t("packagesAll.tabInstalled") }
            ].map((tabItem) => (
              <button
                key={tabItem.id}
                onClick={() => setTab(tabItem.id)}
                className={`segmented-item flex-1 sm:flex-none ${
                  tab === tabItem.id ? "segmented-item-active" : "segmented-item-inactive"
                }`}
              >
                {tabItem.label}
              </button>
            ))}
          </div>
        </div>

        <p className="text-xs text-slate-500">{t("packagesAll.scanHint")}</p>
        {message && <p className="text-sm text-emerald-300">{message}</p>}
        {error && (
          <p className="text-sm text-red-400 rounded-xl bg-red-500/10 border border-red-500/20 p-3">
            {error}
          </p>
        )}

        {loading && (
          <div className="text-center py-10">
            <div className="w-8 h-8 border-4 border-brand-500/30 border-t-brand-500 rounded-full animate-spin mx-auto" />
          </div>
        )}

        {!loading && data && (
          <div className="space-y-4">
            {/* Search + filters */}
            <div className="flex flex-col gap-3">
              <div className="relative group">
                <Search
                  className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-500 group-focus-within:text-brand-400 transition-colors"
                  size={16}
                />
                <input
                  className="input !pl-10 !pr-10"
                  placeholder={t("packagesAll.searchPlaceholder")}
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                />
                {filter && (
                  <button
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300"
                    onClick={() => setFilter("")}
                    aria-label={t("common.clear")}
                  >
                    <X size={16} />
                  </button>
                )}
              </div>

              <div className="flex flex-wrap items-center gap-2">
                {tab === "updates" && (
                  <button
                    type="button"
                    onClick={() => setSecurityOnly((v) => !v)}
                    aria-pressed={securityOnly}
                    className={`badge !py-1.5 !px-3 transition-colors ${
                      securityOnly ? "badge-security" : "badge-neutral hover:text-slate-200"
                    }`}
                  >
                    <ShieldAlert size={13} />
                    {t("packagesAll.securityOnly")}
                    <span className="tabular-nums">({stats.securityUpdates ?? 0})</span>
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setSortBy((s) => (s === "impact" ? "name" : "impact"))}
                  className="badge badge-neutral !py-1.5 !px-3 hover:text-slate-200 transition-colors"
                  title={t("packagesAll.sortHint")}
                >
                  <ArrowUpDown size={13} />
                  {sortBy === "impact" ? t("packagesAll.sortImpact") : t("packagesAll.sortName")}
                </button>
              </div>

              {tab === "updates" && (
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    className="btn btn-secondary text-xs"
                    onClick={() => selectAll(filteredUpdates)}
                    disabled={!filteredUpdates.length}
                  >
                    <CheckSquare size={14} /> {t("packagesAll.selectAll")}
                  </button>
                  <button
                    className="btn btn-secondary text-xs"
                    onClick={clearSel}
                    disabled={!selectedNames.length}
                  >
                    <Square size={14} /> {t("packagesAll.clearSelection")}
                  </button>
                  <button
                    className="btn btn-primary text-xs"
                    disabled={busyUpdate || !selectedNames.length}
                    onClick={() => setConfirm({ kind: "selected", names: selectedNames })}
                  >
                    <Download size={14} /> {t("packagesAll.updateSelected")} ({selectedNames.length})
                  </button>
                  {securityNames.length > 0 && (
                    <button
                      className="btn text-xs bg-red-500/15 text-red-300 border border-red-500/30 hover:bg-red-500/25"
                      disabled={busyUpdate}
                      onClick={() => setConfirm({ kind: "security", names: securityNames })}
                    >
                      <ShieldAlert size={14} /> {t("packagesAll.patchSecurity")} ({securityNames.length})
                    </button>
                  )}
                  <button
                    className="btn btn-secondary text-xs"
                    disabled={busyUpdate || !data.updates.length}
                    onClick={() => setConfirm({ kind: "all", names: data.updates.map((u) => u.name) })}
                  >
                    <RefreshCw size={14} /> {t("packagesAll.updateAll")}
                  </button>
                </div>
              )}
            </div>

            {/* Updates list */}
            {tab === "updates" && (
              <div className="divide-y divide-white/5 overflow-hidden rounded-xl border border-white/10">
                {filteredUpdates.length === 0 ? (
                  <div className="empty-state">
                    <Package size={40} className="text-slate-700" />
                    <p className="empty-state-title">
                      {data.updates?.length === 0
                        ? t("packagesAll.noUpdates")
                        : t("packagesAll.noMatch")}
                    </p>
                    <p className="empty-state-hint">
                      {data.updates?.length === 0
                        ? t("packagesAll.noUpdatesHint")
                        : t("packagesAll.noMatchHint")}
                    </p>
                  </div>
                ) : (
                  <div className="max-h-[600px] overflow-auto divide-y divide-white/5">
                    {filteredUpdates.map((upd) => (
                      <label
                        key={upd.name}
                        className={`flex cursor-pointer items-start gap-3 px-3 sm:px-4 py-3 transition-colors ${
                          upd.security ? "bg-red-500/[0.04] hover:bg-red-500/[0.08]" : "hover:bg-white/[0.02]"
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={Boolean(selected[upd.name])}
                          onChange={() => toggle(upd.name)}
                          className="mt-1 h-4 w-4 rounded shrink-0"
                          aria-label={upd.name}
                        />

                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="truncate text-sm font-medium text-slate-100">
                              {upd.name}
                            </span>
                            {upd.security && (
                              <span className="badge badge-security">
                                <ShieldAlert size={11} />
                                {t("packagesAll.security")}
                              </span>
                            )}
                          </div>
                          {upd.detail ? (
                            <div className="truncate text-[11px] font-mono text-slate-500 mt-0.5">
                              {upd.detail}
                            </div>
                          ) : null}
                          {upd.sources?.length ? (
                            <div className="truncate text-[10px] text-slate-600 mt-0.5">
                              {upd.sources.join(", ")}
                            </div>
                          ) : null}
                        </div>

                        {/* Blast radius: the number the operator is really after. */}
                        <div className="flex items-center gap-2 shrink-0">
                          <div className="text-right">
                            <div
                              className={`text-sm font-bold tabular-nums ${
                                upd.security ? "text-red-300" : "text-amber-400"
                              }`}
                            >
                              {upd.count}
                            </div>
                            <div className="text-[9px] uppercase tracking-widest text-slate-500">
                              {t("packagesAll.hosts")}
                            </div>
                          </div>
                          <InfoBadge
                            title={t("packagesAll.affectedMachines")}
                            onClick={() =>
                              setMachinesModal({
                                title: `${t("packagesAll.affectedMachines")}: ${upd.name}`,
                                agents: upd.agents
                              })
                            }
                          />
                        </div>
                      </label>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Installed list */}
            {tab === "installed" && (
              <div className="overflow-hidden rounded-xl border border-white/10">
                {filteredInstalled.length === 0 ? (
                  <div className="empty-state">
                    <Layers size={40} className="text-slate-700" />
                    <p className="empty-state-title">{t("packagesAll.noDataInstalled")}</p>
                    <p className="empty-state-hint">{t("packagesAll.noDataInstalledHint")}</p>
                  </div>
                ) : (
                  <div className="max-h-[600px] overflow-auto divide-y divide-white/5">
                    {filteredInstalled.map((pkg) => (
                      <div key={pkg.name} className="flex items-center gap-3 px-3 sm:px-4 py-3">
                        <InfoBadge
                          title={t("packagesAll.installedOn")}
                          onClick={() =>
                            setMachinesModal({
                              title: `${t("packagesAll.installedOn")}: ${pkg.name}`,
                              agents: pkg.agents
                            })
                          }
                        />
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm text-slate-200">{pkg.name}</div>
                          <div className="truncate text-[11px] font-mono text-slate-500">
                            {pkg.versions.length
                              ? `${t("packagesAll.versions")}: ${pkg.versions.join(", ")}`
                              : "—"}
                          </div>
                        </div>
                        <div className="text-right shrink-0">
                          <div className="text-sm font-bold text-slate-300 tabular-nums">
                            {pkg.count}
                          </div>
                          <div className="text-[9px] uppercase tracking-widest text-slate-500">
                            {t("packagesAll.hosts")}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      <Modal
        open={Boolean(machinesModal)}
        title={machinesModal?.title || ""}
        size="md"
        onClose={() => setMachinesModal(null)}
      >
        <div className="space-y-4 p-2">
          {machinesModal && renderMachines(machinesModal.agents)}
          <div className="flex justify-end">
            <button className="btn btn-secondary" onClick={() => setMachinesModal(null)}>
              {t("packagesAll.close")}
            </button>
          </div>
        </div>
      </Modal>

      <ConfirmDialog
        open={Boolean(confirm)}
        title={
          confirm?.kind === "security"
            ? t("packagesAll.patchSecurity")
            : t("packagesAll.updateAll")
        }
        description={
          confirm?.kind === "security"
            ? t("packagesAll.patchSecurityDesc", { n: confirm?.names?.length || 0 })
            : confirm?.kind === "all"
              ? t("packagesAll.updateAllDescAll")
              : t("packagesAll.updateAllDesc")
        }
        confirmLabel={t("packagesAll.updateAll")}
        loading={busyUpdate}
        onClose={() => setConfirm(null)}
        onConfirm={() => applyUpdate(confirm.names)}
      />
    </div>
  );
}
