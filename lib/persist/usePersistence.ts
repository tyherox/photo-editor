"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useDoc, useAssetCache, useWorkspace } from "@/lib/doc/DocContext";
import { saveProject, saveWorkspace } from "./projectStore";

export type SaveStatus = "idle" | "saving" | "saved" | "error";

const DEBOUNCE_MS = 800;

// Debounced auto-save of the active canvas to IndexedDB, plus persistence of the
// workspace (which tabs are open + which is active). Must be used inside a
// DocProvider. Saves the active doc ~800ms after edits settle; also exposes
// `saveNow` for an explicit Save button.
//
// `seedByProject` maps projectId → assetIds already known to be in IndexedDB
// (the projects we just restored), so their bitmaps aren't needlessly
// re-encoded on the first save. Assets of freshly-created docs aren't in the
// seed, so they ARE written.
export function usePersistence(seedByProject?: Record<string, string[]>): {
  status: SaveStatus;
  saveNow: () => void;
  markPersisted: (projectId: string, assetIds: string[]) => void;
} {
  const doc = useDoc();
  const cache = useAssetCache();
  const { tabs, activeId } = useWorkspace();
  const [status, setStatus] = useState<SaveStatus>("idle");

  // One persisted-assetId set per project, lazily created, seeded from restore.
  const persistedByProject = useRef<Map<string, Set<string>>>(
    new Map(Object.entries(seedByProject ?? {}).map(([id, ids]) => [id, new Set(ids)]))
  );
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savingRef = useRef(false); // a save is in flight
  const dirtyRef = useRef(false); // doc changed while a save was in flight
  const docRef = useRef(doc);

  useEffect(() => {
    docRef.current = doc;
  }, [doc]);

  const persistedFor = (id: string): Set<string> => {
    let set = persistedByProject.current.get(id);
    if (!set) {
      set = new Set();
      persistedByProject.current.set(id, set);
    }
    return set;
  };

  const flush = useCallback(async () => {
    if (savingRef.current) {
      dirtyRef.current = true; // coalesce: re-run after the current save finishes
      return;
    }
    savingRef.current = true;
    setStatus("saving");
    try {
      do {
        dirtyRef.current = false;
        const d = docRef.current;
        await saveProject(d, cache, persistedFor(d.id), Date.now());
      } while (dirtyRef.current);
      setStatus("saved");
    } catch {
      setStatus("error");
    } finally {
      savingRef.current = false;
    }
  }, [cache]);

  // Debounce: any active-doc change schedules a save.
  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(flush, DEBOUNCE_MS);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [doc, flush]);

  // Persist the open-tab set + active tab whenever it changes (cheap, tiny).
  // `openKey` is a stable dep so this only fires on real open/close/switch.
  const openKey = tabs.map((t) => t.id).join(",");
  useEffect(() => {
    const openIds = openKey ? openKey.split(",") : [];
    void saveWorkspace(openIds, activeId);
  }, [openKey, activeId]);

  const saveNow = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    void flush();
  }, [flush]);

  // Mark a project's assets as already in IndexedDB (e.g. one just opened from
  // the library) so the next save doesn't needlessly re-encode them.
  const markPersisted = useCallback((projectId: string, assetIds: string[]) => {
    let set = persistedByProject.current.get(projectId);
    if (!set) {
      set = new Set();
      persistedByProject.current.set(projectId, set);
    }
    for (const id of assetIds) set.add(id);
  }, []);

  return { status, saveNow, markPersisted };
}
