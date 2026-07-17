import React from "react";
import { AlertTriangle, Info, CheckCircle2, X } from "lucide-react";
import Modal from "./Modal.jsx";
import { useI18n } from "../lib/i18n.js";

/**
 * Reusable confirmation modal used instead of browser-native confirm/alert.
 */
export default function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  description,
  confirmLabel,
  cancelLabel,
  tone = "primary",
  loading = false,
  hideCancel = false,
  size = "sm"
}) {
  const { t } = useI18n();
  
  const toneConfig = {
    primary: {
      btnClass: "btn-primary",
      icon: Info,
      iconClass: "text-brand-400 bg-brand-500/10 border-brand-500/20"
    },
    danger: {
      btnClass: "btn-danger !bg-red-500 !text-white hover:!bg-red-600 shadow-glow",
      icon: AlertTriangle,
      iconClass: "text-red-400 bg-red-500/10 border-red-500/20"
    },
    success: {
      btnClass: "btn-primary !bg-emerald-500 !text-white hover:!bg-emerald-600 shadow-glow",
      icon: CheckCircle2,
      iconClass: "text-emerald-400 bg-emerald-500/10 border-emerald-500/20"
    }
  };

  const config = toneConfig[tone] || toneConfig.primary;
  const Icon = config.icon;

  return (
    <Modal open={open} onClose={onClose} title="" size={size} hideClose>
      <div className="flex flex-col items-center text-center p-2 animate-fade-in">
        <div className={`p-4 rounded-3xl border mb-6 ${config.iconClass}`}>
          <Icon size={32} />
        </div>
        
        <h3 className="text-xl font-extrabold text-white tracking-tight mb-3">
          {title}
        </h3>
        
        {description && (
          <p className="text-sm font-medium text-slate-400 leading-relaxed mb-8 px-4">
            {description}
          </p>
        )}
        
        <div className="flex gap-3 w-full">
          {!hideCancel && (
            <button
              type="button"
              className="btn btn-secondary flex-1"
              onClick={onClose}
              disabled={loading}
            >
              {cancelLabel || t("common.cancel")}
            </button>
          )}
          <button
            type="button"
            className={`btn flex-1 ${config.btnClass}`}
            onClick={onConfirm}
            disabled={loading}
          >
            {loading ? t("common.loading") : (confirmLabel || t("common.confirm"))}
          </button>
        </div>
      </div>
    </Modal>
  );
}
