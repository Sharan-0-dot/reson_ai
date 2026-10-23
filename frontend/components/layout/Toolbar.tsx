"use client";

import { useEffect, useState, useRef } from "react";
import {
  Activity,
  FolderOpen,
  Play,
  Sparkles,
  GitCompare,
  HelpCircle,
  ShieldCheck,
  Loader2,
  Check,
  ChevronRight,
  RefreshCw,
  X,
} from "lucide-react";
import { useStore } from "@/lib/store/useStore";
import { analyze, optimize, healthCheck } from "@/lib/api/client";
import clsx from "clsx";

export default function Toolbar() {
  const design = useStore((s) => s.design);
  const analysis = useStore((s) => s.analysis);
  const optimizeResult = useStore((s) => s.optimizeResult);
  const viewMode = useStore((s) => s.ui.viewMode);
  const isAnalyzing = useStore((s) => s.ui.isAnalyzing);
  const isOptimizing = useStore((s) => s.ui.isOptimizing);
  const helpPopoverOpen = useStore((s) => s.ui.helpPopoverOpen);
  const setUi = useStore((s) => s.setUi);
  const setAnalysis = useStore((s) => s.setAnalysis);
  const setOptimizeResult = useStore((s) => s.setOptimizeResult);
  const setActiveCandidate = useStore((s) => s.setActiveCandidate);
  const setRpm = useStore((s) => s.setRpm);
  const showToast = useStore((s) => s.showToast);

  const [apiOnline, setApiOnline] = useState<boolean | null>(null);
  const [checkingApi, setCheckingApi] = useState(false);
  const helpRef = useRef<HTMLDivElement>(null);

  // Check solver backend health
  const verifyHealth = async () => {
    setCheckingApi(true);
    try {
      const ok = await healthCheck();
      setApiOnline(ok);
    } catch {
      setApiOnline(false);
    } finally {
      setCheckingApi(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    healthCheck()
      .then((ok) => {
        if (!cancelled) setApiOnline(ok);
      })
      .catch(() => {
        if (!cancelled) setApiOnline(false);
      });

    const timer = setInterval(() => {
      healthCheck()
        .then((ok) => {
          if (!cancelled) setApiOnline(ok);
        })
        .catch(() => {
          if (!cancelled) setApiOnline(false);
        });
    }, 30_000);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  // Close help popover on click outside
  useEffect(() => {
    const handleOutsideClick = (e: MouseEvent) => {
      if (helpRef.current && !helpRef.current.contains(e.target as Node)) {
        setUi({ helpPopoverOpen: false });
      }
    };
    if (helpPopoverOpen) {
      document.addEventListener("mousedown", handleOutsideClick);
    }
    return () => document.removeEventListener("mousedown", handleOutsideClick);
  }, [helpPopoverOpen, setUi]);

  // Current workflow step calculation
  const currentStep = viewMode === "compare"
    ? 4
    : isOptimizing || optimizeResult
    ? 3
    : isAnalyzing || analysis
    ? 2
    : 1;

  const handleRun = async () => {
    if (!design) return;
    setUi({ isAnalyzing: true, error: null });
    try {
      const result = await analyze(design);
      setAnalysis(result);
      const crit = result.findings.find((f) => f.severity === "critical" && f.rpm);
      if (crit?.rpm) setRpm(crit.rpm);
      showToast("Simulation complete. Findings updated.", "success");
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Analysis failed";
      setUi({ error: msg });
      showToast(msg, "warning");
    } finally {
      setUi({ isAnalyzing: false });
    }
  };

  const handleOptimize = async () => {
    if (!design) return;
    setUi({ isOptimizing: true, error: null });
    try {
      if (!analysis) {
        analyze(design).then(setAnalysis).catch(() => {});
      }
      const result = await optimize(design);
      setOptimizeResult(result);

      if (result.candidates.length === 0) {
        setActiveCandidate(null);
        showToast("No optimization candidates found.", "warning");
        return;
      }

      const best = result.candidates[result.best_index] ?? result.candidates[0];
      setActiveCandidate(best);
      setUi({ viewMode: "compare", animating: true });

      if (best.reduction_pct > 0) {
        showToast(
          `Optimized mounts found: ${best.reduction_pct.toFixed(1)}% vibration reduction.`,
          "success"
        );
      } else {
        showToast("Optimization finished without significant vibration reduction.", "warning");
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Optimization failed";
      if (msg.includes("409") || msg.includes("busy")) {
        showToast("An optimisation is already running", "warning");
      } else {
        setUi({ error: msg });
        showToast(msg, "warning");
      }
    } finally {
      setUi({ isOptimizing: false });
    }
  };

  return (
    <header className="relative z-30 flex h-12 shrink-0 select-none items-center justify-between border-b border-line bg-surface px-3">
      {/* Left: Brand + Presets + 4-Step Progress Hint */}
      <div className="flex items-center gap-3">
        {/* Brand */}
        <div className="flex items-center gap-2 pr-1">
          <div className="flex h-7 w-7 items-center justify-center rounded-md bg-accent text-white shadow-sm">
            <Activity size={16} strokeWidth={2.2} />
          </div>
          <span className="font-semibold tracking-tight text-ink text-sm">ResonAI</span>
        </div>

        <div className="h-4 w-px bg-line" aria-hidden />

        {/* Preset Picker */}
        <button
          type="button"
          className="btn btn-outline h-7 px-2.5 text-xs text-ink-2 hover:text-ink"
          onClick={() => setUi({ presetPickerOpen: true })}
          title="Load pre-configured structure model"
        >
          <FolderOpen size={13} className="text-muted" />
          <span>Preset</span>
        </button>

        <div className="hidden sm:block h-4 w-px bg-line" aria-hidden />

        {/* 4-Step Progress Indicator */}
        <nav aria-label="Workflow progress" className="hidden lg:flex items-center gap-1 text-xs">
          <div
            className={clsx(
              "flex items-center gap-1 px-2 py-0.5 rounded font-medium transition-colors",
              currentStep === 1
                ? "bg-accent-soft text-accent font-semibold"
                : currentStep > 1
                ? "text-ink-2"
                : "text-muted"
            )}
          >
            {currentStep > 1 ? (
              <Check size={12} className="text-ok stroke-[2.5]" />
            ) : (
              <span className="w-4 text-center font-mono text-[11px]">1</span>
            )}
            <span>Build</span>
          </div>

          <ChevronRight size={12} className="text-muted" />

          <div
            className={clsx(
              "flex items-center gap-1 px-2 py-0.5 rounded font-medium transition-colors",
              currentStep === 2
                ? "bg-accent-soft text-accent font-semibold"
                : currentStep > 2
                ? "text-ink-2"
                : "text-muted"
            )}
          >
            {currentStep > 2 ? (
              <Check size={12} className="text-ok stroke-[2.5]" />
            ) : (
              <span className="w-4 text-center font-mono text-[11px]">2</span>
            )}
            <span>Run</span>
          </div>

          <ChevronRight size={12} className="text-muted" />

          <div
            className={clsx(
              "flex items-center gap-1 px-2 py-0.5 rounded font-medium transition-colors",
              currentStep === 3
                ? "bg-accent-soft text-accent font-semibold"
                : currentStep > 3
                ? "text-ink-2"
                : "text-muted"
            )}
          >
            {currentStep > 3 ? (
              <Check size={12} className="text-ok stroke-[2.5]" />
            ) : (
              <span className="w-4 text-center font-mono text-[11px]">3</span>
            )}
            <span>Fix</span>
          </div>

          <ChevronRight size={12} className="text-muted" />

          <div
            className={clsx(
              "flex items-center gap-1 px-2 py-0.5 rounded font-medium transition-colors",
              currentStep === 4
                ? "bg-accent-soft text-accent font-semibold"
                : "text-muted"
            )}
          >
            <span className="w-4 text-center font-mono text-[11px]">4</span>
            <span>Compare</span>
          </div>
        </nav>
      </div>

      {/* Right: Primary actions + Help + Health status */}
      <div className="flex items-center gap-2">
        {/* Run Simulation */}
        <button
          type="button"
          className="btn btn-primary h-7 px-3 text-xs shadow-xs"
          onClick={handleRun}
          disabled={!design || isAnalyzing}
          title="Run vibration simulation across RPM range"
        >
          {isAnalyzing ? (
            <>
              <Loader2 size={13} className="animate-spin" />
              <span>Running...</span>
            </>
          ) : (
            <>
              <Play size={13} className="fill-current" />
              <span>Run</span>
            </>
          )}
        </button>

        {/* Auto-Fix Optimizer */}
        <button
          type="button"
          className="btn btn-secondary h-7 px-3 text-xs"
          onClick={handleOptimize}
          disabled={!design || isOptimizing}
          title="Optimize isolator mounts to dampen resonance"
        >
          {isOptimizing ? (
            <>
              <Loader2 size={13} className="animate-spin" />
              <span>Optimizing...</span>
            </>
          ) : (
            <>
              <Sparkles size={13} />
              <span>Auto-fix</span>
            </>
          )}
        </button>

        {/* Compare View Toggle */}
        <button
          type="button"
          className={clsx(
            "btn h-7 px-2.5 text-xs transition-colors",
            viewMode === "compare"
              ? "bg-accent-soft border-accent-line text-accent font-semibold"
              : "btn-outline text-ink-2"
          )}
          onClick={() =>
            setUi({ viewMode: viewMode === "compare" ? "single" : "compare" })
          }
          disabled={!optimizeResult}
          title={optimizeResult ? "Compare original vs optimized side-by-side" : "Run Auto-fix to unlock Compare mode"}
        >
          <GitCompare size={13} />
          <span className="hidden sm:inline">Compare</span>
        </button>

        <div className="h-4 w-px bg-line" aria-hidden />

        {/* Accuracy Validation Suite */}
        <button
          type="button"
          className="btn btn-ghost h-7 w-7 p-0 text-ink-2 hover:text-ink"
          onClick={() => setUi({ validationModalOpen: true })}
          title="Engineering Validation Benchmark Cases"
          aria-label="Accuracy Tests"
        >
          <ShieldCheck size={15} />
        </button>

        {/* Help Popover Anchor */}
        <div className="relative" ref={helpRef}>
          <button
            type="button"
            className={clsx(
              "btn btn-ghost h-7 w-7 p-0 transition-colors",
              helpPopoverOpen ? "bg-panel text-accent" : "text-ink-2 hover:text-ink"
            )}
            onClick={() => setUi({ helpPopoverOpen: !helpPopoverOpen })}
            title="Help and quick tips"
            aria-label="Help"
            aria-expanded={helpPopoverOpen}
          >
            <HelpCircle size={15} />
          </button>

          {/* Help Popover (3 Key Tips) */}
          {helpPopoverOpen && (
            <div className="absolute right-0 top-9 z-50 w-80 rounded-lg border border-line bg-surface p-3.5 shadow-lg animate-in fade-in zoom-in-95 duration-100">
              <div className="flex items-center justify-between pb-2 mb-2 border-b border-line-subtle">
                <span className="text-xs font-semibold text-ink">Quick Workflow Guide</span>
                <button
                  type="button"
                  onClick={() => setUi({ helpPopoverOpen: false })}
                  className="text-muted hover:text-ink p-0.5 rounded"
                  aria-label="Close help"
                >
                  <X size={13} />
                </button>
              </div>

              <div className="space-y-2.5 text-xs text-ink-2 leading-relaxed">
                <div className="flex gap-2">
                  <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent font-semibold text-[11px]">
                    1
                  </span>
                  <div>
                    <strong className="text-ink font-semibold">Build:</strong> Pick a preset or inspect frame members and sensitive payloads in the left Model tree.
                  </div>
                </div>

                <div className="flex gap-2">
                  <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent font-semibold text-[11px]">
                    2
                  </span>
                  <div>
                    <strong className="text-ink font-semibold">Run:</strong> Click Run to simulate harmonic dynamics across 500–12,000 RPM. Findings list any over-limit components.
                  </div>
                </div>

                <div className="flex gap-2">
                  <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent font-semibold text-[11px]">
                    3
                  </span>
                  <div>
                    <strong className="text-ink font-semibold">Fix & Compare:</strong> Click Auto-fix to tune isolator mounts ($k_v$, $\zeta$), then toggle Compare to verify attenuation.
                  </div>
                </div>
              </div>

              <div className="mt-3 pt-2 border-t border-line-subtle text-[11px] text-muted flex items-center justify-between">
                <span>Shortcut: Press <kbd className="font-mono bg-panel px-1 py-0.5 rounded border border-line">F</kbd> for focus mode</span>
              </div>
            </div>
          )}
        </div>

        {/* Solver API Status Dot */}
        <div
          className="flex items-center pl-1"
          title={
            checkingApi
              ? "Checking Solver API..."
              : apiOnline
              ? "Solver API connected (http://127.0.0.1:8000)"
              : "Solver API offline (Click to retry)"
          }
        >
          <button
            type="button"
            onClick={verifyHealth}
            className="flex items-center gap-1.5 p-1 rounded hover:bg-panel transition-colors"
            aria-label="API status"
          >
            <span
              className={clsx(
                "h-2 w-2 rounded-full transition-colors",
                checkingApi
                  ? "bg-amber-400 animate-pulse"
                  : apiOnline
                  ? "bg-ok"
                  : "bg-danger"
              )}
            />
            {!apiOnline && apiOnline !== null && (
              <RefreshCw size={11} className="text-danger hover:rotate-180 transition-transform" />
            )}
          </button>
        </div>
      </div>
    </header>
  );
}
