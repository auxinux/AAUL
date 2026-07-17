import React, { useState } from "react";
import { useAuth } from "./AuthProvider.jsx";
import { useI18n } from "../lib/i18n.js";

export default function PasswordChangeGate() {
  const { user, changePassword, logout } = useAuth();
  const { t } = useI18n();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  if (!user?.mustChangePassword) {
    return null;
  }

  const submit = async (event) => {
    event.preventDefault();
    setError("");

    if (newPassword.length < 10) {
      setError(t("passwordChange.passwordTooShort"));
      return;
    }
    if (newPassword !== confirmPassword) {
      setError(t("passwordChange.passwordMismatch"));
      return;
    }

    setLoading(true);
    try {
      await changePassword(currentPassword, newPassword);
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
    } catch (err) {
      setError(err.message || t("passwordChange.failed"));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-ink-950/90 p-4 backdrop-blur-sm">
      <div className="card w-full max-w-xl animate-float-in border border-amber-500/30 shadow-[0_24px_80px_rgba(15,23,42,0.55)]">
        <div className="space-y-2">
          <p className="text-xs uppercase tracking-[0.35em] text-amber-300">
            {t("passwordChange.required")}
          </p>
          <h2 className="text-2xl font-semibold text-white">
            {t("passwordChange.title")}
          </h2>
          <p className="text-sm text-slate-400">
            {t("passwordChange.subtitle", { name: user.username })}
          </p>
        </div>

        <form className="mt-6 space-y-4" onSubmit={submit}>
          <input
            className="input"
            type="password"
            placeholder={t("passwordChange.currentPassword")}
            value={currentPassword}
            onChange={(event) => setCurrentPassword(event.target.value)}
          />
          <input
            className="input"
            type="password"
            placeholder={t("passwordChange.newPassword")}
            value={newPassword}
            onChange={(event) => setNewPassword(event.target.value)}
          />
          <input
            className="input"
            type="password"
            placeholder={t("passwordChange.confirmPassword")}
            value={confirmPassword}
            onChange={(event) => setConfirmPassword(event.target.value)}
          />
          {error ? <p className="text-sm text-red-400">{error}</p> : null}
          <div className="flex flex-wrap justify-end gap-3 pt-2">
            <button
              type="button"
              className="btn btn-secondary"
              onClick={logout}
              disabled={loading}
            >
              {t("passwordChange.logout")}
            </button>
            <button
              type="submit"
              className="btn btn-primary"
              disabled={!currentPassword || !newPassword || !confirmPassword || loading}
            >
              {loading ? t("passwordChange.saving") : t("passwordChange.save")}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
