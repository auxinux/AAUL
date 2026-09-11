import React, { useEffect, useRef, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { apiFetch } from "../lib/api.js";
import ConfirmDialog from "../components/ConfirmDialog.jsx";

const POLL_INTERVAL_MS = 1500;
const MAX_POLL_ATTEMPTS = 240; // up to ~6 min for long installs

// Create a command then poll until it finishes; returns the command result.
async function runCommand(id, path, body) {
  const res = await apiFetch(`/api/agents/${id}/${path}`, {
    method: "POST",
    body: body ? JSON.stringify(body) : undefined
  });
  const commandId = res.commandId;
  let lastStatus = null;
  for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt += 1) {
    const data = await apiFetch(`/api/agents/${id}/commands/${commandId}`);
    lastStatus = data.command?.status || lastStatus;
    if (data.command?.status === "DONE" || data.command?.status === "ERROR") {
      return data.command;
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  // Still waiting behind other commands is not a failure of this one.
  throw new Error(
    lastStatus === "QUEUED" ? "La commande attend son tour dans la file de la machine." : "Délai dépassé"
  );
}

export default function Packages() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  const [agent, setAgent] = useState(null);
  const [tab, setTab] = useState(searchParams.get("tab") === "updates" ? "updates" : "installed");
  const [enabled, setEnabled] = useState(false);
  const [savingToggle, setSavingToggle] = useState(false);

  // Available updates
  const [updates, setUpdates] = useState(null);
  const [updatesManager, setUpdatesManager] = useState("");
  const [selectedUpdates, setSelectedUpdates] = useState({});
  const [checkingUpdates, setCheckingUpdates] = useState(false);

  // Installed list
  const [installed, setInstalled] = useState([]);
  // Distinguishes "never queried" from "queried, nothing came back": both leave
  // `installed` empty, and showing the same hint for each made a working button
  // look broken.
  const [installedLoaded, setInstalledLoaded] = useState(false);
  const [installedManager, setInstalledManager] = useState("");
  const [filter, setFilter] = useState("");
  const [loadingList, setLoadingList] = useState(false);

  // Search
  const [query, setQuery] = useState("");
  const [results, setResults] = useState(null);
  const [searching, setSearching] = useState(false);

  const [busyPkg, setBusyPkg] = useState("");
  const [message, setMessage] = useState("");
  const [output, setOutput] = useState("");
  const [confirm, setConfirm] = useState(null); // { action, name }

  const loadAgent = async () => {
    try {
      const data = await apiFetch(`/api/agents/${id}`);
      setAgent(data.agent || null);
      setEnabled(Boolean(data.agent?.packagesEnabled));
      if (data.agent?.updates) {
        setUpdates(data.agent.updates.updates || []);
        setUpdatesManager(data.agent.updates.manager || "");
      }
    } catch (err) {
      setMessage("Erreur : " + (err.message || ""));
    }
  };

  useEffect(() => { loadAgent(); }, [id]);

  const checkUpdates = async () => {
    setCheckingUpdates(true);
    setMessage("");
    try {
      const cmd = await runCommand(id, "packages/check-updates");
      if (cmd.status === "ERROR") {
        setMessage("Erreur : " + (cmd.errorMessage || "échec"));
      } else {
        setUpdates(cmd.result?.updates || []);
        setUpdatesManager(cmd.result?.manager || "");
        setSelectedUpdates({});
      }
    } catch (err) {
      setMessage("Erreur : " + (err.message || ""));
    } finally {
      setCheckingUpdates(false);
    }
  };

  // Arriving from the dashboard "MAJ requise" badge → run a fresh scan so the
  // displayed state is current and the dashboard badge resynchronises.
  const didAutoCheck = useRef(false);
  useEffect(() => {
    if (searchParams.get("tab") === "updates" && !didAutoCheck.current) {
      didAutoCheck.current = true;
      checkUpdates();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const applyUpdates = async (names) => {
    setBusyPkg("__updates__");
    setMessage("");
    setOutput("");
    try {
      const cmd = await runCommand(id, "packages/update", { names });
      const ok = cmd.status !== "ERROR" && cmd.result?.success;
      setOutput(cmd.result?.output || cmd.errorMessage || "");
      setMessage(ok ? `✓ Mise à jour appliquée (${names.length} paquet(s))` : `✗ Échec : ${cmd.errorMessage || "voir la sortie"}`);
      if (ok) { setUpdates([]); setSelectedUpdates({}); }
    } catch (err) {
      setMessage("Erreur : " + (err.message || ""));
    } finally {
      setBusyPkg("");
    }
  };

  const applyAll = async () => {
    // "Tout mettre à jour" = full system update (RUN_NOW), always available.
    setConfirm(null);
    setBusyPkg("__updates__");
    setMessage("Mise à jour complète lancée…");
    try {
      const cmd = await runCommand(id, "commands/run-now");
      const ok = cmd.status !== "ERROR";
      setMessage(ok ? "✓ Mise à jour complète terminée" : `✗ Échec : ${cmd.errorMessage || ""}`);
      if (ok) { setUpdates([]); setSelectedUpdates({}); }
    } catch (err) {
      setMessage("Erreur : " + (err.message || ""));
    } finally {
      setBusyPkg("");
    }
  };

  const toggleEnabled = async (value) => {
    setSavingToggle(true);
    setEnabled(value);
    try {
      await apiFetch(`/api/agents/${id}/packages`, {
        method: "PUT",
        body: JSON.stringify({ enabled: value })
      });
    } catch (err) {
      setEnabled(!value);
      setMessage("Erreur : " + (err.message || ""));
    } finally {
      setSavingToggle(false);
    }
  };

  const loadInstalled = async () => {
    setLoadingList(true);
    setMessage("");
    try {
      const cmd = await runCommand(id, "packages/list");
      if (cmd.status === "ERROR") {
        setMessage("Erreur : " + (cmd.errorMessage || "échec"));
      } else {
        setInstalled(cmd.result?.packages || []);
        setInstalledManager(cmd.result?.manager || "");
        setInstalledLoaded(true);
      }
    } catch (err) {
      setMessage("Erreur : " + (err.message || ""));
    } finally {
      setLoadingList(false);
    }
  };

  const doSearch = async () => {
    if (!query.trim()) return;
    setSearching(true);
    setMessage("");
    setResults(null);
    try {
      const cmd = await runCommand(id, "packages/search", { query: query.trim() });
      if (cmd.status === "ERROR") {
        setMessage("Erreur : " + (cmd.errorMessage || "échec"));
      } else {
        setResults(cmd.result?.results || []);
      }
    } catch (err) {
      setMessage("Erreur : " + (err.message || ""));
    } finally {
      setSearching(false);
    }
  };

  const performAction = async (action, name) => {
    setConfirm(null);
    setBusyPkg(name);
    setMessage("");
    setOutput("");
    try {
      const path = action === "install" ? "packages/install" : "packages/remove";
      const cmd = await runCommand(id, path, { name });
      const ok = cmd.status !== "ERROR" && cmd.result?.success;
      setOutput(cmd.result?.output || cmd.errorMessage || "");
      setMessage(
        ok
          ? `✓ ${action === "install" ? "Installé" : "Désinstallé"} : ${name}`
          : `✗ Échec (${name}) : ${cmd.errorMessage || "voir la sortie"}`
      );
      if (ok && tab === "installed") loadInstalled();
    } catch (err) {
      setMessage("Erreur : " + (err.message || ""));
    } finally {
      setBusyPkg("");
    }
  };

  const filtered = filter
    ? installed.filter((p) => p.name.toLowerCase().includes(filter.toLowerCase()))
    : installed;

  return (
    <div className="space-y-6">
      <div className="card">
        <div className="flex flex-col justify-between gap-4 md:flex-row md:items-center">
          <div>
            <h2 className="text-2xl font-semibold text-white">
              Paquets — {agent?.displayName || "…"}
            </h2>
            <p className="text-sm text-slate-400">
              Gestionnaire : <span className="text-slate-200">{installedManager || agent?.osInfo?.name || "détecté à la demande"}</span>
            </p>
          </div>
          <button className="btn btn-secondary" onClick={() => navigate(`/agents/${id}`)}>
            ← Retour
          </button>
        </div>
      </div>

      {/* Opt-in toggle */}
      <div className="card flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div>
          <h3 className="text-sm font-semibold text-white">Installation / désinstallation à distance</h3>
          <p className="text-xs text-slate-500">
            Désactivé par défaut. Lister et rechercher restent toujours disponibles.
            Les paquets critiques au démarrage (grub, kernel, init…) sont bloqués.
          </p>
        </div>
        <label className="flex shrink-0 cursor-pointer items-center gap-2">
          <input
            type="checkbox"
            checked={enabled}
            disabled={savingToggle}
            onChange={(e) => toggleEnabled(e.target.checked)}
            className="h-4 w-4 rounded border-ink-600 bg-ink-800 text-emerald-500 focus:ring-emerald-500"
          />
          <span className="text-sm text-slate-200">{enabled ? "Activé" : "Désactivé"}</span>
        </label>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 rounded-lg bg-ink-800 p-1">
        {[
          { id: "installed", label: "📦 Installés" },
          { id: "search", label: "🔍 Rechercher & installer" },
          { id: "updates", label: "⬆️ Mises à jour" }
        ].map((tabItem) => (
          <button
            key={tabItem.id}
            onClick={() => setTab(tabItem.id)}
            className={`flex-1 rounded-md px-3 py-2 text-sm font-medium transition ${
              tab === tabItem.id ? "bg-ink-600 text-white" : "text-slate-400 hover:text-slate-200"
            }`}
          >
            {tabItem.label}
          </button>
        ))}
      </div>

      {message && (
        <p className={`text-sm ${message.startsWith("Erreur") || message.startsWith("✗") ? "text-red-400" : "text-emerald-300"}`}>
          {message}
        </p>
      )}
      {output && (
        <pre className="max-h-60 overflow-auto rounded-lg bg-ink-900 p-3 text-xs text-slate-300 whitespace-pre-wrap">{output}</pre>
      )}

      {/* Installed tab */}
      {tab === "installed" && (
        <div className="card space-y-4">
          <div className="flex flex-wrap items-center gap-3">
            <button className="btn btn-primary" onClick={loadInstalled} disabled={loadingList}>
              {loadingList ? "Chargement…" : "Charger la liste"}
            </button>
            {installed.length > 0 && (
              <>
                <input
                  className="input flex-1 min-w-[200px]"
                  placeholder="Filtrer…"
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                />
                <span className="text-xs text-slate-500">{filtered.length} / {installed.length}</span>
              </>
            )}
          </div>
          {installed.length > 0 ? (
            <div className="max-h-[480px] divide-y divide-ink-700/60 overflow-auto rounded-lg border border-ink-700">
              {filtered.map((pkg) => (
                <div key={pkg.name} className="flex items-center justify-between gap-3 px-3 py-2">
                  <div className="min-w-0">
                    <div className="truncate text-sm text-slate-200">{pkg.name}</div>
                    {pkg.version ? <div className="text-xs text-slate-500">{pkg.version}</div> : null}
                  </div>
                  {enabled && (
                    <button
                      className="btn btn-secondary shrink-0 text-xs px-3 py-1.5"
                      disabled={busyPkg === pkg.name}
                      onClick={() => setConfirm({ action: "remove", name: pkg.name })}
                    >
                      {busyPkg === pkg.name ? "…" : "Désinstaller"}
                    </button>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-slate-500">
              {installedLoaded
                ? "La machine a répondu, mais n'a signalé aucun paquet installé."
                : "Clique sur « Charger la liste » pour interroger la machine distante."}
            </p>
          )}
        </div>
      )}

      {/* Search tab */}
      {tab === "search" && (
        <div className="card space-y-4">
          <div className="flex flex-wrap items-center gap-3">
            <input
              className="input flex-1 min-w-[200px]"
              placeholder="Nom du paquet à rechercher…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && doSearch()}
            />
            <button className="btn btn-primary" onClick={doSearch} disabled={searching}>
              {searching ? "Recherche…" : "Rechercher"}
            </button>
          </div>
          {results !== null && (
            results.length > 0 ? (
              <div className="max-h-[480px] divide-y divide-ink-700/60 overflow-auto rounded-lg border border-ink-700">
                {results.map((pkg) => (
                  <div key={pkg.name} className="flex items-center justify-between gap-3 px-3 py-2">
                    <div className="min-w-0">
                      <div className="truncate text-sm text-slate-200">{pkg.name}</div>
                      {pkg.summary ? <div className="truncate text-xs text-slate-500">{pkg.summary}</div> : null}
                    </div>
                    {enabled ? (
                      <button
                        className="btn btn-primary shrink-0 text-xs px-3 py-1.5"
                        disabled={busyPkg === pkg.name}
                        onClick={() => setConfirm({ action: "install", name: pkg.name })}
                      >
                        {busyPkg === pkg.name ? "…" : "Installer"}
                      </button>
                    ) : (
                      <span className="shrink-0 text-xs text-slate-600">activation requise</span>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-slate-500">Aucun résultat.</p>
            )
          )}
        </div>
      )}

      {/* Updates tab */}
      {tab === "updates" && (
        <div className="card space-y-4">
          <div className="flex flex-wrap items-center gap-3">
            <button className="btn btn-primary" onClick={checkUpdates} disabled={checkingUpdates}>
              {checkingUpdates ? "Recherche…" : "🔄 Rechercher les mises à jour"}
            </button>
            <button
              className="btn btn-secondary"
              disabled={busyPkg === "__updates__"}
              onClick={() => setConfirm({ action: "updateAll" })}
            >
              {busyPkg === "__updates__" ? "…" : "Tout mettre à jour"}
            </button>
            {enabled && updates && updates.length > 0 ? (
              <button
                className="btn btn-primary"
                disabled={busyPkg === "__updates__" || Object.values(selectedUpdates).every((v) => !v)}
                onClick={() => {
                  const names = updates.map((u) => u.name).filter((n) => selectedUpdates[n]);
                  if (names.length) applyUpdates(names);
                }}
              >
                Mettre à jour la sélection
              </button>
            ) : null}
            <span className="text-xs text-slate-500">
              {updatesManager ? `Gestionnaire : ${updatesManager}` : ""}
            </span>
          </div>

          {updates === null ? (
            <p className="text-sm text-slate-500">Lance une recherche pour voir les mises à jour disponibles.</p>
          ) : updates.length === 0 ? (
            <p className="text-sm text-emerald-300">✓ Tout est à jour.</p>
          ) : (
            <div className="max-h-[460px] divide-y divide-ink-700/60 overflow-auto rounded-lg border border-ink-700">
              {updates.map((u) => (
                <label key={u.name} className="flex cursor-pointer items-center gap-3 px-3 py-2">
                  <input
                    type="checkbox"
                    disabled={!enabled}
                    checked={!!selectedUpdates[u.name]}
                    onChange={(e) => setSelectedUpdates((s) => ({ ...s, [u.name]: e.target.checked }))}
                    className="h-4 w-4 rounded"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-slate-200">{u.name}</span>
                    {u.detail ? <span className="block truncate text-xs text-slate-500">{u.detail}</span> : null}
                  </span>
                </label>
              ))}
            </div>
          )}
          {!enabled && updates && updates.length > 0 ? (
            <p className="text-xs text-slate-500">
              « Mettre à jour la sélection » nécessite d'activer la gestion de paquets (ci-dessus).
              « Tout mettre à jour » reste disponible.
            </p>
          ) : null}
        </div>
      )}

      <ConfirmDialog
        open={Boolean(confirm)}
        title={
          confirm?.action === "install" ? "Installer le paquet"
          : confirm?.action === "updateAll" ? "Tout mettre à jour"
          : "Désinstaller le paquet"
        }
        description={
          confirm?.action === "updateAll"
            ? `Lancer une mise à jour COMPLÈTE du système sur ${agent?.displayName || "cet agent"} ? (tous les paquets, redémarrage possible)`
            : confirm
            ? `Confirmer ${confirm.action === "install" ? "l'installation" : "la désinstallation"} de « ${confirm.name} » sur ${agent?.displayName || "cet agent"} ?`
            : ""
        }
        confirmLabel={
          confirm?.action === "install" ? "Installer"
          : confirm?.action === "updateAll" ? "Tout mettre à jour"
          : "Désinstaller"
        }
        tone={confirm?.action === "remove" ? "danger" : "primary"}
        onClose={() => setConfirm(null)}
        onConfirm={() => {
          if (confirm.action === "updateAll") applyAll();
          else performAction(confirm.action, confirm.name);
        }}
      />
    </div>
  );
}
