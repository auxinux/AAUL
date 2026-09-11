// Operator view for dashboard host configuration: combines network settings
// stored in the database with server-level settings stored on disk.

import React, { useEffect, useMemo, useState } from "react";
import { 
  Shield, 
  Globe, 
  Clock, 
  Monitor, 
  Activity, 
  ChevronDown, 
  ChevronRight,
  RefreshCw,
  Save,
  Network,
  Bell,
  Settings,
  AlertCircle,
  History,
  Lock,
  Zap,
  Server,
  Mail,
  Smartphone,
  CheckCircle2,
  XCircle,
  Info
} from "lucide-react";
import { apiFetch } from "../lib/api.js";
import { useI18n } from "../lib/i18n.js";
import Modal from "../components/Modal.jsx";
import ConfirmDialog from "../components/ConfirmDialog.jsx";

// Mirrors MIN/MAX_AGENT_POLL_SECONDS in dashboard/server/config.js — the
// server rejects anything outside this range, this only spares the round trip.
const MIN_POLL_SECONDS = 5;
const MAX_POLL_SECONDS = 86400;

function formatDate(value) {
  if (!value) return "-";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

// Server Management Component - HTTP/HTTPS Configuration
function ServerManagement({ t }) {
  const [restarting, setRestarting] = useState(false);
  const [restartConfirmOpen, setRestartConfirmOpen] = useState(false);
  const [serverExpanded, setServerExpanded] = useState(true);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [sslStatus, setSslStatus] = useState({ keyExists: false, certExists: false });
  
  const [config, setConfig] = useState({
    http: { enabled: true, apiPort: 3001, webPort: 5173 },
    https: { enabled: false, apiPort: 3002, webPort: 5174 },
    defaultApiProtocol: "http"
  });

  const loadConfig = async () => {
    setLoading(true);
    try {
      const [configRes, sslRes] = await Promise.all([
        apiFetch("/api/admin/config"),
        apiFetch("/api/admin/config/ssl-status")
      ]);
      if (configRes.ok) setConfig(configRes.config);
      if (sslRes.ok) setSslStatus(sslRes);
    } catch (err) {
      console.error("Failed to load config:", err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadConfig(); }, []);

  const handleRestart = async () => {
    setRestartConfirmOpen(false);
    setRestarting(true);
    try {
      await apiFetch("/api/admin/restart", { method: "POST" });
      setTimeout(() => window.location.reload(), 3000);
    } catch (err) {
      setRestarting(false);
    }
  };

  const saveConfig = async () => {
    setSaving(true);
    setMessage("");
    if (!config.http.enabled && !config.https.enabled) {
      setMessage("Error: At least one protocol must be enabled");
      setSaving(false);
      return;
    }
    if (config.https.enabled && (!sslStatus.keyExists || !sslStatus.certExists)) {
      setMessage("Error: SSL certificates not found.");
      setSaving(false);
      return;
    }
    try {
      const res = await apiFetch("/api/admin/config/server", {
        method: "POST",
        body: JSON.stringify(config)
      });
      setMessage(res.message || "Configuration saved!");
    } catch (err) {
      setMessage("Error: " + (err.message || "Failed to save"));
    } finally {
      setSaving(false);
    }
  };

  const updateHttp = (key, value) => setConfig(prev => ({ ...prev, http: { ...prev.http, [key]: value } }));
  const updateHttps = (key, value) => setConfig(prev => ({ ...prev, https: { ...prev.https, [key]: value } }));

  if (loading) return <div className="card animate-pulse py-12 flex justify-center"><RefreshCw className="animate-spin text-brand-500" /></div>;

  return (
    <div className="card !p-0 overflow-hidden">
      <button className="flex w-full items-center justify-between p-8 text-left hover:bg-white/[0.02] transition-colors" onClick={() => setServerExpanded(!serverExpanded)}>
        <div className="flex items-center gap-3 text-brand-400">
           <Settings size={20} />
           <h3 className="text-lg font-bold text-white tracking-tight">Server Management</h3>
        </div>
        <div className="p-2 rounded-lg bg-white/5 text-slate-500">
           {serverExpanded ? <ChevronDown size={18} /> : <ChevronRight size={18} />}
        </div>
      </button>
      
      {serverExpanded && (
        <div className="p-8 pt-4 space-y-8 border-t border-white/5 bg-black/10">
          <div className="grid gap-6 md:grid-cols-2">
            {/* HTTP */}
            <div className="card !bg-white/[0.02] !p-6 space-y-6">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3 text-brand-400">
                   <Server size={18} />
                   <h4 className="text-sm font-bold uppercase tracking-widest text-slate-200">HTTP Protocol</h4>
                </div>
                <label className="flex items-center gap-3 cursor-pointer group">
                  <div className="relative">
                    <input type="checkbox" checked={config.http.enabled} disabled={!config.https.enabled} onChange={(e) => updateHttp("enabled", e.target.checked)} className="peer sr-only" />
                    <div className="w-10 h-6 bg-slate-800 rounded-full peer-checked:bg-emerald-500/20 transition-colors" />
                    <div className="absolute left-1 top-1 w-4 h-4 bg-slate-500 rounded-full transition-all peer-checked:left-5 peer-checked:bg-emerald-400" />
                  </div>
                </label>
              </div>
              {config.http.enabled && (
                <div className="space-y-4 animate-fade-in">
                  <div className="space-y-2">
                    <label className="text-[10px] font-bold uppercase tracking-widest text-slate-500">API Port</label>
                    <input type="number" className="input !py-2" value={config.http.apiPort} onChange={(e) => updateHttp("apiPort", parseInt(e.target.value) || 3001)} />
                  </div>
                </div>
              )}
            </div>

            {/* HTTPS */}
            <div className="card !bg-white/[0.02] !p-6 space-y-6">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3 text-emerald-400">
                   <Lock size={18} />
                   <h4 className="text-sm font-bold uppercase tracking-widest text-slate-200">HTTPS Protocol</h4>
                </div>
                <label className="flex items-center gap-3 cursor-pointer group">
                  <div className="relative">
                    <input type="checkbox" checked={config.https.enabled} disabled={!config.http.enabled && !sslStatus.keyExists} onChange={(e) => updateHttps("enabled", e.target.checked)} className="peer sr-only" />
                    <div className="w-10 h-6 bg-slate-800 rounded-full peer-checked:bg-emerald-500/20 transition-colors" />
                    <div className="absolute left-1 top-1 w-4 h-4 bg-slate-500 rounded-full transition-all peer-checked:left-5 peer-checked:bg-emerald-400" />
                  </div>
                </label>
              </div>
              
              <div className="flex gap-4">
                 <span className={`flex items-center gap-1.5 px-2 py-1 rounded bg-black/40 text-[10px] font-bold uppercase tracking-widest border ${sslStatus.keyExists ? "text-emerald-400 border-emerald-500/20" : "text-red-400 border-red-500/20"}`}>
                   {sslStatus.keyExists ? <CheckCircle2 size={10} /> : <XCircle size={10} />} server.key
                 </span>
                 <span className={`flex items-center gap-1.5 px-2 py-1 rounded bg-black/40 text-[10px] font-bold uppercase tracking-widest border ${sslStatus.certExists ? "text-emerald-400 border-emerald-500/20" : "text-red-400 border-red-500/20"}`}>
                   {sslStatus.certExists ? <CheckCircle2 size={10} /> : <XCircle size={10} />} server.crt
                 </span>
              </div>
              
              {config.https.enabled && sslStatus.keyExists && (
                <div className="space-y-4 animate-fade-in">
                   <div className="space-y-2">
                    <label className="text-[10px] font-bold uppercase tracking-widest text-slate-500">API Port</label>
                    <input type="number" className="input !py-2" value={config.https.apiPort} onChange={(e) => updateHttps("apiPort", parseInt(e.target.value) || 3002)} />
                  </div>
                </div>
              )}
            </div>
          </div>

          <div className="flex flex-wrap gap-4 pt-4 border-t border-white/5">
            <button className="btn btn-primary !px-8" onClick={saveConfig} disabled={saving}><Save size={16} /> Save Server Config</button>
            <button className="btn btn-secondary !px-8" onClick={() => setRestartConfirmOpen(true)} disabled={restarting}><RefreshCw size={16} className={restarting ? 'animate-spin' : ''} /> Restart Dashboard</button>
          </div>
          {message && <p className={`text-xs font-bold uppercase tracking-widest ${message.startsWith("Error") ? "text-red-400" : "text-emerald-400"}`}>{message}</p>}
        </div>
      )}

      <ConfirmDialog open={restartConfirmOpen} title="Restart Dashboard Server" description="Are you sure? The interface will be unavailable for a few seconds." tone="danger" onClose={() => setRestartConfirmOpen(false)} onConfirm={handleRestart} />
    </div>
  );
}

// Monitoring & Notifications Component
function MonitoringAlerts() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState("");
  const [message, setMessage] = useState("");
  const [expanded, setExpanded] = useState(false);

  const [monitoring, setMonitoring] = useState({ enabled: true, thresholdSeconds: 120 });
  const [email, setEmail] = useState({ enabled: false, host: "", port: 587, secure: false, user: "", pass: "", passSet: false, from: "", to: "" });
  const [sms, setSms] = useState({ enabled: false, accountSid: "", authToken: "", authTokenSet: false, from: "", to: "" });
  const [types, setTypes] = useState({
    deviceDown:      { enabled: true,  email: true,  sms: false, repeatMinutes: 60 },
    deviceUp:        { enabled: true,  email: true,  sms: false },
    updateAvailable: { enabled: false, email: true,  sms: false },
    other:           { enabled: false, email: true,  sms: false }
  });

  const TYPE_LABELS = {
    deviceDown: "Device Offline (Down)",
    deviceUp: "Back Online (Recovery)",
    updateAvailable: "Updates Available",
    other: "Other Alerts"
  };

  const setType = (key, field, value) => setTypes((prev) => ({ ...prev, [key]: { ...prev[key], [field]: value } }));

  const load = async () => {
    setLoading(true);
    try {
      const res = await apiFetch("/api/notifications");
      if (res.ok) {
        setMonitoring(res.monitoring);
        setEmail({ ...res.notifications.email, pass: "" });
        setSms({ ...res.notifications.sms, authToken: "" });
        if (res.notifications.types) setTypes(res.notifications.types);
      }
    } catch (err) {
      setMessage("Error: " + (err.message || ""));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const getValidationError = () => {
    if (email.enabled) {
      const port = Number.parseInt(email.port, 10);
      if (!email.host.trim()) return "SMTP host is required.";
      if (!Number.isFinite(port) || port < 1 || port > 65535) return "SMTP port must be between 1 and 65535.";
      if (!(email.from || email.user).trim()) return "Email sender address is required.";
      if (!email.to.trim()) return "At least one email recipient is required.";
      if (email.user.trim() && !email.pass && !email.passSet) return "SMTP password is required.";
    }
    if (sms.enabled) {
      if (!sms.accountSid.trim().startsWith("AC")) return "Twilio Account SID must start with AC.";
      if (!sms.authToken && !sms.authTokenSet) return "Twilio Auth Token is required.";
      if (!sms.from.trim()) return "Twilio sender number is required.";
      if (!sms.to.trim()) return "At least one SMS recipient is required.";
    }
    return "";
  };

  const buildPayload = () => {
    const emailPayload = { ...email }; if (!email.pass) delete emailPayload.pass;
    const smsPayload = { ...sms }; if (!sms.authToken) delete smsPayload.authToken;
    return { monitoring, notifications: { email: emailPayload, sms: smsPayload, types } };
  };

  const persist = async () => apiFetch("/api/notifications", {
    method: "POST",
    body: JSON.stringify(buildPayload())
  });

  const save = async () => {
    const validationError = getValidationError();
    if (validationError) {
      setMessage(`Error: ${validationError}`);
      return;
    }
    setSaving(true); setMessage("");
    try {
      const res = await persist();
      setMessage(res.message || "Saved.");
      await load();
    } catch (err) {
      setMessage(`Error: ${err.message || "Failed to save notification settings."}`);
    } finally { setSaving(false); }
  };

  const runTest = async (channel) => {
    const validationError = getValidationError();
    if (validationError) {
      setMessage(`Error: ${validationError}`);
      return;
    }
    setTesting(channel);
    setMessage("");
    try {
      await persist();
      await apiFetch("/api/notifications/test", { method: "POST", body: JSON.stringify({ channel }) });
      setMessage(`Test Result: ${channel} test sent successfully.`);
      await load();
    } catch (err) {
      setMessage(`Error: ${err.message || `${channel} test failed.`}`);
    } finally {
      setTesting("");
    }
  };

  return (
    <div className="card !p-0 overflow-hidden">
      <button className="flex w-full items-center justify-between p-8 text-left hover:bg-white/[0.02] transition-colors" onClick={() => setExpanded(!expanded)}>
        <div className="flex items-center gap-3 text-emerald-400">
           <Bell size={20} />
           <h3 className="text-lg font-bold text-white tracking-tight">Monitoring & Notifications</h3>
        </div>
        <div className="p-2 rounded-lg bg-white/5 text-slate-500">
           {expanded ? <ChevronDown size={18} /> : <ChevronRight size={18} />}
        </div>
      </button>

      {expanded && (
        <div className="p-8 pt-4 space-y-8 border-t border-white/5 bg-black/10">
          <div className="grid gap-6 md:grid-cols-2">
             {/* Threshold */}
             <div className="card !bg-white/[0.02] !p-6 space-y-6">
                <div className="flex items-center justify-between">
                   <div className="flex items-center gap-3 text-brand-400">
                      <Activity size={18} />
                      <h4 className="text-sm font-bold uppercase tracking-widest text-slate-200">Device Monitoring</h4>
                   </div>
                   <label className="flex items-center gap-3 cursor-pointer">
                      <div className="relative">
                        <input type="checkbox" checked={monitoring.enabled} onChange={(e) => setMonitoring(m => ({...m, enabled: e.target.checked}))} className="peer sr-only" />
                        <div className="w-10 h-6 bg-slate-800 rounded-full peer-checked:bg-emerald-500/20 transition-colors" />
                        <div className="absolute left-1 top-1 w-4 h-4 bg-slate-500 rounded-full transition-all peer-checked:left-5 peer-checked:bg-emerald-400" />
                      </div>
                   </label>
                </div>
                <div className="space-y-2">
                   <label className="text-[10px] font-bold uppercase tracking-widest text-slate-500">Offline Threshold (seconds)</label>
                   <input type="number" className="input" value={monitoring.thresholdSeconds} onChange={(e) => setMonitoring(m => ({...m, thresholdSeconds: parseInt(e.target.value) || 120}))} />
                </div>
             </div>

             {/* Channels */}
             <div className="card !bg-white/[0.02] !p-6 space-y-6">
                <h4 className="text-sm font-bold uppercase tracking-widest text-slate-200">Alert Channels</h4>
                <div className="flex flex-col gap-4">
                   <label className="flex items-center justify-between p-3 rounded-xl bg-black/20 border border-white/5 cursor-pointer">
                      <div className="flex items-center gap-3">
                         <Mail size={16} className="text-brand-400" />
                         <span className="text-sm font-bold text-slate-300">Email Alerts</span>
                      </div>
                      <input type="checkbox" checked={email.enabled} onChange={(e) => setEmail(s => ({...s, enabled: e.target.checked}))} className="w-4 h-4 rounded border-white/10 bg-black/40 text-brand-500" />
                   </label>
                   <label className="flex items-center justify-between p-3 rounded-xl bg-black/20 border border-white/5 cursor-pointer">
                      <div className="flex items-center gap-3">
                         <Smartphone size={16} className="text-emerald-400" />
                         <span className="text-sm font-bold text-slate-300">SMS Alerts (Twilio)</span>
                      </div>
                      <input type="checkbox" checked={sms.enabled} onChange={(e) => setSms(s => ({...s, enabled: e.target.checked}))} className="w-4 h-4 rounded border-white/10 bg-black/40 text-brand-500" />
                   </label>
                </div>
             </div>
          </div>

          {email.enabled && (
            <div className="card !bg-white/[0.02] !p-6 space-y-6 animate-fade-in">
              <div className="flex items-center gap-3 border-b border-white/5 pb-4">
                <Mail size={18} className="text-brand-400" />
                <div>
                  <h4 className="text-sm font-bold uppercase tracking-widest text-slate-200">SMTP Configuration</h4>
                  <p className="mt-1 text-xs text-slate-500">Credentials are encrypted before being stored.</p>
                </div>
              </div>
              <div className="grid gap-5 md:grid-cols-2">
                <div className="space-y-2">
                  <label className="text-[10px] font-bold uppercase tracking-widest text-slate-500">SMTP Host</label>
                  <input className="input" placeholder="smtp.example.com" value={email.host} onChange={(e) => setEmail(s => ({ ...s, host: e.target.value }))} />
                </div>
                <div className="grid grid-cols-[1fr_auto] gap-3">
                  <div className="space-y-2">
                    <label className="text-[10px] font-bold uppercase tracking-widest text-slate-500">Port</label>
                    <input className="input" type="number" min="1" max="65535" value={email.port} onChange={(e) => setEmail(s => ({ ...s, port: e.target.value }))} />
                  </div>
                  <label className="mt-7 flex items-center gap-2 rounded-xl border border-white/5 bg-black/20 px-4 text-xs font-semibold text-slate-300 cursor-pointer">
                    <input type="checkbox" checked={email.secure} onChange={(e) => setEmail(s => ({ ...s, secure: e.target.checked }))} />
                    Direct TLS
                  </label>
                </div>
                <div className="space-y-2">
                  <label className="text-[10px] font-bold uppercase tracking-widest text-slate-500">Username</label>
                  <input className="input" autoComplete="username" placeholder="alerts@example.com" value={email.user} onChange={(e) => setEmail(s => ({ ...s, user: e.target.value }))} />
                </div>
                <div className="space-y-2">
                  <label className="text-[10px] font-bold uppercase tracking-widest text-slate-500">Password</label>
                  <input className="input" type="password" autoComplete="new-password" placeholder={email.passSet ? "Configured — leave blank to keep" : "SMTP password"} value={email.pass} onChange={(e) => setEmail(s => ({ ...s, pass: e.target.value }))} />
                  {email.passSet && !email.pass && <p className="text-[10px] font-semibold text-emerald-400">Stored password will be preserved.</p>}
                </div>
                <div className="space-y-2">
                  <label className="text-[10px] font-bold uppercase tracking-widest text-slate-500">From Address</label>
                  <input className="input" type="email" placeholder="alerts@example.com" value={email.from} onChange={(e) => setEmail(s => ({ ...s, from: e.target.value }))} />
                </div>
                <div className="space-y-2">
                  <label className="text-[10px] font-bold uppercase tracking-widest text-slate-500">Recipients</label>
                  <input className="input" placeholder="admin@example.com, ops@example.com" value={email.to} onChange={(e) => setEmail(s => ({ ...s, to: e.target.value }))} />
                  <p className="text-[10px] text-slate-600">Separate multiple addresses with commas.</p>
                </div>
              </div>
            </div>
          )}

          {sms.enabled && (
            <div className="card !bg-white/[0.02] !p-6 space-y-6 animate-fade-in">
              <div className="flex items-center gap-3 border-b border-white/5 pb-4">
                <Smartphone size={18} className="text-emerald-400" />
                <div>
                  <h4 className="text-sm font-bold uppercase tracking-widest text-slate-200">Twilio SMS Configuration</h4>
                  <p className="mt-1 text-xs text-slate-500">Use the Account SID and Auth Token from the Twilio Console.</p>
                </div>
              </div>
              <div className="grid gap-5 md:grid-cols-2">
                <div className="space-y-2">
                  <label className="text-[10px] font-bold uppercase tracking-widest text-slate-500">Account SID</label>
                  <input className="input font-mono" placeholder="ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" value={sms.accountSid} onChange={(e) => setSms(s => ({ ...s, accountSid: e.target.value }))} />
                </div>
                <div className="space-y-2">
                  <label className="text-[10px] font-bold uppercase tracking-widest text-slate-500">Auth Token</label>
                  <input className="input" type="password" autoComplete="new-password" placeholder={sms.authTokenSet ? "Configured — leave blank to keep" : "Twilio Auth Token"} value={sms.authToken} onChange={(e) => setSms(s => ({ ...s, authToken: e.target.value }))} />
                  {sms.authTokenSet && !sms.authToken && <p className="text-[10px] font-semibold text-emerald-400">Stored token will be preserved.</p>}
                </div>
                <div className="space-y-2">
                  <label className="text-[10px] font-bold uppercase tracking-widest text-slate-500">Twilio Sender Number</label>
                  <input className="input font-mono" type="tel" placeholder="+15551234567" value={sms.from} onChange={(e) => setSms(s => ({ ...s, from: e.target.value }))} />
                </div>
                <div className="space-y-2">
                  <label className="text-[10px] font-bold uppercase tracking-widest text-slate-500">SMS Recipients</label>
                  <input className="input font-mono" placeholder="+15145551234, +14165551234" value={sms.to} onChange={(e) => setSms(s => ({ ...s, to: e.target.value }))} />
                  <p className="text-[10px] text-slate-600">Use E.164 numbers and separate recipients with commas.</p>
                </div>
              </div>
            </div>
          )}

          <div className="card !bg-white/[0.02] !p-6 space-y-5">
            <div>
              <h4 className="text-sm font-bold uppercase tracking-widest text-slate-200">Alert Routing</h4>
              <p className="mt-1 text-xs text-slate-500">Choose which events use each configured channel.</p>
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              {Object.entries(TYPE_LABELS).map(([key, label]) => (
                <div key={key} className="rounded-xl border border-white/5 bg-black/20 p-4 space-y-3">
                  <label className="flex items-center justify-between gap-3 cursor-pointer">
                    <span className="text-sm font-semibold text-slate-300">{label}</span>
                    <input type="checkbox" checked={types[key].enabled} onChange={(e) => setType(key, "enabled", e.target.checked)} />
                  </label>
                  <div className="flex flex-wrap items-center gap-4 text-xs text-slate-400">
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input type="checkbox" disabled={!email.enabled || !types[key].enabled} checked={types[key].email} onChange={(e) => setType(key, "email", e.target.checked)} />
                      Email
                    </label>
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input type="checkbox" disabled={!sms.enabled || !types[key].enabled} checked={types[key].sms} onChange={(e) => setType(key, "sms", e.target.checked)} />
                      SMS
                    </label>
                    {key === "deviceDown" && (
                      <label className="ml-auto flex items-center gap-2">
                        Repeat
                        <input className="input !w-20 !px-2 !py-1 text-xs" type="number" min="0" value={types[key].repeatMinutes ?? 0} onChange={(e) => setType(key, "repeatMinutes", Number.parseInt(e.target.value, 10) || 0)} />
                        min
                      </label>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="flex flex-wrap gap-4">
             <button className="btn btn-primary !px-8" onClick={save} disabled={saving}><Save size={16} /> Save Settings</button>
             {email.enabled && <button className="btn btn-secondary text-xs" onClick={() => runTest("email")} disabled={testing === "email"}><Mail size={14} /> Test Email</button>}
             {sms.enabled && <button className="btn btn-secondary text-xs" onClick={() => runTest("sms")} disabled={testing === "sms"}><Smartphone size={14} /> Test SMS</button>}
          </div>
          {message && <p className={`text-xs font-bold uppercase tracking-widest ${message.startsWith("Error") ? "text-red-400" : "text-emerald-400"}`}>{message}</p>}
        </div>
      )}
    </div>
  );
}

// Main Admin Page
export default function Admin() {
  const { t } = useI18n();
  const [ips, setIps] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  
  const [publicIp, setPublicIp] = useState("");
  const [internetBaseUrl, setInternetBaseUrl] = useState("");
  const [defaultPollSeconds, setDefaultPollSeconds] = useState("15");
  const [metricsRetentionDays, setMetricsRetentionDays] = useState("30");
  const [updateCheckEnabled, setUpdateCheckEnabled] = useState(true);
  const [antivirusMonitoringEnabled, setAntivirusMonitoringEnabled] = useState(true);
  const [updateCheckIntervalMinutes, setUpdateCheckIntervalMinutes] = useState("30");
  const [updateReleaseUrl, setUpdateReleaseUrl] = useState("");
  const [serverConfig, setServerConfig] = useState({
    http: { enabled: true, apiPort: 3001, webPort: 5173 },
    https: { enabled: false, apiPort: 3002, webPort: 5174 },
    defaultApiProtocol: "http"
  });
  
  const [agentWebExpanded, setAgentWebExpanded] = useState(false);

  const baseUrl = useMemo(() => {
    const ip = publicIp?.trim(); if (!ip) return "";
    let protocol = serverConfig.https?.enabled ? "https" : "http";
    const port = protocol === "https" ? (serverConfig.https?.apiPort || 3002) : (serverConfig.http?.apiPort || 3001);
    return `${protocol}://${ip}:${port}`;
  }, [publicIp, serverConfig]);

  const load = async () => {
    setLoading(true);
    try {
      const [settingsRes, ipsRes, serverRes] = await Promise.all([
        apiFetch("/api/settings"),
        apiFetch("/api/admin/network-ips"),
        apiFetch("/api/admin/config")
      ]);
      const settings = settingsRes.settings || {};
      setPublicIp(settings.publicIp || "");
      setInternetBaseUrl(settings.internetBaseUrl || "");
      setDefaultPollSeconds(settings.defaultPollSeconds || "15");
      setMetricsRetentionDays(settings.metricsRetentionDays || "30");
      setUpdateCheckEnabled(settings.updateCheckEnabled !== false);
      setAntivirusMonitoringEnabled(settings.antivirusMonitoringEnabled !== false);
      setUpdateCheckIntervalMinutes(settings.updateCheckIntervalMinutes || "30");
      setUpdateReleaseUrl(settings.updateReleaseUrl || "");
      if (serverRes.ok && serverRes.config) setServerConfig(serverRes.config);
      setIps(ipsRes.ips || []);
    } catch (err) {
      setError(err.message || "Failed to load");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const save = async () => {
    const pollValue = Number.parseInt(defaultPollSeconds, 10);
    if (!Number.isFinite(pollValue) || pollValue < MIN_POLL_SECONDS || pollValue > MAX_POLL_SECONDS) {
      setError(t("admin.pollTooShort"));
      return;
    }
    setSaving(true); setError(""); setMessage("");
    try {
      await apiFetch("/api/settings", {
        method: "POST",
        body: JSON.stringify({
          publicIp,
          internetBaseUrl,
          defaultPollSeconds,
          metricsRetentionDays,
          updateCheckEnabled,
          antivirusMonitoringEnabled,
          updateCheckIntervalMinutes,
          updateReleaseUrl
        })
      });
      setMessage("Settings updated successfully.");
    } catch (err) {
      setError("Failed to update.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-8 animate-fade-in">
      <div className="card !p-8">
        <div className="flex flex-col gap-4">
           <div className="flex items-center gap-3 text-brand-400">
              <Shield size={24} />
              <h2 className="page-title">{t("admin.title")}</h2>
           </div>
           <p className="page-subtitle max-w-2xl">{t("admin.subtitle")}</p>
        </div>
      </div>

      <div className="card !p-8 space-y-8">
        <div className="flex items-center justify-between border-b border-white/5 pb-4">
          <h3 className="text-lg font-bold text-white tracking-tight flex items-center gap-3">
            <Globe size={20} className="text-brand-400" />
            Network Configuration
          </h3>
        </div>
        
        <div className="grid gap-8 md:grid-cols-2">
          <div className="space-y-3">
            <label className="text-[10px] font-bold uppercase tracking-[0.2em] text-slate-500 ml-1">Network Interface IP</label>
            <div className="relative">
               <Network className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-500" size={16} />
               <select className="input !pl-12" value={publicIp} onChange={(e) => setPublicIp(e.target.value)}>
                 <option value="">Select IP Interface</option>
                 {ips.map((ip) => <option key={`${ip.name}-${ip.address}`} value={ip.address}>{ip.address} ({ip.name})</option>)}
               </select>
            </div>
          </div>

          <div className="space-y-3">
            <label className="text-[10px] font-bold uppercase tracking-[0.2em] text-slate-500 ml-1">
              {t("admin.internetBaseUrl")}
            </label>
            <div className="relative group">
              <Globe className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-500" size={16} />
              {/* Placeholder stays a generic example on purpose: this is where an
                  admin types THEIR OWN public URL, not the project's. */}
              <input
                className="input !pl-12"
                type="url"
                placeholder={t("admin.internetBaseUrlPlaceholder")}
                value={internetBaseUrl}
                onChange={(e) => setInternetBaseUrl(e.target.value)}
              />
            </div>
            <p className="text-xs text-slate-500">{t("admin.internetBaseUrlHint")}</p>
          </div>
        </div>

        <div className="space-y-3">
          <label className="text-[10px] font-bold uppercase tracking-[0.2em] text-slate-500 ml-1">Current Base Endpoint</label>
          <div className="p-4 rounded-2xl bg-black/20 border border-white/5 font-mono text-sm text-brand-300 break-all leading-relaxed">
            {baseUrl || "None selected"}
          </div>
        </div>
      </div>

      <div className="grid gap-8 md:grid-cols-2">
         <div className="card !p-6 sm:!p-8 space-y-6">
           <div className="flex items-center gap-3 text-brand-400 border-b border-white/5 pb-4">
             <Clock size={20} />
             <h3 className="text-lg font-bold text-white tracking-tight">{t("admin.pollingTitle")}</h3>
           </div>
           <div className="space-y-3">
             <label className="text-[10px] font-bold uppercase tracking-[0.2em] text-slate-500 ml-1">
               {t("admin.pollInterval")}
             </label>
             <input
               className="input"
               type="number"
               min={MIN_POLL_SECONDS}
               max={MAX_POLL_SECONDS}
               inputMode="numeric"
               value={defaultPollSeconds}
               onChange={(e) => setDefaultPollSeconds(e.target.value)}
             />
             <p className="text-xs text-slate-500">{t("admin.pollHint")}</p>
           </div>

           <div className="space-y-3 pt-4 border-t border-white/5">
             <label className="text-[10px] font-bold uppercase tracking-[0.2em] text-slate-500 ml-1">
               {t("metrics.retentionDays")}
             </label>
             <input
               className="input"
               type="number"
               min="1"
               max="3650"
               value={metricsRetentionDays}
               onChange={(e) => setMetricsRetentionDays(e.target.value)}
             />
             <p className="text-xs text-slate-500">{t("metrics.retentionHint")}</p>
           </div>

           <div className="space-y-4 pt-4 border-t border-white/5">
             <label className="flex items-start gap-3 cursor-pointer">
               <input
                 type="checkbox"
                 className="mt-1 rounded border-white/10 bg-black/40 text-brand-500 focus:ring-brand-500/20"
                 checked={antivirusMonitoringEnabled}
                 onChange={(e) => setAntivirusMonitoringEnabled(e.target.checked)}
               />
               <span className="min-w-0">
                 <span className="block text-sm font-semibold text-white">
                   {t("antivirus.settingTitle")}
                 </span>
                 <span className="block text-xs text-slate-500 mt-0.5">
                   {t("antivirus.settingHint")}
                 </span>
               </span>
             </label>
           </div>

           <div className="space-y-4 pt-4 border-t border-white/5">
             <label className="flex items-start gap-3 cursor-pointer">
               <input
                 type="checkbox"
                 className="mt-1 rounded border-white/10 bg-black/40 text-brand-500 focus:ring-brand-500/20"
                 checked={updateCheckEnabled}
                 onChange={(e) => setUpdateCheckEnabled(e.target.checked)}
               />
               <span className="min-w-0">
                 <span className="block text-sm font-semibold text-white">
                   {t("updates.settingTitle")}
                 </span>
                 <span className="block text-xs text-slate-500 mt-0.5">
                   {t("updates.settingHint")}
                 </span>
               </span>
             </label>

             {updateCheckEnabled && (
               <>
                 <div className="space-y-2">
                   <label className="text-[10px] font-bold uppercase tracking-[0.2em] text-slate-500 ml-1">
                     {t("updates.intervalLabel")}
                   </label>
                   <select
                     className="input"
                     value={updateCheckIntervalMinutes}
                     onChange={(e) => setUpdateCheckIntervalMinutes(e.target.value)}
                   >
                     <option value="5">{t("updates.every", { n: 5 })}</option>
                     <option value="10">{t("updates.every", { n: 10 })}</option>
                     <option value="30">{t("updates.every", { n: 30 })}</option>
                     <option value="60">{t("updates.every", { n: 60 })}</option>
                   </select>
                 </div>

                 <div className="space-y-2">
                   <label className="text-[10px] font-bold uppercase tracking-[0.2em] text-slate-500 ml-1">
                     {t("updates.urlLabel")}
                   </label>
                   <input
                     className="input"
                     type="url"
                     placeholder={t("updates.urlPlaceholder")}
                     value={updateReleaseUrl}
                     onChange={(e) => setUpdateReleaseUrl(e.target.value)}
                   />
                   <p className="text-xs text-slate-500">{t("updates.urlHint")}</p>
                 </div>
               </>
             )}
           </div>
         </div>

         <div className="card !p-0 overflow-hidden flex flex-col">
           <button className="flex w-full items-center justify-between p-8 text-left hover:bg-white/[0.02] transition-colors" onClick={() => setAgentWebExpanded(!agentWebExpanded)}>
             <div className="flex items-center gap-3 text-brand-400">
               <Monitor size={20} />
               <h3 className="text-lg font-bold text-white tracking-tight">Agent Web UI</h3>
             </div>
             <div className="p-2 rounded-lg bg-white/5 text-slate-500">{agentWebExpanded ? <ChevronDown size={18} /> : <ChevronRight size={18} />}</div>
           </button>
           {agentWebExpanded && (
             <div className="p-8 pt-4 space-y-6 border-t border-white/5 bg-black/10">
               <p className="text-xs font-medium text-slate-500 leading-relaxed">Local direct console access for agents.</p>
             </div>
           )}
         </div>
      </div>

      <MonitoringAlerts />
      <HealthPanel />
      <AuditPanel />

      <div className="card !p-8 flex items-center justify-between gap-4">
        <div className="flex gap-4">
          <button className="btn btn-primary !px-8 !py-3" onClick={save} disabled={saving}><Save size={18} /><span>{saving ? "Saving..." : "Save All Settings"}</span></button>
          <button className="btn btn-secondary !px-8 !py-3" onClick={load}><RefreshCw size={18} /><span>Refresh Data</span></button>
        </div>
        {message && <p className="text-xs font-bold uppercase tracking-widest text-emerald-400 animate-fade-in">{message}</p>}
      </div>
    </div>
  );
}

function AuditPanel() {
  const [expanded, setExpanded] = useState(false);
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState("");

  const load = async () => {
    setLoading(true);
    try {
      const res = await apiFetch("/api/admin/audit?limit=200");
      setEvents(res.events || []);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (expanded && events.length === 0) load();
  }, [expanded]);

  const shown = events.filter((event) => {
    const term = filter.trim().toLowerCase();
    if (!term) return true;
    return [
      event.actorUsername,
      event.action,
      event.entityType,
      event.entityId,
      event.agentDisplayName,
      event.agentId
    ].some((value) => String(value || "").toLowerCase().includes(term));
  });

  return (
    <div className="card !p-0 overflow-hidden">
      <button className="flex w-full items-center justify-between p-6 text-left hover:bg-white/[0.02] transition-colors" onClick={() => setExpanded(!expanded)}>
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-xl bg-slate-500/10 text-slate-400">
             <History size={18} />
          </div>
          <div>
            <h3 className="text-lg font-bold text-white tracking-tight">Audit Log</h3>
            <p className="text-xs font-medium text-slate-500">Track sensitive actions: commands, agents, notifications.</p>
          </div>
        </div>
        <div className="p-2 rounded-lg bg-white/5 text-slate-500">
           {expanded ? <ChevronDown size={18} /> : <ChevronRight size={18} />}
        </div>
      </button>
      {expanded && (
        <div className="p-6 space-y-6 border-t border-white/5 bg-black/10">
          <div className="flex flex-col gap-3 md:flex-row">
            <input className="input flex-1" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter user, agent, action..." />
            <button className="btn btn-secondary" onClick={load} disabled={loading}>
              <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
              <span>Refresh</span>
            </button>
          </div>
          <div className="max-h-[420px] overflow-auto rounded-2xl border border-white/5 bg-black/20 custom-scrollbar">
            <table className="w-full text-left text-sm">
              <thead className="sticky top-0 bg-ink-900 shadow-sm">
                <tr>
                  <th className="table-header">Date</th>
                  <th className="table-header">Actor</th>
                  <th className="table-header">Action</th>
                  <th className="table-header">Target</th>
                  <th className="table-header">Details</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/[0.03]">
                {shown.map((event) => (
                  <tr key={event.id} className="hover:bg-white/[0.01] transition-colors">
                    <td className="whitespace-nowrap px-4 py-3 text-xs text-slate-500">{formatDate(event.createdAt)}</td>
                    <td className="px-4 py-3 text-slate-300 font-semibold">{event.actorUsername || "System"}</td>
                    <td className="px-4 py-3"><span className="px-2 py-0.5 rounded bg-brand-500/10 text-brand-400 text-[10px] font-bold uppercase tracking-widest border border-brand-500/20">{event.action}</span></td>
                    <td className="px-4 py-3 text-xs text-slate-400">
                      {event.agentDisplayName || event.agentId || event.entityId || event.entityType}
                    </td>
                    <td className="px-4 py-3">
                      {event.details ? (
                        <pre className="max-w-md overflow-auto whitespace-pre-wrap text-[10px] font-mono text-slate-500 bg-black/20 p-2 rounded-lg leading-relaxed">{JSON.stringify(event.details, null, 2)}</pre>
                      ) : (
                        <span className="text-xs text-slate-600">-</span>
                      )}
                    </td>
                  </tr>
                ))}
                {shown.length === 0 && (
                  <tr><td colSpan="5" className="px-4 py-12 text-center text-sm font-medium text-slate-500 italic">No events found.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function HealthPanel() {
  const [expanded, setExpanded] = useState(false);
  const [health, setHealth] = useState(null);
  const [notifications, setNotifications] = useState([]);
  const [loading, setLoading] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const [healthRes, notificationRes] = await Promise.all([
        apiFetch("/api/admin/health"),
        apiFetch("/api/notifications/history?limit=50")
      ]);
      setHealth(healthRes.health || null);
      setNotifications(notificationRes.events || []);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (expanded && !health) load();
  }, [expanded]);

  const stat = (label, value, tone = "text-slate-200", Icon) => (
    <div className="card !bg-white/[0.02] !p-4 flex flex-col gap-2">
      <div className="flex items-center justify-between">
         <div className={`p-1.5 rounded-lg bg-white/5 ${tone.replace('text', 'text')}`}>
            <Icon size={14} />
         </div>
         <div className={`text-xl font-bold ${tone}`}>{value}</div>
      </div>
      <div className="text-[10px] font-bold uppercase tracking-widest text-slate-500">{label}</div>
    </div>
  );

  return (
    <div className="card !p-0 overflow-hidden">
      <button className="flex w-full items-center justify-between p-6 text-left hover:bg-white/[0.02] transition-colors" onClick={() => setExpanded(!expanded)}>
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-xl bg-emerald-500/10 text-emerald-400">
             <Activity size={18} />
          </div>
          <div>
            <h3 className="text-lg font-bold text-white tracking-tight">System Health & Alerts</h3>
            <p className="text-xs font-medium text-slate-500">Real-time status of server, agents, and notification channels.</p>
          </div>
        </div>
        <div className="p-2 rounded-lg bg-white/5 text-slate-500">
           {expanded ? <ChevronDown size={18} /> : <ChevronRight size={18} />}
        </div>
      </button>
      {expanded && (
        <div className="p-6 space-y-6 border-t border-white/5 bg-black/10">
          <div className="flex justify-between items-center">
             <button className="btn btn-secondary text-xs" onClick={load} disabled={loading}>
               <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
               <span>Refresh Status</span>
             </button>
          </div>
          
          {health ? (
            <div className="space-y-6">
              <div className="grid gap-4 grid-cols-2 md:grid-cols-4">
                {stat("Total Agents", health.agents.total, "text-brand-400", Monitor)}
                {stat("Online", health.agents.online, "text-emerald-400", Globe)}
                {stat("Offline", health.agents.offline, "text-red-400", AlertCircle)}
                {stat("Alert Failures", health.notifications.failed, health.notifications.failed ? "text-red-400" : "text-emerald-400", Bell)}
              </div>
              <div className="rounded-2xl bg-white/[0.03] border border-white/5 p-4 flex flex-wrap gap-x-8 gap-y-2 text-xs font-medium">
                <div className="flex items-center gap-2"><span className="text-slate-500 uppercase tracking-widest font-bold">HTTP:</span> <span className={health.server.httpEnabled ? 'text-emerald-400' : 'text-slate-600'}>{health.server.httpEnabled ? "Active" : "Inactive"}</span></div>
                <div className="flex items-center gap-2"><span className="text-slate-500 uppercase tracking-widest font-bold">HTTPS:</span> <span className={health.server.httpsEnabled ? 'text-emerald-400' : 'text-slate-600'}>{health.server.httpsEnabled ? "Active" : "Inactive"}</span></div>
                <div className="flex items-center gap-2"><span className="text-slate-500 uppercase tracking-widest font-bold">Agent Protocol:</span> <span className="text-brand-400 font-mono">{health.server.defaultApiProtocol}</span></div>
                <div className="flex items-center gap-2 ml-auto"><span className="text-slate-500 uppercase tracking-widest font-bold">Last Audit:</span> <span className="text-slate-400">{formatDate(health.latestAuditAt)}</span></div>
              </div>
            </div>
          ) : null}

          <div className="space-y-3">
             <div className="text-[10px] font-bold text-slate-500 uppercase tracking-widest ml-1">Recent Notifications</div>
             <div className="max-h-[320px] overflow-auto rounded-2xl border border-white/5 bg-black/20 custom-scrollbar">
                <table className="w-full text-left text-sm">
                  <thead className="sticky top-0 bg-ink-900">
                    <tr>
                      <th className="table-header">Date</th>
                      <th className="table-header">Channel</th>
                      <th className="table-header">Subject</th>
                      <th className="table-header">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/[0.03]">
                    {notifications.map((event) => (
                      <tr key={event.id} className="hover:bg-white/[0.01] transition-colors">
                        <td className="whitespace-nowrap px-4 py-3 text-xs text-slate-500">{formatDate(event.createdAt)}</td>
                        <td className="px-4 py-3 text-slate-300 font-semibold uppercase text-[10px] tracking-wider">{event.channel}</td>
                        <td className="px-4 py-3 text-slate-300 text-xs font-medium">{event.subject}</td>
                        <td className="px-4 py-3">
                          <span className={`badge border ${event.ok ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20" : "bg-red-500/10 text-red-400 border-red-500/20"}`}>
                            {event.ok ? "Delivered" : event.errorMessage || "Failed"}
                          </span>
                        </td>
                      </tr>
                    ))}
                    {notifications.length === 0 && (
                      <tr><td colSpan="4" className="px-4 py-8 text-center text-sm font-medium text-slate-500 italic">No recent notifications.</td></tr>
                    )}
                  </tbody>
                </table>
             </div>
          </div>
        </div>
      )}
    </div>
  );
}
