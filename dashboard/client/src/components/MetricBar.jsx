import React from "react";

/**
 * A single labelled usage bar (CPU / memory / disk).
 *
 * Colour encodes urgency rather than identity, so a glance across a fleet reads
 * as "where is the pressure", not "which metric is which". The thresholds match
 * the server-side ones used by /api/agents/metrics/summary.
 */

const AMBER_AT = 75;
const RED_AT = 90;

function toneFor(percent) {
  if (percent === null || percent === undefined) {
    return { bar: "bg-slate-600", text: "text-slate-500" };
  }
  if (percent >= RED_AT) return { bar: "bg-red-500", text: "text-red-300" };
  if (percent >= AMBER_AT) return { bar: "bg-amber-500", text: "text-amber-300" };
  return { bar: "bg-emerald-500", text: "text-emerald-300" };
}

export default function MetricBar({
  label,
  percent,
  hint,
  icon: Icon,
  compact = false,
  unknownLabel = "—"
}) {
  const hasValue = percent !== null && percent !== undefined && Number.isFinite(Number(percent));
  const value = hasValue ? Math.min(100, Math.max(0, Number(percent))) : 0;
  const tone = toneFor(hasValue ? value : null);

  return (
    <div className={compact ? "space-y-1" : "space-y-1.5"}>
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 min-w-0">
          {Icon ? <Icon size={compact ? 11 : 13} className="text-slate-500 shrink-0" /> : null}
          <span
            className={`${
              compact ? "text-[9px]" : "text-[10px]"
            } font-bold uppercase tracking-widest text-slate-500 truncate`}
          >
            {label}
          </span>
        </div>
        <span
          className={`${compact ? "text-[10px]" : "text-xs"} font-bold tabular-nums ${tone.text}`}
        >
          {hasValue ? `${value.toFixed(0)}%` : unknownLabel}
        </span>
      </div>

      <div
        className={`w-full ${compact ? "h-1" : "h-1.5"} rounded-full bg-white/[0.06] overflow-hidden`}
        role="meter"
        aria-label={label}
        aria-valuenow={hasValue ? Math.round(value) : undefined}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuetext={hasValue ? `${value.toFixed(0)}%` : unknownLabel}
      >
        <div
          className={`h-full rounded-full transition-all duration-500 ${tone.bar}`}
          style={{ width: `${hasValue ? value : 0}%` }}
        />
      </div>

      {hint ? <div className="text-[10px] text-slate-500 truncate">{hint}</div> : null}
    </div>
  );
}

/**
 * The three vital signs of a host, as shown on fleet cards and the agent page.
 * Renders a clear "no data yet" state rather than three empty bars, because an
 * agent that has never reported is a different situation from one idling at 0%.
 */
export function MetricTrio({ metrics, compact = false, labels, noDataLabel }) {
  const text = {
    cpu: "CPU",
    memory: "RAM",
    disk: "Disk",
    ...(labels || {})
  };

  if (!metrics) {
    return (
      <div className="text-[10px] text-slate-600 italic">
        {noDataLabel || "No metrics reported yet"}
      </div>
    );
  }

  // Prefer the fullest volume over "/": a host can look fine on / while /var
  // is the one about to fill up.
  const diskPercent = metrics.busiestDiskPercent ?? metrics.diskPercent;
  const diskHint =
    metrics.busiestDiskMount && metrics.busiestDiskMount !== "/"
      ? metrics.busiestDiskMount
      : null;

  return (
    <div className={compact ? "space-y-1.5" : "space-y-2.5"}>
      <MetricBar label={text.cpu} percent={metrics.cpuPercent} compact={compact} />
      <MetricBar label={text.memory} percent={metrics.memoryPercent} compact={compact} />
      <MetricBar
        label={text.disk}
        percent={diskPercent}
        hint={compact ? null : diskHint}
        compact={compact}
      />
    </div>
  );
}

/** Tiny inline sparkline for a metric history series. */
export function Sparkline({ points, width = 120, height = 32, color = "#379ef9", label }) {
  const values = (points || []).filter((v) => v !== null && v !== undefined && Number.isFinite(v));
  if (values.length < 2) {
    return <div className="text-[10px] text-slate-600 italic">—</div>;
  }

  const max = Math.max(...values, 100);
  const min = 0;
  const span = max - min || 1;
  const step = width / (values.length - 1);
  const path = values
    .map((value, index) => {
      const x = index * step;
      const y = height - ((value - min) / span) * height;
      return `${index === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className="overflow-visible"
      role="img"
      aria-label={label}
      preserveAspectRatio="none"
    >
      <path d={path} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" />
      <path
        d={`${path} L${width},${height} L0,${height} Z`}
        fill={color}
        opacity="0.12"
        stroke="none"
      />
    </svg>
  );
}
