import React from "react";
import { Navigate } from "react-router-dom";
import { useAuth } from "./AuthProvider.jsx";
import { useI18n } from "../lib/i18n.js";

export default function ProtectedRoute({ children }) {
  const { user, loading } = useAuth();
  const { t } = useI18n();
  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center text-slate-200">
        {t("common.loading")}
      </div>
    );
  }
  if (!user) {
    return <Navigate to="/login" replace />;
  }
  return children;
}
