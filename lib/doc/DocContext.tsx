"use client";

import { createContext, useContext, useMemo, useReducer, type ReactNode } from "react";
import type { Doc } from "./types";
import type { DocAction } from "./reducer";
import type { AssetCache } from "./assetCache";
import {
  initWorkspace,
  workspaceReducer,
  type InitialTab,
  type WorkspaceAction,
  type WorkspaceState,
} from "./workspace";

interface DocContextValue {
  state: WorkspaceState;
  dispatch: React.Dispatch<WorkspaceAction>;
  cache: AssetCache;
  onEmpty?: () => void;
  // Convenience wrappers around dispatch (operate on the ACTIVE tab).
  doAction: (action: DocAction, coalesce?: boolean) => void;
  commit: () => void;
  undo: () => void;
  redo: () => void;
}

const Ctx = createContext<DocContextValue | null>(null);

export function DocProvider({
  initialTabs,
  initialActiveId,
  cache,
  onEmpty,
  children,
}: {
  initialTabs: InitialTab[];
  initialActiveId?: string;
  cache: AssetCache;
  onEmpty?: () => void;
  children: ReactNode;
}) {
  const [state, dispatch] = useReducer(
    workspaceReducer,
    undefined,
    () => initWorkspace(initialTabs, initialActiveId)
  );

  const value = useMemo<DocContextValue>(
    () => ({
      state,
      dispatch,
      cache,
      onEmpty,
      doAction: (action, coalesce) => dispatch({ type: "HISTORY_DO", action, coalesce }),
      commit: () => dispatch({ type: "HISTORY_COMMIT" }),
      undo: () => dispatch({ type: "HISTORY_UNDO" }),
      redo: () => dispatch({ type: "HISTORY_REDO" }),
    }),
    [state, cache, onEmpty]
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

function useCtx(): DocContextValue {
  const v = useContext(Ctx);
  if (!v) throw new Error("useDoc* must be used within a DocProvider");
  return v;
}

function useActiveHistory() {
  const { state } = useCtx();
  return state.tabs[state.activeId];
}

// The active tab's current document.
export function useDoc(): Doc {
  return useActiveHistory().present;
}

export function useDocActions() {
  const { doAction, commit, undo, redo } = useCtx();
  return { doAction, commit, undo, redo };
}

export function useAssetCache(): AssetCache {
  return useCtx().cache;
}

export function useCanUndoRedo(): { canUndo: boolean; canRedo: boolean } {
  const h = useActiveHistory();
  return {
    canUndo: h.past.length > 0 || h.pendingBase !== null,
    canRedo: h.future.length > 0,
  };
}

// --- Tabs ------------------------------------------------------------------

export interface TabInfo {
  id: string;
  name: string;
}

export function useWorkspace(): {
  tabs: TabInfo[];
  activeId: string;
  openTab: (doc: Doc, activate?: boolean) => void;
  closeTab: (id: string) => void;
  activateTab: (id: string) => void;
  isOpen: (id: string) => boolean;
} {
  const { state, dispatch, onEmpty } = useCtx();
  const tabs = useMemo<TabInfo[]>(
    () => state.order.map((id) => ({ id, name: state.tabs[id].present.name })),
    [state.order, state.tabs]
  );

  return {
    tabs,
    activeId: state.activeId,
    openTab: (doc, activate) => dispatch({ type: "TAB_OPEN", doc, activate }),
    closeTab: (id) => {
      // Closing the last open tab empties the workspace — let the host (EditorShell)
      // unmount the provider and return to the start screen instead.
      if (state.order.length <= 1 && state.order[0] === id) {
        onEmpty?.();
        return;
      }
      dispatch({ type: "TAB_CLOSE", id });
    },
    activateTab: (id) => dispatch({ type: "TAB_ACTIVATE", id }),
    isOpen: (id) => Boolean(state.tabs[id]),
  };
}
