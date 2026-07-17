import React, { useState } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { Lock, User, ShieldCheck, ArrowRight } from "lucide-react";
import { useAuth } from "../components/AuthProvider.jsx";
import { useI18n } from "../lib/i18n.js";
import LanguageToggle from "../components/LanguageToggle.jsx";

export default function Login() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const { t } = useI18n();

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await login(username, password);
      const origin = location.state?.from?.pathname || "/dashboard";
      navigate(origin, { replace: true });
    } catch (err) {
      setError(err.message || t("login.error") || "Login failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-6 relative overflow-hidden bg-ink-950">
      {/* Background Decorative Elements */}
      <div className="absolute top-0 left-0 w-full h-full -z-10">
        <div className="absolute top-[-10%] left-[-10%] w-[40%] h-[40%] bg-brand-500/10 rounded-full blur-[120px] animate-pulse" />
        <div className="absolute bottom-[-10%] right-[-10%] w-[40%] h-[40%] bg-emerald-500/10 rounded-full blur-[120px] animate-pulse" style={{ animationDelay: '1s' }} />
      </div>

      <div className="w-full max-w-md animate-fade-in">
        <div className="flex justify-end mb-4">
           <LanguageToggle />
        </div>
        
        <div className="text-center mb-10">
          <div className="inline-flex p-4 rounded-3xl bg-brand-500/10 text-brand-400 border border-brand-500/20 mb-6 shadow-glow">
             <ShieldCheck size={40} />
          </div>
          <h1 className="text-4xl font-extrabold text-white tracking-tight mb-2 uppercase">
             AAUL
          </h1>
          <p className="text-slate-400 font-medium uppercase tracking-widest text-xs">
            Fleet Management System
          </p>
        </div>

        <div className="card !p-8 shadow-2xl">
          <form onSubmit={handleSubmit} className="space-y-6">
            <div className="space-y-2">
              <label className="text-[10px] font-bold uppercase tracking-[0.2em] text-slate-500 ml-1">
                {t("login.username")}
              </label>
              <div className="relative group">
                <User className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-500 group-focus-within:text-brand-400 transition-colors" size={18} />
                <input
                  type="text"
                  className="input !pl-12"
                  placeholder="admin"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  required
                  autoFocus
                />
              </div>
            </div>

            <div className="space-y-2">
              <label className="text-[10px] font-bold uppercase tracking-[0.2em] text-slate-500 ml-1">
                {t("login.password")}
              </label>
              <div className="relative group">
                <Lock className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-500 group-focus-within:text-brand-400 transition-colors" size={18} />
                <input
                  type="password"
                  className="input !pl-12"
                  placeholder="••••••••"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                />
              </div>
            </div>

            {error && (
              <div className="p-4 rounded-xl bg-red-500/10 border border-red-500/20 text-red-400 text-sm font-medium animate-fade-in text-center">
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={busy}
              className="btn btn-primary w-full !py-4 text-base tracking-wide mt-4 group"
            >
              <span>{busy ? t("common.loading") : (t("login.login") || "Sign In")}</span>
              <ArrowRight size={18} className="group-hover:translate-x-1 transition-transform" />
            </button>
          </form>
        </div>
        
        <p className="mt-8 text-center text-[10px] text-slate-600 font-bold uppercase tracking-[0.3em]">
          © 2026 Auxinux · Projet AAUL
        </p>
      </div>
    </div>
  );
}
