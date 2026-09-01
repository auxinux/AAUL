import React from "react";

const USED_COLOR = "#0c81eb"; // brand-500
const FREE_COLOR = "#33f0b5"; // neon-500

export default function DonutChart({
  used,
  total,
  usedLabel,
  freeLabel,
  usedValue,
  freeValue,
  size = 96,
  thickness = 8,
  layout = "row"
}) {
  const safeTotal = Number.isFinite(total) && total > 0 ? total : 0;
  const safeUsed =
    Number.isFinite(used) && used >= 0 ? Math.min(used, safeTotal) : 0;
  const percent = safeTotal ? Math.round((safeUsed / safeTotal) * 100) : 0;
  const hole = Math.max(size - thickness * 2, 0);
  
  const wrapperClass =
    layout === "stacked"
      ? "flex flex-col items-start gap-4"
      : "flex flex-col gap-4 sm:flex-row sm:items-center sm:gap-6";

  return (
    <div className={wrapperClass}>
      <div
        className="relative flex items-center justify-center shrink-0 group"
        style={{ width: size, height: size }}
      >
        {/* Outer Glow */}
        <div className="absolute inset-0 rounded-full bg-brand-500/5 blur-xl group-hover:bg-brand-500/10 transition-colors" />
        
        <div
          className="absolute inset-0 rounded-full border border-white/5"
          style={{
            background: `conic-gradient(${USED_COLOR} 0 ${percent}%, ${FREE_COLOR} 0 100%)`,
            mask: `radial-gradient(transparent ${hole/2}px, black ${hole/2 + 0.5}px)`,
            WebkitMask: `radial-gradient(transparent ${hole/2}px, black ${hole/2 + 0.5}px)`
          }}
        />
        
        {/* Inner shadow/ring */}
        <div 
          className="absolute rounded-full border border-white/5 bg-ink-950/80 shadow-inner"
          style={{ width: hole, height: hole }}
        />
        
        <div className="relative flex flex-col items-center justify-center">
          <span className="text-sm font-bold text-white leading-none">{percent}%</span>
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2.5">
          <div className="w-2 h-2 rounded-full" style={{ backgroundColor: USED_COLOR }} />
          <div className="flex flex-col">
            <span className="text-[10px] uppercase tracking-widest text-slate-500 font-bold leading-none mb-0.5">
              {usedLabel}
            </span>
            <span className="text-xs font-semibold text-slate-200">
              {usedValue}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-2.5">
          <div className="w-2 h-2 rounded-full" style={{ backgroundColor: FREE_COLOR }} />
          <div className="flex flex-col">
            <span className="text-[10px] uppercase tracking-widest text-slate-500 font-bold leading-none mb-0.5">
              {freeLabel}
            </span>
            <span className="text-xs font-semibold text-slate-200">
              {freeValue}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
