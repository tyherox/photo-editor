// A workspace is a set of open document tabs, each with its OWN undo history,
// and exactly one active tab. It wraps the single-document history machine
// (lib/doc/history.ts): every HISTORY_* action is routed to the active tab's
// HistoryState, so undo/redo/coalescing are unchanged and fully per-tab. Tab
// actions (open/close/activate/reorder) manage which docs are open and which is
// active. The AssetCache that backs raster layers is shared across all tabs
// (assetIds are globally unique), so tabs cost only their cheap Doc snapshots.

import type { Doc } from "./types";
import {
  historyReducer,
  initHistory,
  type HistoryAction,
  type HistoryState,
} from "./history";

export interface WorkspaceState {
  activeId: string;
  order: string[]; // tab order, left → right; also the source of truth for "which are open"
  tabs: Record<string, HistoryState>;
}

export type TabAction =
  | { type: "TAB_OPEN"; doc: Doc; activate?: boolean }
  | { type: "TAB_CLOSE"; id: string }
  | { type: "TAB_ACTIVATE"; id: string }
  | { type: "TAB_REORDER"; order: string[] };

export type WorkspaceAction = HistoryAction | TabAction;

export interface InitialTab {
  doc: Doc;
  assetIds?: string[];
}

export function initWorkspace(initialTabs: InitialTab[], activeId?: string): WorkspaceState {
  const order: string[] = [];
  const tabs: Record<string, HistoryState> = {};
  for (const t of initialTabs) {
    order.push(t.doc.id);
    tabs[t.doc.id] = initHistory(t.doc);
  }
  const active = activeId && tabs[activeId] ? activeId : order[0];
  return { activeId: active, order, tabs };
}

function isTabAction(action: WorkspaceAction): action is TabAction {
  return (
    action.type === "TAB_OPEN" ||
    action.type === "TAB_CLOSE" ||
    action.type === "TAB_ACTIVATE" ||
    action.type === "TAB_REORDER"
  );
}

export function workspaceReducer(state: WorkspaceState, action: WorkspaceAction): WorkspaceState {
  if (isTabAction(action)) {
    switch (action.type) {
      case "TAB_OPEN": {
        const id = action.doc.id;
        // Re-opening an already-open doc just focuses it (don't clobber its history).
        if (state.tabs[id]) {
          return action.activate === false ? state : { ...state, activeId: id };
        }
        const tabs = { ...state.tabs, [id]: initHistory(action.doc) };
        const order = [...state.order, id];
        return { tabs, order, activeId: action.activate === false ? state.activeId : id };
      }

      case "TAB_CLOSE": {
        if (!state.tabs[action.id]) return state;
        const idx = state.order.indexOf(action.id);
        const order = state.order.filter((x) => x !== action.id);
        const tabs = { ...state.tabs };
        delete tabs[action.id];
        // Caller is expected to unmount the provider before reaching 0 tabs; if it
        // doesn't, keep state coherent by leaving activeId pointing at "".
        let activeId = state.activeId;
        if (activeId === action.id) {
          const neighbor = order[idx] ?? order[idx - 1] ?? order[0] ?? "";
          activeId = neighbor;
        }
        return { tabs, order, activeId };
      }

      case "TAB_ACTIVATE": {
        if (!state.tabs[action.id] || action.id === state.activeId) return state;
        return { ...state, activeId: action.id };
      }

      case "TAB_REORDER": {
        // Accept only a permutation of the current open ids.
        const same =
          action.order.length === state.order.length &&
          action.order.every((id) => state.tabs[id]);
        return same ? { ...state, order: action.order } : state;
      }
    }
  }

  // History action → route to the active tab's history.
  const active = state.tabs[state.activeId];
  if (!active) return state;
  const nextHistory = historyReducer(active, action);
  if (nextHistory === active) return state;
  return { ...state, tabs: { ...state.tabs, [state.activeId]: nextHistory } };
}
