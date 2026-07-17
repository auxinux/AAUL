// Lets administrators view, install, enable, and disable plugins.

import React, { useCallback, useEffect, useState } from "react";
import { apiFetch, getCsrfToken } from "../lib/api.js";
import { useI18n } from "../lib/i18n.js";
import ConfirmDialog from "../components/ConfirmDialog.jsx";

const CATEGORY_COLORS = {
  monitoring: "bg-blue-500/20 text-blue-300",
  security: "bg-red-500/20 text-red-300",
  integration: "bg-purple-500/20 text-purple-300",
  reporting: "bg-amber-500/20 text-amber-300",
  other: "bg-slate-500/20 text-slate-300"
};

function PluginCard({ plugin, onToggle, onDelete, loading, deleting }) {
  const { t } = useI18n();
  const categoryClass = CATEGORY_COLORS[plugin.category] || CATEGORY_COLORS.other;

  return (
    <div className="card flex flex-col gap-4">
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1">
          <div className="flex items-center gap-3">
            <h3 className="text-lg font-semibold text-white">
              {plugin.displayName || plugin.name}
            </h3>
            <span className={`badge ${categoryClass}`}>
              {plugin.category || "other"}
            </span>
            {plugin.system && (
              <span className="badge bg-red-500/20 text-red-300">
                {t("plugins.system")}
              </span>
            )}
            {plugin.loaded && (
              <span className="badge bg-emerald-500/20 text-emerald-300">
                {t("plugins.active")}
              </span>
            )}
          </div>
          <p className="mt-1 text-sm text-slate-400">{plugin.description}</p>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-slate-500">v{plugin.version}</span>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-4 text-xs text-slate-400">
        <span>
          {t("plugins.author")}: {plugin.author}
        </span>
        {plugin.permissions && plugin.permissions.length > 0 && (
          <span>
            {t("plugins.permissions")}: {plugin.permissions.join(", ")}
          </span>
        )}
      </div>

      {!plugin.valid && plugin.errors && plugin.errors.length > 0 && (
        <div className="rounded-lg bg-red-500/10 p-3 text-sm text-red-300">
          <strong>{t("plugins.validationErrors")}:</strong>
          <ul className="mt-1 list-inside list-disc">
            {plugin.errors.map((error, idx) => (
              <li key={idx}>{error}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="flex justify-end gap-2">
        {plugin.valid && (
          <button
            className={`btn ${plugin.loaded ? "btn-secondary" : "btn-primary"}`}
            onClick={() => onToggle(plugin.name, plugin.loaded)}
            disabled={loading}
          >
            {loading
              ? t("common.loading")
              : plugin.loaded
                ? t("plugins.disable")
                : t("plugins.enable")}
          </button>
        )}
        {!plugin.system && (
          <button
            className="btn btn-secondary"
            onClick={() => onDelete(plugin.name)}
            disabled={deleting}
          >
            {deleting ? t("common.loading") : t("plugins.delete")}
          </button>
        )}
      </div>
    </div>
  );
}

export default function Plugins() {
  const { t } = useI18n();
  const [plugins, setPlugins] = useState([]);
  const [loading, setLoading] = useState(true);
  const [toggling, setToggling] = useState(null);
  const [deleting, setDeleting] = useState(null);
  const [installing, setInstalling] = useState(false);
  const [installFile, setInstallFile] = useState(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [deletePluginName, setDeletePluginName] = useState(null);

  const loadPlugins = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const data = await apiFetch("/api/plugins");
      setPlugins(data.plugins || []);
    } catch (err) {
      setError(err.message || t("errors.loadPlugins"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    loadPlugins();
  }, [loadPlugins]);

  const togglePlugin = async (pluginName, isCurrentlyLoaded) => {
    setToggling(pluginName);
    setError("");
    setMessage("");

    try {
      const action = isCurrentlyLoaded ? "disable" : "enable";
      await apiFetch(`/api/plugins/${pluginName}/${action}`, {
        method: "POST"
      });
      setMessage(
        isCurrentlyLoaded
          ? t("plugins.disabled", { name: pluginName })
          : t("plugins.enabled", { name: pluginName })
      );
      // Server restarts after toggle; refresh UI to reflect menu changes
      setTimeout(() => {
        window.location.reload();
      }, 800);
    } catch (err) {
      setError(err.message || t("errors.togglePlugin"));
    } finally {
      setToggling(null);
    }
  };

  const deletePlugin = async (pluginName) => {
    setDeleting(pluginName);
    setError("");
    setMessage("");

    try {
      await apiFetch(`/api/plugins/${pluginName}`, { method: "DELETE" });
      setMessage(t("plugins.deleted", { name: pluginName }));
      setDeletePluginName(null);
      setTimeout(() => {
        window.location.reload();
      }, 800);
    } catch (err) {
      setError(err.message || t("errors.togglePlugin"));
    } finally {
      setDeleting(null);
    }
  };

  const installPlugin = async () => {
    if (!installFile) {
      setError(t("plugins.installMissing"));
      return;
    }
    setInstalling(true);
    setError("");
    setMessage("");

    try {
      const form = new FormData();
      form.append("file", installFile);
      const csrfToken = getCsrfToken();
      const response = await fetch("/api/plugins/install", {
        method: "POST",
        body: form,
        headers: csrfToken ? { "X-CSRF-Token": csrfToken } : undefined,
        credentials: "include"
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data?.error || t("errors.togglePlugin"));
      }
      setMessage(t("plugins.installed", { name: data?.plugin || installFile.name }));
      setTimeout(() => {
        window.location.reload();
      }, 800);
    } catch (err) {
      setError(err.message || t("errors.togglePlugin"));
    } finally {
      setInstalling(false);
      setInstallFile(null);
    }
  };

  const activePlugins = plugins.filter((p) => p.loaded);
  const availablePlugins = plugins.filter((p) => !p.loaded);

  return (
    <div className="space-y-6">
      <div className="card">
        <h2 className="text-2xl font-semibold text-white">{t("plugins.title")}</h2>
        <p className="text-sm text-slate-400">{t("plugins.subtitle")}</p>
      </div>

      {error && (
        <div className="card border-red-500/30 bg-red-500/10">
          <p className="text-sm text-red-300">{error}</p>
        </div>
      )}

      {message && (
        <div className="card border-emerald-500/30 bg-emerald-500/10">
          <p className="text-sm text-emerald-300">{message}</p>
        </div>
      )}

      <div className="card">
        <h3 className="text-lg font-semibold text-white mb-2">
          {t("plugins.installTitle")}
        </h3>
        <p className="text-sm text-slate-400 mb-4">{t("plugins.installHint")}</p>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <input
            type="file"
            accept=".pg"
            onChange={(e) => setInstallFile(e.target.files?.[0] || null)}
            className="text-sm text-slate-300"
          />
          <button
            className="btn btn-primary"
            onClick={installPlugin}
            disabled={installing}
          >
            {installing ? t("plugins.installing") : t("plugins.installButton")}
          </button>
        </div>
      </div>

      {loading ? (
        <div className="card">
          <p className="text-sm text-slate-400">{t("plugins.loading")}</p>
        </div>
      ) : plugins.length === 0 ? (
        <div className="card">
          <div className="text-center py-8">
            <div className="text-4xl mb-4">🔌</div>
            <h3 className="text-lg font-semibold text-white mb-2">
              {t("plugins.noPlugins")}
            </h3>
            <p className="text-sm text-slate-400 max-w-md mx-auto">
              {t("plugins.noPluginsHint")}
            </p>
          </div>
        </div>
      ) : (
        <>
          {activePlugins.length > 0 && (
            <div className="space-y-4">
              <h3 className="text-lg font-semibold text-white flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-emerald-400" />
                {t("plugins.activePlugins")} ({activePlugins.length})
              </h3>
              {activePlugins.map((plugin) => (
                <PluginCard
                  key={plugin.name}
                  plugin={plugin}
                  onToggle={togglePlugin}
                  onDelete={setDeletePluginName}
                  loading={toggling === plugin.name}
                  deleting={deleting === plugin.name}
                />
              ))}
            </div>
          )}

          {availablePlugins.length > 0 && (
            <div className="space-y-4">
              <h3 className="text-lg font-semibold text-white flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-slate-400" />
                {t("plugins.availablePlugins")} ({availablePlugins.length})
              </h3>
              {availablePlugins.map((plugin) => (
                <PluginCard
                  key={plugin.name}
                  plugin={plugin}
                  onToggle={togglePlugin}
                  onDelete={setDeletePluginName}
                  loading={toggling === plugin.name}
                  deleting={deleting === plugin.name}
                />
              ))}
            </div>
          )}
        </>
      )}

      <div className="card bg-ink-800/50">
        <h3 className="text-lg font-semibold text-white mb-3">
          {t("plugins.developingTitle")}
        </h3>
        <p className="text-sm text-slate-400 mb-4">
          {t("plugins.developingHint")}
        </p>
        <div className="flex flex-wrap gap-2">
          <a
            href="https://github.com/autoupdatelinux/plugins"
            target="_blank"
            rel="noopener noreferrer"
            className="btn btn-secondary"
          >
            {t("plugins.documentation")}
          </a>
          <a
            href="https://autoupdatelinux.com/pro"
            target="_blank"
            rel="noopener noreferrer"
            className="btn btn-primary"
          >
            {t("plugins.professional")}
          </a>
        </div>
      </div>

      <ConfirmDialog
        open={Boolean(deletePluginName)}
        title={t("plugins.delete")}
        description={
          deletePluginName ? t("plugins.deleteConfirm", { name: deletePluginName }) : ""
        }
        confirmLabel={t("plugins.delete")}
        tone="danger"
        onClose={() => setDeletePluginName(null)}
        onConfirm={() => deletePlugin(deletePluginName)}
      />
    </div>
  );
}
