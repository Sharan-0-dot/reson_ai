"use client";

import { useMemo, useEffect, type ReactNode } from "react";
import dynamic from "next/dynamic";
import Toolbar from "@/components/layout/Toolbar";
import ModelTree from "@/components/layout/ModelTree";
import RightDock from "@/components/layout/RightDock";
import BottomTabs from "@/components/layout/BottomTabs";
import ComparePanel from "@/components/panels/ComparePanel";
import LoadingOverlay from "@/components/ui/LoadingOverlay";
import ErrorBanner from "@/components/ui/ErrorBanner";
import ErrorBoundary from "@/components/ui/ErrorBoundary";
import PresetGalleryModal from "@/components/dialogs/PresetGalleryModal";
import AddComponentModal from "@/components/dialogs/AddComponentModal";
import ValidationModal from "@/components/dialogs/ValidationModal";
import ToastNotification from "@/components/ui/ToastNotification";
import PerfOverlay from "@/components/ui/PerfOverlay";
import { useStore } from "@/lib/store/useStore";
import { STRUCTURE_PRESETS } from "@/lib/presets/presets";
import { runClientSimulation } from "@/lib/solver/clientSolver";
import { analyze, getPresetDesign } from "@/lib/api/client";

// 3D canvas is client-only (no SSR)
const SceneRoot = dynamic(() => import("@/components/scene/SceneRoot"), {
  ssr: false,
  loading: () => (
    <div className="flex h-full items-center justify-center text-xs text-muted font-mono">
      Initializing 3D Viewport...
    </div>
  ),
});

/** Pinned corner badge for viewports in compare mode */
function ViewportBadge({
  tone,
  children,
}: {
  tone: "danger" | "ok";
  children: ReactNode;
}) {
  const palette =
    tone === "danger"
      ? "border-danger/30 bg-danger-soft text-danger"
      : "border-ok/30 bg-ok-soft text-ok";
  const dot = tone === "danger" ? "bg-danger" : "bg-ok";
  return (
    <div
      className={`absolute left-3 top-3 z-20 flex items-center gap-1.5 rounded border px-2.5 py-1 text-xs font-semibold shadow-2xs font-mono uppercase tracking-wider ${palette}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${dot}`} aria-hidden />
      {children}
    </div>
  );
}

export default function HomePage() {
  const design = useStore((s) => s.design);
  const analysis = useStore((s) => s.analysis);
  const setDesign = useStore((s) => s.setDesign);
  const pushHistory = useStore((s) => s.pushHistory);
  const setAnalysis = useStore((s) => s.setAnalysis);
  const setUi = useStore((s) => s.setUi);
  const viewMode = useStore((s) => s.ui.viewMode);
  const isAnalyzing = useStore((s) => s.ui.isAnalyzing);
  const isOptimizing = useStore((s) => s.ui.isOptimizing);
  const isFocusMode = useStore((s) => s.ui.isFocusMode);
  const optimizeResult = useStore((s) => s.optimizeResult);
  const activeCandidate = useStore((s) => s.activeCandidate);

  // Initialize with Quadcopter hero preset fetched from backend if empty on first load
  useEffect(() => {
    if (!design) {
      getPresetDesign("drone")
        .then((fetched) => {
          const d = fetched ?? structuredClone(STRUCTURE_PRESETS[0].design);
          setDesign(d);
          pushHistory(d);
          return analyze(d);
        })
        .then(setAnalysis)
        .catch((error: unknown) => {
          const fallback = structuredClone(STRUCTURE_PRESETS[0].design);
          setDesign(fallback);
          pushHistory(fallback);
          setUi({
            error:
              error instanceof Error
                ? error.message
                : "Initial analysis failed.",
          });
        });
    }
  }, [design, setDesign, pushHistory, setAnalysis, setUi]);

  // Compute optimized candidate simulation and shared max amplitude for Compare View
  const { candSim, sharedMaxAmp } = useMemo(() => {
    if (viewMode !== "compare" || !optimizeResult) {
      return { candSim: null, sharedMaxAmp: 1 };
    }
    const cand = activeCandidate ?? optimizeResult.candidates[0];
    if (!cand) return { candSim: null, sharedMaxAmp: 1 };

    const cSim = runClientSimulation(cand.design);

    let maxOrig = 0.01;
    if (analysis?.sweep.node_amp_mm) {
      for (const row of analysis.sweep.node_amp_mm) {
        for (const v of row) maxOrig = Math.max(maxOrig, v);
      }
    }
    let maxCand = 0.01;
    if (cSim.sweep.node_amp_mm) {
      for (const row of cSim.sweep.node_amp_mm) {
        for (const v of row) maxCand = Math.max(maxCand, v);
      }
    }
    const sharedMax = Math.max(maxOrig, maxCand);
    return { candSim: cSim, sharedMaxAmp: sharedMax };
  }, [viewMode, optimizeResult, activeCandidate, analysis]);

  // Keyboard shortcuts: F for Focus Mode, Delete for selected component
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const activeTag = document.activeElement?.tagName?.toLowerCase();
      if (
        activeTag === "input" ||
        activeTag === "textarea" ||
        activeTag === "select"
      ) {
        return;
      }

      // F key toggles focus mode
      if (e.key === "f" || e.key === "F") {
        e.preventDefault();
        useStore.getState().toggleFocusMode();
        return;
      }

      // Delete removes selected component
      if (e.key === "Delete" || e.key === "Backspace") {
        const sel = useStore.getState().selection;
        if (sel.type === "component" && sel.id) {
          e.preventDefault();
          useStore.getState().deleteComponent(sel.id);
        }
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  return (
    <PerfOverlay>
      <div className="flex h-screen flex-col overflow-hidden bg-canvas">
        <Toolbar />
        <ToastNotification />
        <ErrorBanner />

        <div className="relative flex min-h-0 flex-1">
          {/* Left: Model Panel (Structure, Materials, Supports, Components) */}
          <ModelTree />

          {/* Center Column: 3D Viewport + Bottom Diagnostic Plots */}
          <div className="relative flex min-w-0 flex-1 flex-col">
            {/* 3D Viewport Area */}
            <div className="relative min-h-0 flex-1">
              {viewMode === "compare" && optimizeResult ? (
                <div className="flex h-full flex-col">
                  <div className="relative flex flex-1">
                    {/* Left viewport: original design */}
                    <div className="relative flex-1 border-r border-line">
                      <ViewportBadge tone="danger">Original Design • High Vibration</ViewportBadge>
                      <ErrorBoundary fallbackTitle="Original Viewport Recovery">
                        <SceneRoot sharedMaxAmp={sharedMaxAmp} />
                      </ErrorBoundary>
                    </div>

                    {/* Right viewport: optimized candidate */}
                    <div className="relative flex-1">
                      <ViewportBadge tone="ok">
                        Optimized #{activeCandidate?.rank ?? 1} •{" "}
                        {activeCandidate?.reduction_pct
                          ? `−${activeCandidate.reduction_pct.toFixed(0)}% Vibration`
                          : "Tuned Mounts"}
                      </ViewportBadge>
                      <ErrorBoundary fallbackTitle="Optimized Viewport Recovery">
                        <SceneRoot
                          customDesign={
                            activeCandidate?.design ??
                            optimizeResult.candidates[0].design
                          }
                          customAnalysis={candSim}
                          isCompareSecondary={true}
                          sharedMaxAmp={sharedMaxAmp}
                        />
                      </ErrorBoundary>
                    </div>
                  </div>

                  {/* Compare metrics strip */}
                  <ComparePanel />
                </div>
              ) : (
                <ErrorBoundary fallbackTitle="3D Viewport Recovery">
                  <SceneRoot />
                </ErrorBoundary>
              )}

              {/* Focus mode indicator */}
              {isFocusMode && (
                <div className="absolute top-3 left-1/2 -translate-x-1/2 z-30 flex items-center gap-2 rounded-full border border-line bg-surface/90 px-3 py-1 text-xs text-muted shadow-sm backdrop-blur-xs font-mono">
                  <span>Focus mode active</span>
                  <span className="text-[10px] text-ink-2 bg-panel px-1 rounded border border-line">Press F to exit</span>
                </div>
              )}

              {/* Progress and Solver Loading Overlay */}
              {(isAnalyzing || isOptimizing) && (
                <LoadingOverlay
                  isOptimizing={isOptimizing}
                  message={
                    isOptimizing
                      ? "Evaluating mount stiffness and damping..."
                      : "Simulating harmonic response..."
                  }
                />
              )}
            </div>

            {/* Bottom: Diagnostics / Plots strip */}
            <BottomTabs />
          </div>

          {/* Right Dock: Findings | Copilot | Details */}
          <RightDock />
        </div>

        {/* Dialog Modals */}
        <PresetGalleryModal />
        <AddComponentModal />
        <ValidationModal />
      </div>
    </PerfOverlay>
  );
}
