"use client";

import { useState } from "react";
import {
  AlertTriangle,
  AlertCircle,
  CheckCircle2,
  Info,
  ChevronDown,
  ChevronRight,
  Crosshair,
  MessageSquare,
  Sparkles,
} from "lucide-react";
import { useStore } from "@/lib/store/useStore";
import type { Finding, FindingSeverity } from "@/lib/types/contract";
import clsx from "clsx";

const SEVERITY_CONFIG: Record<
  FindingSeverity,
  { label: string; edge: string; badge: string; icon: React.ElementType }
> = {
  critical: {
    label: "Critical",
    edge: "border-l-4 border-danger",
    badge: "bg-danger-soft text-danger",
    icon: AlertTriangle,
  },
  warning: {
    label: "Warning",
    edge: "border-l-4 border-warn",
    badge: "bg-warn-soft text-warn",
    icon: AlertCircle,
  },
  info: {
    label: "Info",
    edge: "border-l-4 border-accent",
    badge: "bg-accent-soft text-accent",
    icon: Info,
  },
  ok: {
    label: "Safe",
    edge: "border-l-4 border-ok",
    badge: "bg-ok-soft text-ok",
    icon: CheckCircle2,
  },
};

function getFindingTitle(f: Finding): string {
  switch (f.type) {
    case "resonance":
      return f.mode != null ? `Resonance: Mode ${f.mode}` : "Resonance";
    case "limit_exceeded":
      return f.component ? `Limit Exceeded: ${f.component}` : "Limit Exceeded";
    case "stress":
      return "Structural Stress";
    case "mount_amplification":
      return f.component ? `Mount Amplification: ${f.component}` : "Mount Amplification";
    case "displacement":
      return "Excessive Displacement";
    default:
      return `${f.severity.charAt(0).toUpperCase() + f.severity.slice(1)} Finding`;
  }
}

function FindingCard({
  finding,
  onShow,
  onAskCopilot,
}: {
  finding: Finding;
  onShow: () => void;
  onAskCopilot: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const cfg = SEVERITY_CONFIG[finding.severity] ?? SEVERITY_CONFIG.info;
  const Icon = cfg.icon;

  return (
    <div
      className={clsx(
        "rounded-md border border-line bg-surface p-3 transition-colors shadow-2xs",
        cfg.edge
      )}
    >
      {/* Title row */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 min-w-0 flex-1">
          <Icon size={14} className={clsx("shrink-0", cfg.badge.split(" ")[1])} />
          <span className="font-semibold text-xs text-ink truncate">{getFindingTitle(finding)}</span>
          {finding.component && (
            <span className="font-mono text-[10px] bg-panel border border-line-subtle px-1.5 py-0.2 rounded text-ink-2 shrink-0">
              {finding.component}
            </span>
          )}
        </div>
        <span
          className={clsx(
            "rounded px-1.5 py-0.2 text-[10px] font-semibold uppercase tracking-wider shrink-0 font-mono",
            cfg.badge
          )}
        >
          {cfg.label}
        </span>
      </div>

      {/* Key Numbers */}
      <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px] font-mono">
        {finding.value != null && (
          <span className="bg-panel px-1.5 py-0.5 rounded text-ink font-semibold">
            {finding.value.toFixed(2)} g RMS
            {finding.limit != null ? ` (limit ${finding.limit.toFixed(2)} g RMS)` : ""}
          </span>
        )}
        {finding.rpm != null && (
          <span className="bg-panel px-1.5 py-0.5 rounded text-ink-2">
            {finding.rpm.toLocaleString()} RPM ({(finding.rpm / 60).toFixed(1)} Hz)
          </span>
        )}
        {finding.mode != null && (
          <span className="bg-panel px-1.5 py-0.5 rounded text-ink-2">
            Mode {finding.mode}
            {finding.mode_f_hz != null ? ` (${finding.mode_f_hz.toFixed(1)} Hz)` : ""}
          </span>
        )}
      </div>

      {/* Detail description with clamp & more toggle */}
      <div className="mt-2 text-xs text-ink-2 leading-relaxed">
        <p className={clsx("transition-all", !expanded && "line-clamp-3")}>
          {finding.detail}
        </p>
        {finding.detail.length > 120 && (
          <button
            type="button"
            onClick={() => setExpanded(!expanded)}
            className="text-[11px] font-medium text-accent hover:underline mt-0.5"
          >
            {expanded ? "Show less" : "More..."}
          </button>
        )}
      </div>

      {/* Action buttons */}
      <div className="mt-3 flex items-center justify-end gap-1.5 border-t border-line-subtle pt-2">
        <button
          type="button"
          onClick={onAskCopilot}
          className="btn btn-ghost h-6 px-2 text-[11px] text-muted hover:text-accent"
          title="Ask Copilot about this finding"
        >
          <MessageSquare size={12} />
          <span>Explain</span>
        </button>
        <button
          type="button"
          onClick={onShow}
          className="btn btn-secondary h-6 px-2.5 text-[11px] text-accent font-semibold"
          title="Jump to RPM speed and focus part in 3D"
        >
          <Crosshair size={12} />
          <span>Show</span>
        </button>
      </div>
    </div>
  );
}

export default function FindingsPanel() {
  const analysis = useStore((s) => s.analysis);
  const focusFinding = useStore((s) => s.focusFinding);
  const setUi = useStore((s) => s.setUi);
  const addChatMessage = useStore((s) => s.addChatMessage);
  const [otherNotesOpen, setOtherNotesOpen] = useState(false);

  if (!analysis) {
    return (
      <div className="flex h-full flex-col items-center justify-center p-6 text-center text-xs text-muted">
        <Sparkles size={20} className="text-accent mb-2 opacity-60" />
        <p className="font-semibold text-ink">No vibration checkup yet</p>
        <p className="text-[11px] text-muted mt-1 max-w-[220px]">
          Click &quot;Run&quot; in the top bar to simulate motor harmonics and find resonances.
        </p>
      </div>
    );
  }

  // Sort: critical -> warning -> ok
  const actionableFindings = analysis.findings.filter(
    (f) => f.severity === "critical" || f.severity === "warning" || f.severity === "ok"
  );
  actionableFindings.sort((a, b) => {
    const order: Record<FindingSeverity, number> = { critical: 0, warning: 1, ok: 2, info: 3 };
    return (order[a.severity] ?? 99) - (order[b.severity] ?? 99);
  });

  // Group info-level items under one collapsed "Other notes"
  const infoFindings = analysis.findings.filter((f) => f.severity === "info");

  // Check if sensitive components are protected within their limits
  const sensitiveComponents = analysis.components.filter((c) => c.limit_g != null);
  const allSensitiveSafe =
    sensitiveComponents.length > 0 &&
    sensitiveComponents.every((c) => c.peak_accel_g <= (c.limit_g ?? 0.5));

  const handleAskCopilot = (f: Finding) => {
    setUi({ rightTab: "copilot", rightPanelOpen: true });
    addChatMessage({
      role: "user",
      content: `Why is there a ${f.severity} finding: "${f.detail}"? What is causing it and how can I resolve it?`,
    });
  };

  return (
    <div className="h-full overflow-y-auto p-3 space-y-3">
      {allSensitiveSafe && (
        <div className="rounded-md border border-ok/30 bg-ok-soft p-2.5 text-xs text-ink space-y-1">
          <div className="flex items-center gap-1.5 font-semibold text-ok">
            <CheckCircle2 size={14} className="shrink-0" />
            <span>Sensitive Components Protected</span>
          </div>
          <p className="text-[11px] text-ink-2 leading-relaxed">
            All sensitive payloads (camera & sensor mounts) are safely isolated below their G-limits across operating speeds.
          </p>
        </div>
      )}

      {actionableFindings.length === 0 && infoFindings.length === 0 ? (
        <div className="flex h-full flex-col items-center justify-center p-6 text-center text-xs text-ok">
          <CheckCircle2 size={24} className="mb-2" />
          <p className="font-semibold text-sm text-ink">All Components Safe</p>
          <p className="text-[11px] text-muted mt-1 max-w-[220px]">
            Every payload stays comfortably within safe acceleration limits across all operating speeds.
          </p>
        </div>
      ) : (
        <>
          {actionableFindings.map((f) => (
            <FindingCard
              key={f.id}
              finding={f}
              onShow={() => focusFinding(f)}
              onAskCopilot={() => handleAskCopilot(f)}
            />
          ))}

          {/* Educational engineering guide note */}
          <div className="rounded-md border border-line bg-panel/50 p-2.5 text-[11px] text-muted space-y-1 mt-3">
            <span className="font-semibold text-ink flex items-center gap-1">
              <Info size={12} className="text-accent shrink-0" />
              Understanding Findings
            </span>
            <p className="leading-relaxed">
              <strong>Limit Exceeded:</strong> Payload exceeds safe vibration limit. Solved by tuning mount isolators (Auto-fix).
            </p>
            <p className="leading-relaxed">
              <strong>Resonance:</strong> Motor RPM crosses frame natural modes. Isolator mounts protect payload sensors from this vibration; to shift the frame modes themselves, stiffen structural members in the Model tree.
            </p>
          </div>

          {/* Grouped info items: Collapsed "Other notes" */}
          {infoFindings.length > 0 && (
            <div className="rounded-md border border-line bg-panel/50 overflow-hidden">
              <button
                type="button"
                className="flex w-full items-center justify-between p-2.5 text-xs font-medium text-ink-2 hover:bg-panel transition-colors"
                onClick={() => setOtherNotesOpen(!otherNotesOpen)}
              >
                <div className="flex items-center gap-1.5">
                  {otherNotesOpen ? (
                    <ChevronDown size={13} className="text-muted" />
                  ) : (
                    <ChevronRight size={13} className="text-muted" />
                  )}
                  <Info size={13} className="text-accent" />
                  <span>Other notes ({infoFindings.length})</span>
                </div>
              </button>

              {otherNotesOpen && (
                <div className="p-2.5 pt-0 space-y-2 border-t border-line-subtle bg-surface">
                  {infoFindings.map((f) => (
                    <div key={f.id} className="text-xs text-muted border-b border-line-subtle pb-1.5 last:border-0 last:pb-0">
                      <div className="font-medium text-ink-2">{getFindingTitle(f)}</div>
                      <div className="text-[11px] mt-0.5">{f.detail}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
