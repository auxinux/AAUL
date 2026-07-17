import React from "react";
import { 
  CheckCircle2, 
  XCircle, 
  Clock, 
  Activity, 
  Check 
} from "lucide-react";
import { useI18n } from "../lib/i18n.js";

const statusConfig = {
  OK: {
    className: "bg-emerald-500/10 text-emerald-400 border-emerald-500/20",
    icon: CheckCircle2
  },
  ERROR: {
    className: "bg-red-500/10 text-red-400 border-red-500/20",
    icon: XCircle
  },
  QUEUED: {
    className: "bg-amber-500/10 text-amber-400 border-amber-500/20",
    icon: Clock
  },
  IN_PROGRESS: {
    className: "bg-brand-500/10 text-brand-400 border-brand-500/20",
    icon: Activity
  },
  DONE: {
    className: "bg-emerald-500/10 text-emerald-400 border-emerald-500/20",
    icon: Check
  }
};

export default function StatusBadge({ label }) {
  const { t } = useI18n();
  if (!label) {
    return <span className="text-[10px] font-bold text-slate-600 uppercase tracking-widest">-</span>;
  }
  
  const translations = {
    OK: t("status.ok"),
    ERROR: t("status.error"),
    QUEUED: t("status.queued"),
    IN_PROGRESS: t("status.inProgress"),
    DONE: t("status.done")
  };
  
  const config = statusConfig[label] || {
    className: "bg-slate-500/10 text-slate-400 border-slate-500/20",
    icon: Activity
  };
  
  const Icon = config.icon;
  const display = translations[label] || label;

  return (
    <span className={`badge border flex items-center gap-1.5 w-fit ${config.className}`}>
      <Icon size={12} strokeWidth={3} />
      {display}
    </span>
  );
}
