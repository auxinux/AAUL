import React, { useCallback, useEffect, useState } from "react";
import { ArrowUpCircle, RefreshCw } from "lucide-react";
import { useI18n } from "../lib/i18n.js";
import { APP_VERSION } from "../lib/appVersion.js";
import { CHANGELOG } from "../lib/changelog.js";
import { apiFetch } from "../lib/api.js";
import Modal from "./Modal.jsx";

export default function Footer() {
  const { t, lang } = useI18n();
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState(null);
  const [checking, setChecking] = useState(false);

  // Cached result only — the server never hits the network on this call, so it
  // is safe to ask for it on every mount.
  const loadStatus = useCallback(async () => {
    try {
      const data = await apiFetch("/api/admin/update-check");
      setStatus(data.status || null);
    } catch {
      // Non-admins get a 403 here. The footer simply shows no badge.
      setStatus(null);
    }
  }, []);

  useEffect(() => {
    loadStatus();
  }, [loadStatus]);

  // The server announces a newly published version over SSE, so an open tab
  // learns about it without waiting for a reload.
  useEffect(() => {
    let source;
    try {
      source = new EventSource("/api/events");
      source.addEventListener("update:available", () => loadStatus());
    } catch {
      return undefined;
    }
    return () => {
      if (source) source.close();
    };
  }, [loadStatus]);

  const checkNow = async () => {
    setChecking(true);
    try {
      const data = await apiFetch("/api/admin/update-check", { method: "POST" });
      setStatus(data.status || null);
    } catch (err) {
      setStatus((previous) => ({
        ...(previous || {}),
        ok: false,
        error: err.message || t("errors.loadFailed"),
        checkedAt: new Date().toISOString()
      }));
    } finally {
      setChecking(false);
    }
  };

  const updateAvailable = Boolean(status?.updateAvailable && status?.latest?.dashboard);
  const latest = status?.latest?.dashboard;

  return (
    <footer className="mt-8 text-center text-xs text-slate-500 safe-bottom">
      <div className="flex items-center justify-center gap-2 flex-wrap">
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="rounded transition hover:text-ocean-300 hover:underline focus:outline-none focus-visible:ring-1 focus-visible:ring-ocean-400"
          title={t("updates.openNotes")}
        >
          {t("footer.version", { version: APP_VERSION })}
        </button>

        {/* Discreet but unmissable: shown only when there is something to do. */}
        {updateAvailable && (
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="badge badge-warn !py-0.5 hover:bg-amber-500/25 transition-colors"
            title={t("updates.availableTitle", { version: latest })}
          >
            <ArrowUpCircle size={11} />
            {latest}
          </button>
        )}
      </div>
      <div>{t("footer.by")}</div>

      <Modal open={open} title={t("updates.notesTitle")} size="2xl" onClose={() => setOpen(false)}>
        <div className="space-y-4 text-left">
          {/* Banner: what to do, and the exact command to do it. */}
          {updateAvailable && (
            <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 space-y-2">
              <div className="flex items-center gap-2 text-sm font-semibold text-amber-300">
                <ArrowUpCircle size={16} />
                {t("updates.availableTitle", { version: latest })}
              </div>
              <p className="text-xs text-slate-300">
                {t("updates.availableBody", {
                  current: status?.current?.dashboard || APP_VERSION,
                  latest
                })}
              </p>
              {status?.latest?.agent && (
                <p className="text-xs text-slate-400">
                  {t("updates.agentLine", { version: status.latest.agent })}
                </p>
              )}
              <pre className="rounded-lg bg-black/40 border border-white/5 px-3 py-2 text-[11px] font-mono text-slate-300 overflow-x-auto">
                cd ~/AAUL &amp;&amp; git pull &amp;&amp; ./install.sh
              </pre>
            </div>
          )}

          {/* Check controls */}
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-white/5 bg-white/[0.02] px-4 py-3">
            <div className="min-w-0 text-xs">
              {status?.checkedAt ? (
                <span className="text-slate-400">
                  {t("updates.lastChecked", {
                    time: new Date(status.checkedAt).toLocaleString(lang)
                  })}
                </span>
              ) : (
                <span className="text-slate-500">{t("updates.neverChecked")}</span>
              )}
              {status && !status.ok && status.error ? (
                <div className="text-red-400 mt-1">
                  {t("updates.checkFailed", { error: status.error })}
                </div>
              ) : null}
              {status?.ok && !updateAvailable ? (
                <div className="text-emerald-400 mt-1">{t("updates.upToDate")}</div>
              ) : null}
              {status?.disabled ? (
                <div className="text-slate-500 mt-1">{t("updates.disabled")}</div>
              ) : null}
            </div>
            <button
              type="button"
              className="btn btn-secondary text-xs shrink-0"
              onClick={checkNow}
              disabled={checking}
            >
              <RefreshCw size={14} className={checking ? "animate-spin" : ""} />
              {checking ? t("updates.checking") : t("updates.checkNow")}
            </button>
          </div>

          <div className="max-h-[50vh] space-y-5 overflow-y-auto pr-1">
            {CHANGELOG.map((entry) => {
              const isCurrent = entry.version === APP_VERSION;
              return (
                <div
                  key={entry.version}
                  className="border-b border-ink-700/60 pb-4 last:border-0 last:pb-0"
                >
                  <div className="flex items-baseline gap-3 flex-wrap">
                    <span className="text-sm font-semibold text-white">v{entry.version}</span>
                    {isCurrent ? (
                      <span className="badge badge-ok !px-2 !py-0.5 text-[10px]">
                        {t("updates.current")}
                      </span>
                    ) : null}
                    {entry.version === latest && !isCurrent ? (
                      <span className="badge badge-warn !px-2 !py-0.5 text-[10px]">
                        {t("updates.published")}
                      </span>
                    ) : null}
                    {entry.date ? (
                      <span className="text-[11px] text-slate-500">{entry.date}</span>
                    ) : null}
                  </div>
                  {entry.title ? (
                    <div className="mt-1 text-xs font-medium text-ocean-300/90">{entry.title}</div>
                  ) : null}
                  <ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-slate-300">
                    {entry.changes.map((change, idx) => (
                      <li key={idx}>{change}</li>
                    ))}
                  </ul>
                </div>
              );
            })}
          </div>
        </div>
      </Modal>
    </footer>
  );
}
