import React, { useEffect, useMemo, useState } from "react";
import { apiFetch } from "../lib/api.js";
import { useI18n } from "../lib/i18n.js";

const POLL_INTERVAL_MS = 2000;
const MAX_POLL_ATTEMPTS = 120;

function formatBytes(size) {
  if (size === null || size === undefined) {
    return "-";
  }
  if (size < 1024) {
    return `${size} B`;
  }
  if (size < 1024 * 1024) {
    return `${(size / 1024).toFixed(1)} KB`;
  }
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

export default function Logs() {
  const { t, lang } = useI18n();
  const [agents, setAgents] = useState([]);
  const [selectedAgent, setSelectedAgent] = useState(null);
  const [logs, setLogs] = useState([]);
  const [logContent, setLogContent] = useState("");
  const [logMeta, setLogMeta] = useState(null);
  const [loadingAgents, setLoadingAgents] = useState(true);
  const [loadingLogs, setLoadingLogs] = useState(false);
  const [loadingContent, setLoadingContent] = useState(false);
  const [error, setError] = useState("");
  const [contentError, setContentError] = useState("");

  const loadAgents = async () => {
    setLoadingAgents(true);
    setError("");
    try {
      const data = await apiFetch("/api/agents");
      setAgents(data.agents || []);
      if (!selectedAgent && data.agents?.length) {
        setSelectedAgent(data.agents[0]);
      }
    } catch (err) {
      setError(err.message || t("errors.loadAgents"));
    } finally {
      setLoadingAgents(false);
    }
  };

  useEffect(() => {
    loadAgents();
  }, []);

  const pollCommand = async (agentId, commandId) => {
    for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt += 1) {
      const data = await apiFetch(`/api/agents/${agentId}/commands/${commandId}`);
      if (data.command?.status === "DONE" || data.command?.status === "ERROR") {
        return data.command;
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
    throw new Error(t("errors.commandTimeout"));
  };

  const fetchLogs = async () => {
    if (!selectedAgent) {
      return;
    }
    setLoadingLogs(true);
    setError("");
    setLogs([]);
    setLogContent("");
    setLogMeta(null);
    try {
      const result = await apiFetch(`/api/agents/${selectedAgent.id}/commands/logs`, {
        method: "POST"
      });
      const command = await pollCommand(selectedAgent.id, result.commandId);
      if (command.status === "ERROR") {
        setError(command.errorMessage || t("errors.commandFailed"));
      } else {
        setLogs(command.result?.logs || []);
      }
    } catch (err) {
      setError(err.message || t("errors.loadLogs"));
    } finally {
      setLoadingLogs(false);
    }
  };

  const fetchLogContent = async (logName) => {
    if (!selectedAgent) {
      return;
    }
    setLoadingContent(true);
    setContentError("");
    setLogContent("");
    setLogMeta(null);
    try {
      const result = await apiFetch(
        `/api/agents/${selectedAgent.id}/commands/log-content`,
        {
          method: "POST",
          body: JSON.stringify({ logName })
        }
      );
      const command = await pollCommand(selectedAgent.id, result.commandId);
      if (command.status === "ERROR") {
        setContentError(command.errorMessage || t("errors.commandFailed"));
      } else {
        setLogContent(command.result?.content || "");
        setLogMeta(command.result || null);
      }
    } catch (err) {
      setContentError(err.message || t("errors.loadLogContent"));
    } finally {
      setLoadingContent(false);
    }
  };

  const agentsDisplay = useMemo(() => agents, [agents]);

  return (
    <div className="space-y-6">
      <div className="card">
        <div className="flex flex-col justify-between gap-4 md:flex-row md:items-center">
          <div>
            <h2 className="text-2xl font-semibold text-white">{t("logs.title")}</h2>
            <p className="text-sm text-slate-400">{t("logs.subtitle")}</p>
          </div>
          <button className="btn btn-secondary" onClick={loadAgents}>
            {t("logs.refreshAgents")}
          </button>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-[280px_1fr]">
        <div className="card space-y-3">
          <h3 className="text-sm uppercase tracking-[0.3em] text-slate-400">
            {t("logs.agents")}
          </h3>
          {loadingAgents ? (
            <p className="text-sm text-slate-400">{t("common.loading")}</p>
          ) : null}
          {error ? <p className="text-sm text-red-400">{error}</p> : null}
          <div className="space-y-2">
            {agentsDisplay.map((agent) => (
              <button
                key={agent.id}
                className={`w-full rounded-xl px-4 py-3 text-left text-sm transition ${
                  selectedAgent?.id === agent.id
                    ? "bg-ink-700 text-white"
                    : "bg-ink-800 text-slate-300 hover:bg-ink-700"
                }`}
                onClick={() => {
                  setSelectedAgent(agent);
                  setLogs([]);
                  setLogContent("");
                  setLogMeta(null);
                  setError("");
                  setContentError("");
                }}
              >
                <div className="font-semibold">{agent.displayName}</div>
                <div className="text-xs text-slate-400">
                  {agent.hostname || agent.ip || "-"}
                </div>
              </button>
            ))}
            {!agentsDisplay.length && !loadingAgents ? (
              <p className="text-xs text-slate-500">{t("logs.noAgents")}</p>
            ) : null}
          </div>
        </div>

        <div className="space-y-6">
          <div className="card space-y-4">
            <div className="flex flex-col justify-between gap-3 md:flex-row md:items-center">
              <div>
                <h3 className="text-lg font-semibold text-white">
                  {selectedAgent
                    ? t("logs.availableLogs", { name: selectedAgent.displayName })
                    : t("logs.selectAgent")}
                </h3>
                <p className="text-xs text-slate-400">
                  {t("logs.instructions")}
                </p>
                {loadingLogs ? (
                  <p className="mt-2 text-xs text-slate-500">{t("logs.waiting")}</p>
                ) : null}
              </div>
              <button
                className="btn btn-secondary"
                onClick={fetchLogs}
                disabled={!selectedAgent || loadingLogs}
              >
                {loadingLogs ? t("logs.loadingLogs") : t("logs.loadLogs")}
              </button>
            </div>
            {error ? <p className="text-sm text-red-400">{error}</p> : null}
            <div className="space-y-2">
              {logs.map((log) => (
                <div
                  key={log.name}
                  className="flex flex-col justify-between gap-3 rounded-xl border border-ink-700 bg-ink-800 p-3 md:flex-row md:items-center"
                >
                  <div>
                    <div className="font-mono text-sm text-slate-100">{log.name}</div>
                    <div className="text-xs text-slate-400">
                      {log.modifiedAt
                        ? new Date(log.modifiedAt).toLocaleString(lang)
                        : "-"} · {formatBytes(log.sizeBytes)}
                    </div>
                  </div>
                  <button
                    className="btn btn-primary"
                    onClick={() => fetchLogContent(log.name)}
                    disabled={loadingContent}
                  >
                    {t("logs.view")}
                  </button>
                </div>
              ))}
              {!logs.length && !loadingLogs ? (
                <p className="text-xs text-slate-500">{t("logs.noLogs")}</p>
              ) : null}
            </div>
          </div>

          <div className="card space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h3 className="text-lg font-semibold text-white">{t("logs.content")}</h3>
              {logMeta?.truncated ? (
                <span className="badge bg-yellow-500/20 text-yellow-300">
                  {t("logs.truncated")}
                </span>
              ) : null}
            </div>
            {loadingContent ? (
              <p className="text-xs text-slate-500">{t("logs.waiting")}</p>
            ) : null}
            {loadingContent ? (
              <p className="text-sm text-slate-400">{t("logs.loadingContent")}</p>
            ) : null}
            {contentError ? <p className="text-sm text-red-400">{contentError}</p> : null}
            {logMeta ? (
              <div className="text-xs text-slate-400">
                {logMeta.name} · {formatBytes(logMeta.sizeBytes)}
              </div>
            ) : null}
            <pre className="max-h-[400px] max-w-full overflow-auto whitespace-pre-wrap break-words rounded-xl bg-ink-900/80 p-4 text-xs text-slate-200">
              {logContent || t("logs.noContent")}
            </pre>
          </div>
        </div>
      </div>
    </div>
  );
}
