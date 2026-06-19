import type { Doc } from "./types";
import { docReducer, type DocAction } from "./reducer";

// Undo/redo over the small, serializable Doc. Continuous interactions
// (drag/scale/rotate/slider) coalesce into ONE undo step: the first coalesced
// action snapshots the pre-interaction Doc into `pendingBase`; subsequent
// coalesced actions only move `present`; `HISTORY_COMMIT` (pointer-up) pushes
// that base onto `past`. Discrete edits are one step each.

export interface HistoryState {
  past: Doc[];
  present: Doc;
  future: Doc[];
  pendingBase: Doc | null;
}

export type HistoryAction =
  | { type: "HISTORY_DO"; action: DocAction; coalesce?: boolean }
  | { type: "HISTORY_COMMIT" }
  | { type: "HISTORY_UNDO" }
  | { type: "HISTORY_REDO" };

const MAX_PAST = 50;

function pushPast(past: Doc[], snapshot: Doc): Doc[] {
  const next = past.length >= MAX_PAST ? past.slice(past.length - MAX_PAST + 1) : past.slice();
  next.push(snapshot);
  return next;
}

export function initHistory(doc: Doc): HistoryState {
  return { past: [], present: doc, future: [], pendingBase: null };
}

export function historyReducer(state: HistoryState, action: HistoryAction): HistoryState {
  switch (action.type) {
    case "HISTORY_DO": {
      if (action.coalesce) {
        const pendingBase = state.pendingBase ?? state.present;
        return { ...state, present: docReducer(state.present, action.action), pendingBase };
      }
      // Discrete edit. Defensively commit any dangling interaction as its own
      // step, then snapshot the present before applying the discrete change.
      let past = state.past;
      if (state.pendingBase) past = pushPast(past, state.pendingBase);
      past = pushPast(past, state.present);
      return { past, present: docReducer(state.present, action.action), future: [], pendingBase: null };
    }

    case "HISTORY_COMMIT": {
      if (!state.pendingBase) return state;
      return { past: pushPast(state.past, state.pendingBase), present: state.present, future: [], pendingBase: null };
    }

    case "HISTORY_UNDO": {
      const past = state.pendingBase ? pushPast(state.past, state.pendingBase) : state.past;
      if (past.length === 0) return { ...state, pendingBase: null };
      const previous = past[past.length - 1];
      return {
        past: past.slice(0, -1),
        present: previous,
        future: [state.present, ...state.future],
        pendingBase: null,
      };
    }

    case "HISTORY_REDO": {
      if (state.future.length === 0) return state;
      const [next, ...rest] = state.future;
      return { past: pushPast(state.past, state.present), present: next, future: rest, pendingBase: null };
    }

    default:
      return state;
  }
}
