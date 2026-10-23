"use client";

import { create } from "zustand";
import type {
  Design,
  AnalysisResult,
  ResponseAt,
  OptimizeResult,
  OptimizeCandidate,
  Finding,
  AgentMode,
  AgentMessage,
  Component,
} from "@/lib/types/contract";
import { analyze } from "@/lib/api/client";

export type BottomTab = "frf" | "campbell" | "heatmap";
export type RightTab = "findings" | "copilot" | "details";
export type ViewMode = "single" | "compare";
export type CameraPreset = "front" | "top" | "iso" | "fit";

export interface Selection {
  type: "node" | "member" | "component" | "support" | null;
  id: string | null;
}

export interface ProbeInfo {
  nodeId: string;
  xMm: number;
  yMm: number;
  ampMm: number;
  accelG?: number;
}

export interface ToastInfo {
  id: number;
  message: string;
  type?: "info" | "success" | "warning";
}

interface UiState {
  bottomTab: BottomTab;
  viewMode: ViewMode;
  showMesh: boolean;
  showGhost: boolean;
  exaggeration: number;
  animating: boolean;
  isRpmSweeping: boolean;
  agentMode: AgentMode;
  leftSidebarOpen: boolean;
  bottomPanelOpen: boolean;
  rightPanelOpen: boolean;
  rightTab: RightTab;
  isAnalyzing: boolean;
  isOptimizing: boolean;
  isChatting: boolean;
  error: string | null;
  selectedMode: number | null;
  presetPickerOpen: boolean;
  addComponentModalOpen: boolean;
  validationModalOpen: boolean;
  helpPopoverOpen: boolean;
  isFocusMode: boolean;
  hasRunOnce: boolean;
  showGuideBanner?: boolean;
  toast: ToastInfo | null;
}

interface CameraState {
  position: [number, number, number];
  target: [number, number, number];
}

interface Store {
  design: Design | null;
  analysis: AnalysisResult | null;
  responseAt: ResponseAt | null;
  optimizeResult: OptimizeResult | null;
  activeCandidate: OptimizeCandidate | null;
  selection: Selection;
  rpm: number;
  time: number;
  ui: UiState;
  probe: ProbeInfo | null;
  cameraState: CameraState;
  cameraTrigger: { type: CameraPreset; id: number } | null;
  chatMessages: AgentMessage[];
  history: Design[];
  historyIndex: number;

  setDesign: (d: Design | null) => void;
  updateDesign: (fn: (d: Design) => Design) => void;
  setAnalysis: (a: AnalysisResult | null) => void;
  setResponseAt: (r: ResponseAt | null) => void;
  setOptimizeResult: (o: OptimizeResult | null) => void;
  setActiveCandidate: (c: OptimizeCandidate | null) => void;
  setSelection: (s: Selection) => void;
  setRpm: (rpm: number) => void;
  setTime: (t: number) => void;
  setProbe: (probe: ProbeInfo | null) => void;
  setCameraState: (pos: [number, number, number], target: [number, number, number]) => void;
  triggerCameraView: (preset: CameraPreset) => void;
  setUi: (partial: Partial<UiState>) => void;
  toggleFocusMode: () => void;
  addChatMessage: (m: AgentMessage) => void;
  clearChat: () => void;
  pushHistory: (d: Design) => void;
  undo: () => void;
  redo: () => void;
  focusFinding: (f: Finding) => void;
  applyCandidate: (c: OptimizeCandidate) => void;
  deleteComponent: (id: string) => Promise<void>;
  showToast: (message: string, type?: "info" | "success" | "warning") => void;
  clearToast: () => void;
  reset: () => void;
}

const defaultUi: UiState = {
  bottomTab: "frf",
  viewMode: "single",
  showMesh: true,
  showGhost: true,
  exaggeration: 50,
  animating: true,
  isRpmSweeping: false,
  agentMode: "build",
  leftSidebarOpen: true, // Default open in Build state
  bottomPanelOpen: false, // Collapsed to 40px bar by default
  rightPanelOpen: true,
  rightTab: "copilot", // Default Copilot before first Run
  isAnalyzing: false,
  isOptimizing: false,
  isChatting: false,
  error: null,
  selectedMode: null,
  presetPickerOpen: false,
  addComponentModalOpen: false,
  validationModalOpen: false,
  helpPopoverOpen: false,
  isFocusMode: false,
  hasRunOnce: false,
  toast: null,
};

export const useStore = create<Store>((set, get) => ({
  design: null,
  analysis: null,
  responseAt: null,
  optimizeResult: null,
  activeCandidate: null,
  selection: { type: null, id: null },
  rpm: 4200,
  time: 0,
  ui: { ...defaultUi },
  probe: null,
  cameraState: { position: [0.35, 0.25, 0.45], target: [0, 0, 0] },
  cameraTrigger: null,
  chatMessages: [],
  history: [],
  historyIndex: -1,

  setDesign: (d) =>
    set({
      design: d,
      analysis: null,
      responseAt: null,
      optimizeResult: null,
      activeCandidate: null,
    }),

  updateDesign: (fn) => {
    const current = get().design;
    if (!current) return;

    const next = fn(current);
    get().pushHistory(next);

    set({
      design: next,
      analysis: null,
      responseAt: null,
      optimizeResult: null,
      activeCandidate: null,
    });
  },

  setAnalysis: (a) =>
    set((state) => ({
      analysis: a,
      ui: a
        ? {
            ...state.ui,
            hasRunOnce: true,
            leftSidebarOpen: false, // auto-collapse left panel after successful Run
            rightTab: "findings", // default right tab to findings after Run
            rightPanelOpen: true,
          }
        : state.ui,
    })),

  setResponseAt: (r) => set({ responseAt: r }),
  setOptimizeResult: (o) => set({ optimizeResult: o }),
  setActiveCandidate: (c) => set({ activeCandidate: c }),

  setSelection: (s) =>
    set((state) => ({
      selection: s,
      ui: s.type ? { ...state.ui, rightPanelOpen: true, rightTab: "details" } : state.ui,
    })),

  setRpm: (rpm) => set({ rpm }),
  setTime: (t) => set({ time: t }),
  setProbe: (probe) => set({ probe }),

  setCameraState: (position, target) => set({ cameraState: { position, target } }),

  triggerCameraView: (preset) =>
    set({ cameraTrigger: { type: preset, id: Date.now() } }),

  setUi: (partial) =>
    set((state) => ({ ui: { ...state.ui, ...partial } })),

  toggleFocusMode: () => {
    const isFocus = get().ui.isFocusMode;
    if (!isFocus) {
      set((s) => ({
        ui: {
          ...s.ui,
          isFocusMode: true,
          leftSidebarOpen: false,
          rightPanelOpen: false,
          bottomPanelOpen: false,
        },
      }));
    } else {
      set((s) => ({
        ui: {
          ...s.ui,
          isFocusMode: false,
          leftSidebarOpen: !s.ui.hasRunOnce,
          rightPanelOpen: true,
        },
      }));
    }
  },

  addChatMessage: (m) =>
    set((state) => ({ chatMessages: [...state.chatMessages, m] })),

  clearChat: () => set({ chatMessages: [] }),

  pushHistory: (d) => {
    const { history, historyIndex } = get();
    const trimmed = history.slice(0, historyIndex + 1);
    const next = [...trimmed, structuredClone(d)].slice(-30);
    set({ history: next, historyIndex: next.length - 1 });
  },

  undo: () => {
    const { history, historyIndex } = get();
    if (historyIndex <= 0) return;
    const idx = historyIndex - 1;
    set({ design: structuredClone(history[idx]), historyIndex: idx });
  },

  redo: () => {
    const { history, historyIndex } = get();
    if (historyIndex >= history.length - 1) return;
    const idx = historyIndex + 1;
    set({ design: structuredClone(history[idx]), historyIndex: idx });
  },

  focusFinding: (f) => {
    if (f.rpm) set({ rpm: f.rpm });
    if (f.component) {
      set({ selection: { type: "component", id: f.component } });
    }
    if (f.mode != null) {
      set((s) => ({ ui: { ...s.ui, selectedMode: f.mode ?? null } }));
    }
    set((s) => ({
      ui: {
        ...s.ui,
        rightPanelOpen: true,
        rightTab: "findings",
      },
    }));
  },

  applyCandidate: async (c) => {
    get().pushHistory(c.design);
    set((s) => ({
      design: c.design,
      activeCandidate: c,
      ui: {
        ...s.ui,
        isAnalyzing: true,
        viewMode: "single",
        rightPanelOpen: true,
        rightTab: "findings",
      },
    }));

    try {
      const res = await analyze(c.design);
      set((s) => ({
        analysis: res,
        ui: { ...s.ui, hasRunOnce: true },
      }));
      get().showToast(
        `Applied fix: Camera vibration reduced by ${c.reduction_pct.toFixed(0)}%. Safe limits achieved.`,
        "success"
      );
    } catch (err) {
      console.error("[applyCandidate] re-simulation error:", err);
    } finally {
      set((s) => ({ ui: { ...s.ui, isAnalyzing: false } }));
    }
  },

  deleteComponent: async (id: string) => {
    const current = get().design;
    if (!current) return;
    const comp = current.components.find((c) => c.id === id);
    const compName = comp ? `${comp.kind} (${comp.id})` : id;
    const next: Design = {
      ...current,
      components: current.components.filter((c) => c.id !== id),
    };
    get().pushHistory(next);
    const sel = get().selection;
    if (sel.type === "component" && sel.id === id) {
      set({ selection: { type: null, id: null } });
    }
    set({
      design: next,
      analysis: null,
      responseAt: null,
      optimizeResult: null,
      activeCandidate: null,
    });
    get().showToast(`Removed ${compName}. Recalculating...`, "info");

    try {
      set((s) => ({ ui: { ...s.ui, isAnalyzing: true } }));
      const res = await analyze(next);
      set((state) => ({
        analysis: res,
        ui: {
          ...state.ui,
          hasRunOnce: true,
          leftSidebarOpen: false,
          rightTab: "findings",
        },
      }));
    } catch (err) {
      console.error("[deleteComponent] Re-simulation error:", err);
    } finally {
      set((s) => ({ ui: { ...s.ui, isAnalyzing: false } }));
    }
  },

  showToast: (message: string, type = "info") => {
    set((s) => ({
      ui: {
        ...s.ui,
        toast: { id: Date.now(), message, type },
      },
    }));
  },

  clearToast: () => {
    set((s) => ({ ui: { ...s.ui, toast: null } }));
  },

  reset: () =>
    set({
      design: null,
      analysis: null,
      responseAt: null,
      optimizeResult: null,
      activeCandidate: null,
      selection: { type: null, id: null },
      rpm: 4200,
      time: 0,
      ui: { ...defaultUi },
      probe: null,
      cameraTrigger: null,
      chatMessages: [],
      history: [],
      historyIndex: -1,
    }),
}));

export const selectComponentById = (id: string): Component | undefined => {
  const design = useStore.getState().design;
  return design?.components.find((c) => c.id === id);
};
