import React, { useEffect, useState } from "react";
import { apiFetch } from "../lib/api.js";
import { useI18n } from "../lib/i18n.jsx";
import { LinuxIcon, AppleIcon, WindowsIcon } from "../components/OsIcons.jsx";

const PLATFORMS = [
  { id: "linux",   Icon: LinuxIcon,   color: "orange" },
  { id: "macos",   Icon: AppleIcon,   color: "slate"  },
  { id: "windows", Icon: WindowsIcon, color: "blue"   }
];

export default function NewAgent() {
  const { t } = useI18n();
  const [displayName, setDisplayName] = useState("");
  const [installMode, setInstallMode] = useState("local"); // "local" | "internet"
  const [customBaseUrl, setCustomBaseUrl] = useState("");
  const [osPlatform, setOsPlatform] = useState("linux"); // "linux" | "macos" | "windows"
  const [installBundle, setInstallBundle] = useState(null);
  const [agentId, setAgentId] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);

  // Pre-fill internet URL from the global setting saved in Admin
  useEffect(() => {
    apiFetch("/api/settings")
      .then((data) => {
        const saved = data?.settings?.internetBaseUrl;
        if (saved) setCustomBaseUrl(saved);
      })
      .catch(() => {});
  }, []);

  const onSubmit = async (event) => {
    event.preventDefault();
    setError("");
    setLoading(true);
    try {
      const body = { displayName };
      if (installMode === "internet") {
        const trimmed = customBaseUrl.trim().replace(/\/$/, "");
        if (!trimmed) {
          setError(t("newAgent.baseUrlRequired"));
          setLoading(false);
          return;
        }
        body.baseUrl = trimmed;
      }
      const data = await apiFetch("/api/agents", {
        method: "POST",
        body: JSON.stringify(body)
      });
      setInstallBundle({
        commands: data.installCommands || {},
        urls: data.installUrls || {}
      });
      setAgentId(data.agentId);
      setDisplayName("");
    } catch (err) {
      setError(err.message || t("errors.addAgent"));
    } finally {
      setLoading(false);
    }
  };

  const currentCommand = installBundle?.commands?.[osPlatform] || "";
  const currentUrl = installBundle?.urls?.[osPlatform] || "";

  const copyCommand = async () => {
    if (!currentCommand) return;
    await navigator.clipboard.writeText(currentCommand);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const platformColor = {
    linux:   "border-orange-500 bg-orange-500/15 text-orange-300",
    macos:   "border-slate-400 bg-slate-400/15 text-slate-200",
    windows: "border-blue-500 bg-blue-500/15 text-blue-300"
  };
  const platformColorInactive = "border-ink-600 bg-ink-800 text-slate-400 hover:border-ink-500 hover:text-slate-200";

  return (
    <div className="space-y-6">
      <div className="card">
        <h2 className="text-2xl font-semibold text-white">{t("newAgent.title")}</h2>
        <p className="text-sm text-slate-400">{t("newAgent.subtitle")}</p>
      </div>

      <div className="card space-y-5">
        {/* Network mode */}
        <div>
          <p className="mb-2 text-sm font-medium text-slate-300">{t("newAgent.modeLabel")}</p>
          <div className="flex gap-2">
            <button
              type="button"
              className={`flex-1 rounded-xl border px-4 py-3 text-sm font-medium transition-colors ${
                installMode === "local"
                  ? "border-blue-500 bg-blue-500/15 text-blue-300"
                  : platformColorInactive
              }`}
              onClick={() => setInstallMode("local")}
            >
              <div className="flex flex-col items-center gap-1">
                <span className="text-base">🏠</span>
                <span>{t("newAgent.modeLocal")}</span>
                <span className="text-xs opacity-70">{t("newAgent.modeLocalDesc")}</span>
              </div>
            </button>
            <button
              type="button"
              className={`flex-1 rounded-xl border px-4 py-3 text-sm font-medium transition-colors ${
                installMode === "internet"
                  ? "border-violet-500 bg-violet-500/15 text-violet-300"
                  : platformColorInactive
              }`}
              onClick={() => setInstallMode("internet")}
            >
              <div className="flex flex-col items-center gap-1">
                <span className="text-base">🌐</span>
                <span>{t("newAgent.modeInternet")}</span>
                <span className="text-xs opacity-70">{t("newAgent.modeInternetDesc")}</span>
              </div>
            </button>
          </div>
        </div>

        {/* Internet URL */}
        {installMode === "internet" ? (
          <div>
            <label className="mb-1.5 block text-sm font-medium text-slate-300">
              {t("newAgent.baseUrlLabel")}
            </label>
            <input
              className="input"
              placeholder={t("newAgent.baseUrlPlaceholder")}
              value={customBaseUrl}
              onChange={(e) => setCustomBaseUrl(e.target.value)}
              type="url"
            />
            <p className="mt-1.5 text-xs text-slate-500">{t("newAgent.baseUrlHint")}</p>
          </div>
        ) : (
          <div className="rounded-xl border border-blue-500/20 bg-blue-500/5 px-4 py-3 text-xs text-blue-300">
            {t("newAgent.modeLocalInfo")}
          </div>
        )}

        {/* OS Platform */}
        <div>
          <p className="mb-2 text-sm font-medium text-slate-300">{t("newAgent.platformLabel")}</p>
          <div className="flex gap-2">
            {PLATFORMS.map((p) => (
              <button
                key={p.id}
                type="button"
                className={`flex-1 rounded-xl border px-3 py-2.5 text-sm font-medium transition-colors ${
                  osPlatform === p.id ? platformColor[p.id] : platformColorInactive
                }`}
                onClick={() => setOsPlatform(p.id)}
              >
                <div className="flex flex-col items-center gap-1">
                  <p.Icon className="w-6 h-6" />
                  <span className="text-xs">{t(`newAgent.platform_${p.id}`)}</span>
                </div>
              </button>
            ))}
          </div>
        </div>

        <form onSubmit={onSubmit} className="space-y-4">
          <input
            className="input"
            placeholder={t("newAgent.displayName")}
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
          />
          {error ? <p className="text-sm text-red-400">{error}</p> : null}
          <button
            type="submit"
            className="btn btn-primary"
            disabled={loading || !displayName || (installMode === "internet" && !customBaseUrl.trim())}
          >
            {loading ? t("newAgent.creating") : t("newAgent.addAgent")}
          </button>
        </form>
      </div>

      {installBundle ? (
        <div className="card space-y-3">
          {/* Platform tabs in result card */}
          <div className="flex gap-1 rounded-lg bg-ink-800 p-1">
            {PLATFORMS.map((p) => (
              <button
                key={p.id}
                type="button"
                className={`flex flex-1 items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                  osPlatform === p.id
                    ? "bg-ink-600 text-white"
                    : "text-slate-400 hover:text-slate-200"
                }`}
                onClick={() => setOsPlatform(p.id)}
              >
                <p.Icon className="w-3.5 h-3.5 inline-block" /> {t(`newAgent.platform_${p.id}`)}
              </button>
            ))}
          </div>

          <div>
            <p className="mb-1 text-xs uppercase tracking-widest text-slate-500">{t("newAgent.agentId")}</p>
            <p className="font-mono text-sm text-slate-200">{agentId}</p>
          </div>

          <div>
            <p className="mb-1 text-xs uppercase tracking-widest text-slate-500">{t("newAgent.installCommand")}</p>
            {osPlatform === "windows" && (
              <p className="mb-2 text-xs text-amber-400">{t("newAgent.windowsAdminNote")}</p>
            )}
            <div className="rounded-xl bg-ink-800 p-4 text-sm text-slate-100">
              <code className="break-all font-mono">{currentCommand}</code>
            </div>
          </div>
          <div>
            <p className="mb-1 text-xs uppercase tracking-widest text-slate-500">{t("newAgent.scriptUrl")}</p>
            <div className="rounded-xl border border-ink-700 bg-ink-900/60 p-4 text-xs text-slate-300">
              <code className="break-all font-mono">{currentUrl}</code>
            </div>
            <p className="mt-2 text-xs text-slate-500">{t("newAgent.safeInstallHint")}</p>
          </div>
          <button className="btn btn-secondary" onClick={copyCommand}>
            {copied ? t("newAgent.copied") : t("newAgent.copyCommand")}
          </button>
        </div>
      ) : null}
    </div>
  );
}
