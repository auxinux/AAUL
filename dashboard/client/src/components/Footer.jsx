import React, { useState } from "react";
import { useI18n } from "../lib/i18n.js";
import { APP_VERSION } from "../lib/appVersion.js";
import { CHANGELOG } from "../lib/changelog.js";
import Modal from "./Modal.jsx";

export default function Footer() {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);

  return (
    <footer className="mt-8 text-center text-xs text-slate-500">
      <div>
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="rounded transition hover:text-ocean-300 hover:underline focus:outline-none focus-visible:ring-1 focus-visible:ring-ocean-400"
          title="Voir les notes de version"
        >
          {t("footer.version", { version: APP_VERSION })}
        </button>
      </div>
      <div>{t("footer.by")}</div>

      <Modal open={open} title="Notes de version" size="2xl" onClose={() => setOpen(false)}>
        <div className="max-h-[60vh] space-y-5 overflow-y-auto pr-1 text-left">
          {CHANGELOG.map((entry) => {
            const isCurrent = entry.version === APP_VERSION;
            return (
              <div key={entry.version} className="border-b border-ink-700/60 pb-4 last:border-0 last:pb-0">
                <div className="flex items-baseline gap-3">
                  <span className="text-sm font-semibold text-white">v{entry.version}</span>
                  {isCurrent ? (
                    <span className="badge bg-emerald-500/20 px-2 py-0.5 text-[10px] text-emerald-300">
                      actuelle
                    </span>
                  ) : null}
                  {entry.date ? <span className="text-[11px] text-slate-500">{entry.date}</span> : null}
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
      </Modal>
    </footer>
  );
}
