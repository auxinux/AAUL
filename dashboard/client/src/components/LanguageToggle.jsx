import React from "react";
import { useI18n } from "../lib/i18n.js";

export default function LanguageToggle() {
  const { toggleLang, t } = useI18n();
  return (
    <button className="btn btn-secondary px-3 py-2 text-xs" onClick={toggleLang}>
      {t("language.toggle")}
    </button>
  );
}