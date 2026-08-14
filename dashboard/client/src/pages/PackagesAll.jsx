import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Package, RefreshCw, Info, CheckSquare, Square, Download, Search } from "lucide-react";
import { apiFetch } from "../lib/api.js";
import { useI18n } from "../lib/i18n.js";
import Modal from "../components/Modal.jsx";
import ConfirmDialog from "../components/ConfirmDialog.jsx";

/**
 * Fleet-wide ("Tout") package view.
 *
 * Aggregates installed packages and available updates across every agent from
 * the persisted scan results (server /packages/all). A "Scan fleet" action
 * refreshes the data by queueing PACKAGES_LIST + CHECK_UPDATES on every agent.
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

  const [machinesModal, setMachinesModal] = useState(null); // { title, agents, kind }
  const [confirm, setConfirm] = useState(null); // { all: boolean }
  const [filter, setFilter] = useState("");

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    setError("");
    try {
      const res = await apiFetch("/api/agents/packages/all");
      setData(res);
    } catch (err) {
      setError(err.message || "Erreur de chargement");
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const scanFleet = async () => {
    setScanning(true);
    setMessage("");
    try {
      // Phase 1: list installed packages on every agent (one command per agent).
      const res = await apiFetch("/api/agents/packages/scan-all", { method: "POST" });
      setMessage(`${res.queued} machine(s) — liste des paquets en cours…`);
      // Wait for PACKAGES_LIST commands to drain before queueing CHECK_UPDATES
      // (agents process one command at a time).
      await waitForCommands("PACKAGES_LIST");

      // Phase 2: check available updates on every agent.
      await apiFetch("/api/agents/commands/check-updates-all", { method: "POST" });
      setMessage("Recherche des mises à jour en cours…");
      await waitForCommands("CHECK_UPDATES");

      await load(true);
      setMessage("");
    } catch (err) {
      setError(err.message || "Échec du scan");
    } finally {
      setScanning(false);
    }
  };

  // Poll the pending-commands list until no command of the given type remains
  // (bounded to avoid infinite loops when agents are offline).
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
      setMessage(err.message || "Erreur");
    } finally {
      setBusyUpdate(false);
    }
  };

  const filteredUpdates = useMemo(() => {
    const f = filter.trim().toLowerCase();
    if (!f || !data) return data?.updates || [];
    return (data.updates || []).filter((u) => u.name.toLowerCase().includes(f));
  }, [data, filter]);

  const filteredInstalled = useMemo(() => {
    const f = filter.trim().toLowerCase();
    if (!f || !data) return data?.installed || [];
    return (data.installed || []).filter((p) => p.name.toLowerCase().includes(f));
  }, [data, filter]);

  const toggle = (name) =>
    setSelected((s) => ({ ...s, [name]: !s[name] }));

  const selectAll = (list) => {
    setSelected(list.reduce((acc, item) => ({ ...acc, [item.name]: true }), {}));
  };
  const clearSel = () => setSelected({});

  const selectedNames = useMemo(() => Object.keys(selected).filter((k) => selected[k]), [selected]);

  const renderMachines = (agents) => (
    <ul className="divide-y divide-ink-700/60 rounded-lg border border-ink-700 max-h-[300px] overflow-auto">
      {agents.map((a) => (
        <li key={a.id}>
          <button
            className="w-full text-left px-3 py-2.5 flex items-center justify-between gap-3 hover:bg-white/[0.03] transition-colors"
            onClick={() => navigate(`/agents/${a.id}`)}
          >
            <span className="text-sm font-medium text-slate-200 truncate">{a.name}</span>
            <span className="text-[11px] font-mono text-slate-500 shrink-0">{a.hostname || a.ip || ""}</span>
          </button>
        </li>
      ))}
    </ul>
  );

  const InfoBadge = ({ onClick }) => (
    <button
      type="button"
      onClick={(e) => { e.preventDefault(); e.stopPropagation(); onClick(); }}
      title={t("packagesAll.details")}
      className="shrink-0 w-5 h-5 rounded-full bg-sky-500/20 border border-sky-400/40 text-sky-400 flex items-center justify-center hover:bg-sky-500/40 transition-colors"
    >
      <Info size={12} strokeWidth={3} />
    </button>
  );

  return (
    <div className="space-y-6 animate-fade-in">
      <div className="card !p-8">
        <div className="flex flex-col gap-4">
          <div className="flex items-center gap-3 text-brand-400">
            <Package size={24} />
            <h2 className="text-3xl font-extrabold text-white tracking-tight">
              {t("packagesAll.title")}
            </h2>
          </div>
          <p className="text-slate-400 font-medium max-w-2xl">{t("packagesAll.subtitle")}</p>
        </div>
      </div>

      <div className="card !p-6 space-y-5">
        {/* Toolbar */}
        <div className="flex flex-wrap items-center gap-3">
          <button className="btn btn-primary" onClick={scanFleet} disabled={scanning}>
            <RefreshCw size={16} className={scanning ? "animate-spin" : ""} />
            {scanning ? t("packagesAll.scanning") : t("packagesAll.scanFleet")}
          </button>

          {/* Tabs */}
          <div className="flex gap-1 rounded-lg bg-ink-800 p-1 ml-auto">
            {[
              { id: "installed", label: t("packagesAll.tabInstalled") },
              { id: "updates", label: t("packagesAll.tabUpdates") }
            ].map((tabItem) => (
              <button
                key={tabItem.id}
                onClick={() => setTab(tabItem.id)}
                className={`rounded-md px-4 py-2 text-sm font-medium transition ${
                  tab === tabItem.id ? "bg-ink-600 text-white" : "text-slate-400 hover:text-slate-200"
                }`}
              >
                {tabItem.label}
              </button>
            ))}
          </div>
        </div>

        <p className="text-xs text-slate-500">{t("packagesAll.scanHint")}</p>
        {message && <p className="text-sm text-emerald-300">{message}</p>}
        {error && <p className="text-sm text-red-400">{error}</p>}
        {loading && (
          <div className="text-center py-10">
            <div className="w-8 h-8 border-4 border-brand-500/30 border-t-brand-500 rounded-full animate-spin mx-auto" />
          </div>
        )}

        {!loading && data && (
          <div className="space-y-4">
            {/* Stats line */}
            <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-xs text-slate-400">
              <span>{t("packagesAll.scanned", { scanned: data.stats?.scannedForUpdates ?? 0, total: data.stats?.totalAgents ?? 0 })}</span>
              <span>{data.stats?.scannedForInstalled ?? 0} / {data.stats?.totalAgents ?? 0} {t("packagesAll.machines")}</span>
            </div>

            {/* Filter + bulk actions */}
            <div className="flex flex-wrap items-center gap-3">
              <div className="relative flex-1 min-w-[200px] group">
                <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-500 group-focus-within:text-brand-400 transition-colors" size={16} />
                <input
                  className="input !pl-10"
                  placeholder={t("packagesAll.pkgCol") + "…"}
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                />
              </div>

              {tab === "updates" && (
                <div className="flex flex-wrap items-center gap-2">
                  <button className="btn btn-secondary text-xs" onClick={() => selectAll(data.updates)}>
                    <CheckSquare size={14} /> {t("packagesAll.selectAll")}
                  </button>
                  <button className="btn btn-secondary text-xs" onClick={clearSel} disabled={!selectedNames.length}>
                    <Square size={14} /> {t("packagesAll.clearSelection")}
                  </button>
                  <button
                    className="btn btn-primary text-xs"
                    disabled={busyUpdate || !selectedNames.length}
                    onClick={() => setConfirm({ all: false, names: selectedNames })}
                  >
                    <Download size={14} /> {t("packagesAll.updateSelected")} ({selectedNames.length})
                  </button>
                  <button
                    className="btn btn-primary !bg-amber-500 !text-ink-900 text-xs"
                    disabled={busyUpdate || !data.updates.length}
                    onClick={() => setConfirm({ all: true, names: data.updates.map((u) => u.name) })}
                  >
                    <RefreshCw size={14} /> {t("packagesAll.updateAll")}
                  </button>
                </div>
              )}
            </div>

            {/* Installed tab */}
            {tab === "installed" && (
              <div className="max-h-[560px] divide-y divide-ink-700/60 overflow-auto rounded-lg border border-ink-700">
                {filteredInstalled.length === 0 ? (
                  <p className="p-6 text-sm text-slate-500">{t("packagesAll.noDataInstalled")}</p>
                ) : (
                  filteredInstalled.map((pkg) => (
                    <div key={pkg.name} className="flex items-center gap-3 px-4 py-3">
                      <InfoBadge onClick={() => setMachinesModal({ title: `${t("packagesAll.installedOn")}: ${pkg.name}`, agents: pkg.agents })} />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm text-slate-200">{pkg.name}</div>
                        <div className="text-[11px] text-slate-500">
                          {pkg.versions.length ? `${t("packagesAll.versions")}: ${pkg.versions.join(", ")}` : "—"}
                        </div>
                      </div>
                      <span className="shrink-0 text-xs text-slate-400">{pkg.count} {t("packagesAll.machines")}</span>
                    </div>
                  ))
                )}
              </div>
            )}

            {/* Updates tab */}
            {tab === "updates" && (
              <div className="max-h-[560px] divide-y divide-ink-700/60 overflow-auto rounded-lg border border-ink-700">
                {filteredUpdates.length === 0 ? (
                  <p className="p-6 text-sm text-slate-500">
                    {data.updates?.length === 0 ? t("packagesAll.noUpdates") : t("packagesAll.noDataUpdates")}
                  </p>
                ) : (
                  filteredUpdates.map((upd) => (
                    <label key={upd.name} className="flex cursor-pointer items-center gap-3 px-4 py-3 hover:bg-white/[0.02] transition-colors">
                      <input
                        type="checkbox"
                        checked={!!selected[upd.name]}
                        onChange={() => toggle(upd.name)}
                        className="h-4 w-4 rounded"
                      />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm text-slate-200">{upd.name}</div>
                        {upd.detail ? <div className="truncate text-[11px] text-slate-500">{upd.detail}</div> : null}
                      </div>
                      <span className="shrink-0 text-xs font-semibold text-amber-400">{upd.count} {t("packagesAll.machines")}</span>
                      <InfoBadge onClick={() => setMachinesModal({ title: `${t("packagesAll.affectedMachines")}: ${upd.name}`, agents: upd.agents })} />
                    </label>
                  ))
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Machines modal */}
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
        title={t("packagesAll.updateAll")}
        description={confirm?.all ? t("packagesAll.updateAllDescAll") : t("packagesAll.updateAllDesc")}
        confirmLabel={t("packagesAll.updateAll")}
        loading={busyUpdate}
        onClose={() => setConfirm(null)}
        onConfirm={() => applyUpdate(confirm.names)}
      />
    </div>
  );
}
