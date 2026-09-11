import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  ClipboardList,
  RefreshCw,
  Search,
  Download,
  Trash2,
  FileText,
  Server,
  HardDrive,
  X,
  WrapText,
  ArrowDownToLine
} from "lucide-react";
import { apiFetch } from "../lib/api.js";
import { useI18n } from "../lib/i18n.js";
import ConfirmDialog from "../components/ConfirmDialog.jsx";

const POLL_INTERVAL_MS = 2000;
const MAX_POLL_ATTEMPTS = 120;

// Log lines are classified by keyword so problems stand out without the user
// having to read every line. Order matters: the first match wins, so ERROR
// beats WARN on a line that contains both.
const LEVEL_RULES = [
  { level: "error", pattern: /\b(error|erreur|fail(ed|ure)?|critical|fatal|exception|refused|denied)\b/i },
  { level: "warn", pattern: /\b(warn(ing)?|attention|avertissement|deprecat|timeout|retry)\b/i },
  { level: "success", pattern: /\b(success|succès|completed|done|ok|installed|updated)\b/i }
];

const LEVEL_STYLES = {
  error: "text-red-300 bg-red-500/[0.07]",
  warn: "text-amber-300 bg-amber-500/[0.06]",
  success: "text-emerald-300",
  info: "text-slate-300"
};

function classifyLine(line) {
  for (const rule of LEVEL_RULES) {
    if (rule.pattern.test(line)) return rule.level;
  }
  return "info";
}

function formatBytes(size) {
  if (size === null || size === undefined) return "—";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

export default function Logs() {
  const { t, lang } = useI18n();

  const [agents, setAgents] = useState([]);
  const [selectedAgent, setSelectedAgent] = useState(null);
  const [agentFilter, setAgentFilter] = useState("");

  const [logs, setLogs] = useState([]);
  const [logStats, setLogStats] = useState(null);
  const [logContent, setLogContent] = useState("");
  const [logMeta, setLogMeta] = useState(null);

  const [loadingAgents, setLoadingAgents] = useState(true);
  const [loadingLogs, setLoadingLogs] = useState(false);
  const [loadingContent, setLoadingContent] = useState(false);
  const [pruning, setPruning] = useState(false);

  const [error, setError] = useState("");
  const [contentError, setContentError] = useState("");
  const [notice, setNotice] = useState("");

  // Content view controls
  const [contentFilter, setContentFilter] = useState("");
  const [levelFilter, setLevelFilter] = useState("all");
  const [wrapLines, setWrapLines] = useState(true);
  const [confirmPrune, setConfirmPrune] = useState(false);

  // Retention policy, shown here because this is where an admin thinks about it.
  const [retention, setRetention] = useState({ logRetentionDays: "", logMaxTotalMb: "" });
  const [savingRetention, setSavingRetention] = useState(false);

  const contentRef = useRef(null);

  const loadAgents = async () => {
    setLoadingAgents(true);
    setError("");
    try {
      const data = await apiFetch("/api/agents");
      const list = data.agents || [];
      setAgents(list);
      setSelectedAgent((current) => {
        if (current) {
          // Keep the selection but refresh its data.
          return list.find((a) => a.id === current.id) || current;
        }
        return list[0] || null;
      });
    } catch (err) {
      setError(err.message || t("errors.loadAgents"));
    } finally {
      setLoadingAgents(false);
    }
  };

  const loadRetention = async () => {
    try {
      const data = await apiFetch("/api/settings");
      setRetention({
        logRetentionDays: data.settings?.logRetentionDays ?? "",
        logMaxTotalMb: data.settings?.logMaxTotalMb ?? ""
      });
    } catch {
      // Non-admins simply do not get the retention panel.
      setRetention(null);
    }
  };

  useEffect(() => {
    loadAgents();
    loadRetention();
  }, []);

  const pollCommand = async (agentId, commandId) => {
    let lastStatus = null;
    for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt += 1) {
      const data = await apiFetch(`/api/agents/${agentId}/commands/${commandId}`);
      lastStatus = data.command?.status || lastStatus;
      if (data.command?.status === "DONE" || data.command?.status === "ERROR") {
        return data.command;
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
    // Still waiting behind other commands is not a failure of this one.
    throw new Error(lastStatus === "QUEUED" ? t("errors.commandQueued") : t("errors.commandTimeout"));
  };

  const resetLogView = () => {
    setLogs([]);
    setLogStats(null);
    setLogContent("");
    setLogMeta(null);
    setError("");
    setContentError("");
    setNotice("");
    setContentFilter("");
    setLevelFilter("all");
  };

  const fetchLogs = async () => {
    if (!selectedAgent) return;
    setLoadingLogs(true);
    resetLogView();
    try {
      const result = await apiFetch(`/api/agents/${selectedAgent.id}/commands/logs`, {
        method: "POST"
      });
      const command = await pollCommand(selectedAgent.id, result.commandId);
      if (command.status === "ERROR") {
        setError(command.errorMessage || t("errors.commandFailed"));
      } else {
        setLogs(command.result?.logs || []);
        setLogStats(command.result?.stats || null);
      }
    } catch (err) {
      setError(err.message || t("errors.loadLogs"));
    } finally {
      setLoadingLogs(false);
    }
  };

  const fetchLogContent = async (logName) => {
    if (!selectedAgent) return;
    setLoadingContent(true);
    setContentError("");
    setLogContent("");
    setLogMeta(null);
    try {
      const result = await apiFetch(`/api/agents/${selectedAgent.id}/commands/log-content`, {
        method: "POST",
        body: JSON.stringify({ logName })
      });
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

  // Ask this host to enforce the retention policy right now, instead of waiting
  // for its hourly pass — useful when a disk is filling up.
  const pruneNow = async () => {
    setConfirmPrune(false);
    if (!selectedAgent) return;
    setPruning(true);
    setNotice("");
    try {
      const result = await apiFetch(`/api/agents/${selectedAgent.id}/commands/prune-logs`, {
        method: "POST"
      });
      const command = await pollCommand(selectedAgent.id, result.commandId);
      if (command.status === "ERROR") {
        setError(command.errorMessage || t("errors.commandFailed"));
      } else {
        const removed = command.result?.removed?.length || 0;
        setNotice(
          t("logs.pruneDone", { n: removed, size: formatBytes(command.result?.freedBytes || 0) })
        );
        setLogStats(command.result?.stats || null);
        await fetchLogs();
      }
    } catch (err) {
      setError(err.message || t("errors.commandFailed"));
    } finally {
      setPruning(false);
    }
  };

  const saveRetention = async () => {
    setSavingRetention(true);
    setNotice("");
    try {
      // Send only the two fields this page owns. The settings endpoint keeps
      // any field a caller omits, so this cannot clobber the network settings
      // configured on the Admin page.
      await apiFetch("/api/settings", {
        method: "POST",
        body: JSON.stringify({
          logRetentionDays: retention.logRetentionDays,
          logMaxTotalMb: retention.logMaxTotalMb
        })
      });
      setNotice(t("logs.retentionSaved"));
    } catch (err) {
      setError(err.message || t("errors.saveFailed"));
    } finally {
      setSavingRetention(false);
    }
  };

  const downloadLog = () => {
    if (!logContent || !logMeta) return;
    const blob = new Blob([logContent], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${selectedAgent?.displayName || "agent"}-${logMeta.name}`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const filteredAgents = useMemo(() => {
    const needle = agentFilter.trim().toLowerCase();
    if (!needle) return agents;
    return agents.filter(
      (a) =>
        (a.displayName || "").toLowerCase().includes(needle) ||
        (a.hostname || "").toLowerCase().includes(needle) ||
        (a.ip || "").toLowerCase().includes(needle)
    );
  }, [agents, agentFilter]);

  // Parse once, filter cheaply. Lines are kept with their original number so a
  // filtered view still tells you where you are in the file.
  const parsedLines = useMemo(() => {
    if (!logContent) return [];
    return logContent.split("\n").map((text, index) => ({
      number: index + 1,
      text,
      level: classifyLine(text)
    }));
  }, [logContent]);

  const visibleLines = useMemo(() => {
    const needle = contentFilter.trim().toLowerCase();
    return parsedLines.filter((line) => {
      if (levelFilter !== "all" && line.level !== levelFilter) return false;
      if (needle && !line.text.toLowerCase().includes(needle)) return false;
      return true;
    });
  }, [parsedLines, contentFilter, levelFilter]);

  const levelCounts = useMemo(() => {
    const counts = { all: parsedLines.length, error: 0, warn: 0, success: 0, info: 0 };
    for (const line of parsedLines) counts[line.level] += 1;
    return counts;
  }, [parsedLines]);

  const scrollToBottom = () => {
    if (contentRef.current) {
      contentRef.current.scrollTop = contentRef.current.scrollHeight;
    }
  };

  return (
    <div className="space-y-5 sm:space-y-6 animate-fade-in">
      {/* Header */}
      <div className="card">
        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div className="space-y-1">
            <div className="flex items-center gap-3 text-brand-400">
              <ClipboardList size={22} className="shrink-0" />
              <h2 className="page-title">{t("logs.title")}</h2>
            </div>
            <p className="page-subtitle">{t("logs.subtitle")}</p>
          </div>
          <button className="btn btn-secondary shrink-0" onClick={loadAgents}>
            <RefreshCw size={16} className={loadingAgents ? "animate-spin" : ""} />
            {t("logs.refreshAgents")}
          </button>
        </div>
      </div>

      {/* Retention policy — admin only (the settings call fails for others). */}
      {retention && (
        <div className="card space-y-4">
          <div className="flex items-center gap-2">
            <HardDrive size={16} className="text-brand-400" />
            <h3 className="text-sm font-bold uppercase tracking-widest text-slate-400">
              {t("logs.retentionTitle")}
            </h3>
          </div>
          <p className="text-xs text-slate-500 max-w-2xl">{t("logs.retentionHint")}</p>
          <div className="grid gap-3 sm:grid-cols-3">
            <label className="space-y-1.5">
              <span className="text-[10px] font-bold uppercase tracking-widest text-slate-500">
                {t("logs.retentionDays")}
              </span>
              <input
                className="input"
                type="number"
                min="1"
                max="3650"
                value={retention.logRetentionDays}
                onChange={(e) =>
                  setRetention((r) => ({ ...r, logRetentionDays: e.target.value }))
                }
              />
            </label>
            <label className="space-y-1.5">
              <span className="text-[10px] font-bold uppercase tracking-widest text-slate-500">
                {t("logs.retentionMaxMb")}
              </span>
              <input
                className="input"
                type="number"
                min="1"
                max="100000"
                value={retention.logMaxTotalMb}
                onChange={(e) => setRetention((r) => ({ ...r, logMaxTotalMb: e.target.value }))}
              />
            </label>
            <div className="flex items-end">
              <button
                className="btn btn-primary w-full"
                onClick={saveRetention}
                disabled={savingRetention}
              >
                {savingRetention ? t("common.saving") : t("common.save")}
              </button>
            </div>
          </div>
        </div>
      )}

      {notice && (
        <p className="text-sm text-emerald-300 rounded-xl bg-emerald-500/10 border border-emerald-500/20 p-3">
          {notice}
        </p>
      )}

      <div className="grid gap-5 lg:grid-cols-[280px_1fr]">
        {/* Agent picker */}
        <div className="card space-y-3">
          <h3 className="text-[10px] font-bold uppercase tracking-widest text-slate-500">
            {t("logs.agents")}
          </h3>

          <div className="relative">
            <Search
              className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500"
              size={14}
            />
            <input
              className="input !pl-9 !py-2 text-xs"
              placeholder={t("logs.filterAgents")}
              value={agentFilter}
              onChange={(e) => setAgentFilter(e.target.value)}
            />
          </div>

          {loadingAgents && <p className="text-sm text-slate-400">{t("common.loading")}</p>}
          {error && <p className="text-sm text-red-400">{error}</p>}

          <div className="space-y-1.5 max-h-[45vh] lg:max-h-[60vh] overflow-y-auto no-scrollbar">
            {filteredAgents.map((agent) => (
              <button
                key={agent.id}
                className={`w-full rounded-xl px-3 py-2.5 text-left transition ${
                  selectedAgent?.id === agent.id
                    ? "bg-brand-500/10 border border-brand-500/30 text-white"
                    : "bg-white/[0.02] border border-transparent text-slate-300 hover:bg-white/5"
                }`}
                onClick={() => {
                  setSelectedAgent(agent);
                  resetLogView();
                }}
              >
                <div className="flex items-center gap-2 min-w-0">
                  <span
                    className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                      agent.isOnline ? "bg-emerald-400" : "bg-red-400"
                    }`}
                  />
                  <span className="font-semibold text-sm truncate">{agent.displayName}</span>
                </div>
                <div className="text-xs text-slate-500 truncate mt-0.5">
                  {agent.hostname || agent.ip || "—"}
                </div>
              </button>
            ))}
            {!filteredAgents.length && !loadingAgents && (
              <div className="empty-state !py-8">
                <Server size={28} className="text-slate-700" />
                <p className="empty-state-hint">{t("logs.noAgents")}</p>
              </div>
            )}
          </div>
        </div>

        <div className="space-y-5">
          {/* Log file list */}
          <div className="card space-y-4">
            <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
              <div className="min-w-0">
                <h3 className="text-lg font-semibold text-white truncate">
                  {selectedAgent
                    ? t("logs.availableLogs", { name: selectedAgent.displayName })
                    : t("logs.selectAgent")}
                </h3>
                <p className="text-xs text-slate-500 mt-0.5">{t("logs.instructions")}</p>
                {logStats && (
                  <p className="text-xs text-slate-400 mt-2">
                    {t("logs.diskUsage", {
                      n: logStats.fileCount ?? 0,
                      size: formatBytes(logStats.totalBytes)
                    })}
                  </p>
                )}
              </div>
              <div className="flex flex-wrap gap-2 shrink-0">
                <button
                  className="btn btn-secondary"
                  onClick={fetchLogs}
                  disabled={!selectedAgent || loadingLogs}
                >
                  <RefreshCw size={15} className={loadingLogs ? "animate-spin" : ""} />
                  {loadingLogs ? t("logs.loadingLogs") : t("logs.loadLogs")}
                </button>
                <button
                  className="btn btn-danger"
                  onClick={() => setConfirmPrune(true)}
                  disabled={!selectedAgent || pruning}
                  title={t("logs.pruneHint")}
                >
                  <Trash2 size={15} />
                  {pruning ? t("logs.pruning") : t("logs.pruneNow")}
                </button>
              </div>
            </div>

            {loadingLogs && <p className="text-xs text-slate-500">{t("logs.waiting")}</p>}

            <div className="space-y-2">
              {logs.map((log) => (
                <div
                  key={log.name}
                  className="flex flex-col gap-3 rounded-xl border border-white/5 bg-white/[0.02] p-3 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="flex items-center gap-2.5 min-w-0">
                    <FileText size={15} className="text-slate-500 shrink-0" />
                    <div className="min-w-0">
                      <div className="font-mono text-sm text-slate-100 truncate">{log.name}</div>
                      <div className="text-xs text-slate-500">
                        {log.modifiedAt ? new Date(log.modifiedAt).toLocaleString(lang) : "—"}
                        {" · "}
                        {formatBytes(log.sizeBytes)}
                      </div>
                    </div>
                  </div>
                  <button
                    className="btn btn-secondary shrink-0"
                    onClick={() => fetchLogContent(log.name)}
                    disabled={loadingContent}
                  >
                    {t("logs.view")}
                  </button>
                </div>
              ))}
              {!logs.length && !loadingLogs && (
                <div className="empty-state">
                  <ClipboardList size={36} className="text-slate-700" />
                  <p className="empty-state-title">{t("logs.noLogs")}</p>
                  <p className="empty-state-hint">{t("logs.noLogsHint")}</p>
                </div>
              )}
            </div>
          </div>

          {/* Log content */}
          <div className="card space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h3 className="text-lg font-semibold text-white">{t("logs.content")}</h3>
              <div className="flex flex-wrap items-center gap-2">
                {logMeta?.truncated && (
                  <span className="badge badge-warn">{t("logs.truncated")}</span>
                )}
                <button
                  className="btn btn-secondary !px-3 !py-2"
                  onClick={() => setWrapLines((w) => !w)}
                  title={t("logs.toggleWrap")}
                  aria-pressed={wrapLines}
                >
                  <WrapText size={15} className={wrapLines ? "text-brand-400" : ""} />
                </button>
                <button
                  className="btn btn-secondary !px-3 !py-2"
                  onClick={scrollToBottom}
                  title={t("logs.jumpToEnd")}
                  disabled={!logContent}
                >
                  <ArrowDownToLine size={15} />
                </button>
                <button
                  className="btn btn-secondary !px-3 !py-2"
                  onClick={downloadLog}
                  title={t("logs.download")}
                  disabled={!logContent}
                >
                  <Download size={15} />
                </button>
              </div>
            </div>

            {logMeta && (
              <div className="text-xs text-slate-500 font-mono">
                {logMeta.name} · {formatBytes(logMeta.sizeBytes)} ·{" "}
                {t("logs.lineCount", { n: parsedLines.length })}
              </div>
            )}

            {logContent && (
              <div className="flex flex-col gap-3">
                <div className="relative">
                  <Search
                    className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-500"
                    size={15}
                  />
                  <input
                    className="input !pl-9 !pr-9"
                    placeholder={t("logs.searchInLog")}
                    value={contentFilter}
                    onChange={(e) => setContentFilter(e.target.value)}
                  />
                  {contentFilter && (
                    <button
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300"
                      onClick={() => setContentFilter("")}
                      aria-label={t("common.clear")}
                    >
                      <X size={15} />
                    </button>
                  )}
                </div>

                <div className="segmented">
                  {[
                    { id: "all", label: t("logs.levelAll") },
                    { id: "error", label: t("logs.levelError") },
                    { id: "warn", label: t("logs.levelWarn") },
                    { id: "success", label: t("logs.levelSuccess") },
                    { id: "info", label: t("logs.levelInfo") }
                  ].map((level) => (
                    <button
                      key={level.id}
                      onClick={() => setLevelFilter(level.id)}
                      className={`segmented-item flex-1 ${
                        levelFilter === level.id
                          ? "segmented-item-active"
                          : "segmented-item-inactive"
                      }`}
                    >
                      {level.label}
                      <span className="ml-1.5 tabular-nums opacity-70">
                        {levelCounts[level.id] ?? 0}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {loadingContent && <p className="text-sm text-slate-400">{t("logs.loadingContent")}</p>}
            {contentError && <p className="text-sm text-red-400">{contentError}</p>}

            {logContent ? (
              <div
                ref={contentRef}
                className="max-h-[500px] overflow-auto rounded-xl bg-black/40 border border-white/5 font-mono text-xs"
              >
                {visibleLines.length === 0 ? (
                  <p className="p-6 text-center text-slate-500">{t("logs.noMatchingLines")}</p>
                ) : (
                  visibleLines.map((line) => (
                    <div
                      key={line.number}
                      className={`flex gap-3 px-3 py-0.5 hover:bg-white/[0.03] ${
                        LEVEL_STYLES[line.level]
                      }`}
                    >
                      <span className="select-none text-slate-600 tabular-nums text-right w-10 shrink-0">
                        {line.number}
                      </span>
                      <span
                        className={
                          wrapLines
                            ? "whitespace-pre-wrap break-words min-w-0"
                            : "whitespace-pre min-w-0"
                        }
                      >
                        {line.text || " "}
                      </span>
                    </div>
                  ))
                )}
              </div>
            ) : (
              !loadingContent && (
                <div className="empty-state">
                  <FileText size={36} className="text-slate-700" />
                  <p className="empty-state-title">{t("logs.noContent")}</p>
                  <p className="empty-state-hint">{t("logs.noContentHint")}</p>
                </div>
              )
            )}
          </div>
        </div>
      </div>

      <ConfirmDialog
        open={confirmPrune}
        title={t("logs.pruneNow")}
        description={t("logs.pruneConfirm")}
        confirmLabel={t("logs.pruneNow")}
        loading={pruning}
        onClose={() => setConfirmPrune(false)}
        onConfirm={pruneNow}
      />
    </div>
  );
}
