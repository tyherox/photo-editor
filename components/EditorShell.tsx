"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AssetCache } from "@/lib/doc/assetCache";
import { DocProvider, useAssetCache, useCanUndoRedo, useDoc, useDocActions, useWorkspace } from "@/lib/doc/DocContext";
import type { InitialTab } from "@/lib/doc/workspace";
import { docFromImageFile } from "@/lib/doc/docFromImage";
import {
  defaultTransform,
  makeRasterLayer,
  makeShapeLayer,
  makeTextLayer,
  newId,
  type AreaAnnotation,
  type Doc,
  type ShapeKind,
} from "@/lib/doc/types";
import { hasVisibleContent, renderDocToCanvas, renderLayersToCanvas } from "@/lib/doc/render";
import { aiEditFullDocument } from "@/lib/doc/aiEditDoc";
import { cropRegions, editMaskedRegionPatches, reservedBBox, type AreaBackend } from "@/lib/doc/maskEdit";
import { editRegionWithContextPatches } from "@/lib/doc/contextEdit";
import { splitRasterLayer } from "@/lib/doc/splitLayer";
import type { BBox } from "@/lib/crop-inpaint-stitch";
import { useAiJobs, type PatchResult } from "@/lib/doc/useAiJobs";
import { loadImageToCanvas, imageToBase64, base64ToImage } from "@/lib/canvas-utils";
import Stage, { type EditorMode } from "@/components/layers/Stage";
import LayersPanel from "@/components/layers/LayersPanel";
import NewDocumentDialog from "@/components/layers/NewDocumentDialog";
import SettingsDialog from "@/components/SettingsDialog";
import ImageUpload from "@/components/ImageUpload";
import ReferenceCropModal from "@/components/ReferenceCropModal";
import TabBar from "@/components/layers/TabBar";
import ProjectsDialog from "@/components/ProjectsDialog";
import { usePersistence } from "@/lib/persist/usePersistence";
import {
  deleteProject,
  listProjects,
  loadLastProject,
  loadProject,
  loadWorkspace,
  saveWorkspace,
} from "@/lib/persist/projectStore";

const btn = "rounded-md px-2.5 py-1.5 text-sm text-zinc-300 hover:bg-zinc-800 hover:text-white disabled:opacity-40 disabled:hover:bg-transparent";

const MODES: { id: EditorMode; label: string }[] = [
  { id: "view", label: "View" },
  { id: "manual", label: "Manual" },
  { id: "ai", label: "AI" },
];

function snapshotCanvas(src: HTMLCanvasElement): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = src.width;
  c.height = src.height;
  c.getContext("2d")!.drawImage(src, 0, 0);
  return c;
}

function EditorBody({ seedByProject }: { seedByProject?: Record<string, string[]> }) {
  const doc = useDoc();
  const cache = useAssetCache();
  const { doAction, undo, redo } = useDocActions();
  const { canUndo, canRedo } = useCanUndoRedo();
  const { tabs, openTab, activateTab, isOpen } = useWorkspace();
  const { status: saveStatus, saveNow, markPersisted } = usePersistence(seedByProject);
  const [showNew, setShowNew] = useState(false);
  const [showOpen, setShowOpen] = useState(false);

  // Open a new canvas from an image file (sized to the image).
  const newFromImage = useCallback(
    async (file: File) => {
      const { doc: d } = await docFromImageFile(file, cache);
      openTab(d);
    },
    [cache, openTab]
  );

  // Open a saved project as a tab (focus it if already open).
  const openExisting = useCallback(
    async (id: string) => {
      if (isOpen(id)) {
        activateTab(id);
        return;
      }
      const r = await loadProject(id, cache);
      if (r) {
        markPersisted(r.doc.id, r.assetIds); // already in IDB — don't re-encode
        openTab(r.doc);
      }
    },
    [cache, isOpen, activateTab, markPersisted, openTab]
  );

  const [mode, setMode] = useState<EditorMode>("manual");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [maskTool, setMaskTool] = useState<"brush" | "rect">("rect");
  const [brushSize, setBrushSize] = useState(40);
  const [snapEnabled, setSnapEnabled] = useState(true);
  const [gridEnabled, setGridEnabled] = useState(false);
  const [gridDivisions, setGridDivisions] = useState(10);
  const [measureTool, setMeasureTool] = useState<"ruler" | "area">("ruler");
  const [selectedAnnotationId, setSelectedAnnotationId] = useState<string | null>(null);
  const [split, setSplit] = useState<{ layerId: string; axis: "x" | "y"; cuts: number[] } | null>(null);
  const [maskDirty, setMaskDirty] = useState(false);
  const [cropBoxes, setCropBoxes] = useState<BBox[]>([]);
  const [freezeArmed, setFreezeArmed] = useState(false);
  // Masked Gemini edits are context-aware by default (the model sees the whole
  // scene); "isolated" opts into the legacy crop-only path for max-detail fixes.
  const [isolated, setIsolated] = useState(false);
  const [referenceImage, setReferenceImage] = useState<string | null>(null);
  const [referencePreview, setReferencePreview] = useState<string | null>(null);
  const [refOriginalDataUrl, setRefOriginalDataUrl] = useState<string | null>(null);
  const [cropModalDataUrl, setCropModalDataUrl] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const refInputRef = useRef<HTMLInputElement>(null);
  const maskCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const promptInputRef = useRef<HTMLInputElement>(null);
  // Recent prompts (most-recent first) for ↑/↓ recall, persisted across sessions.
  // Kept in a ref (never rendered) — avoids hydration concerns and re-renders.
  const promptHistory = useRef<string[]>([]);
  const histIdx = useRef(-1); // -1 = editing a fresh draft, ≥0 = recalled entry

  useEffect(() => {
    try {
      const h = JSON.parse(localStorage.getItem("ai-prompt-history") || "[]");
      if (Array.isArray(h)) promptHistory.current = h.filter((s) => typeof s === "string");
    } catch {
      /* no/corrupt history — start empty */
    }
  }, []);

  // Push a used prompt to the front (deduped), cap the list, and persist.
  const recordPrompt = useCallback((p: string) => {
    const t = p.trim();
    if (!t) return;
    promptHistory.current = [t, ...promptHistory.current.filter((x) => x !== t)].slice(0, 25);
    histIdx.current = -1;
    try {
      localStorage.setItem("ai-prompt-history", JSON.stringify(promptHistory.current));
    } catch {
      /* storage full / unavailable — recall just won't persist */
    }
  }, []);

  function handleReferenceUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setCropModalDataUrl(reader.result as string);
    reader.readAsDataURL(file);
    e.target.value = "";
  }

  function handleCropConfirm(croppedBase64: string) {
    setReferenceImage(croppedBase64);
    setReferencePreview(`data:image/png;base64,${croppedBase64}`);
    if (cropModalDataUrl && !refOriginalDataUrl) setRefOriginalDataUrl(cropModalDataUrl);
    setCropModalDataUrl(null);
  }

  function clearReference() {
    setReferenceImage(null);
    setReferencePreview(null);
    setRefOriginalDataUrl(null);
  }

  // Each finished AI patch (one per masked region) becomes a new raster layer at
  // its bbox — concurrency-safe and non-occluding.
  const onPatches = useCallback(
    async (patches: PatchResult[]) => {
      let lastId: string | null = null;
      for (const { bbox, patch } of patches) {
        const img = await base64ToImage(imageToBase64(patch));
        const assetId = newId();
        cache.set(assetId, img);
        const layer = makeRasterLayer(
          assetId,
          patch.width,
          patch.height,
          { x: bbox.x, y: bbox.y, scaleX: 1, scaleY: 1, rotation: 0 },
          "AI edit"
        );
        doAction({ type: "LAYER_ADD", layer });
        lastId = layer.id;
      }
      if (lastId) setSelectedIds([lastId]);
    },
    [cache, doAction]
  );

  const { jobs, reservations, launch, cancel, accept, reject, retry, unfreeze, overlapsReserved } = useAiJobs(onPatches);

  // Results awaiting review, as doc-space preview items for the Stage overlay.
  // The data-URL encoding is done once in the hook (stable refs), so this is a
  // cheap render-time derivation.
  const pendingResults = jobs
    .filter((j) => j.status === "review" && j.resultSrcs)
    .map((j) => ({ id: j.id, items: j.resultSrcs! }));

  const clearMask = useCallback(() => {
    const m = maskCanvasRef.current;
    m?.getContext("2d")?.clearRect(0, 0, m.width, m.height);
    setMaskDirty(false);
    setCropBoxes([]);
  }, []);

  // Recompute the visible "impact area" boxes from the current mask after a paint.
  const onMaskPaint = useCallback(() => {
    setMaskDirty(true);
    const m = maskCanvasRef.current;
    if (m) setCropBoxes(cropRegions(m));
  }, []);

  // Effective selection: drop ids that no longer exist (e.g. after undo) without
  // a setState-in-effect; consumers read `activeIds`.
  const activeIds = selectedIds.filter((id) => doc.layers.some((l) => l.id === id));

  // Select a layer; clicking a grouped layer selects its whole group. Additive
  // (shift/⌘) toggles that layer/group in or out of the current selection.
  const select = useCallback(
    (id: string | null, additive = false) => {
      if (id === null) {
        setSelectedIds([]);
        return;
      }
      const layer = doc.layers.find((l) => l.id === id);
      const members = layer?.groupId ? doc.layers.filter((l) => l.groupId === layer.groupId).map((l) => l.id) : [id];
      setSelectedIds((prev) => {
        if (!additive) return members;
        const set = new Set(prev);
        const allIn = members.every((m) => set.has(m));
        members.forEach((m) => (allIn ? set.delete(m) : set.add(m)));
        return [...set];
      });
    },
    [doc.layers]
  );

  const group = useCallback(() => {
    if (activeIds.length < 2) return;
    doAction({ type: "LAYER_GROUP", ids: activeIds, groupId: newId() });
  }, [activeIds, doAction]);

  const ungroup = useCallback(() => {
    const gids = new Set(
      activeIds.map((id) => doc.layers.find((l) => l.id === id)?.groupId).filter((g): g is string => !!g)
    );
    gids.forEach((g) => doAction({ type: "LAYER_UNGROUP", groupId: g }));
  }, [activeIds, doc.layers, doAction]);

  // Are all selected layers part of a single group (→ can Ungroup)?
  const selectedGroupId = (() => {
    if (!activeIds.length) return null;
    const g = doc.layers.find((l) => l.id === activeIds[0])?.groupId;
    if (!g) return null;
    return activeIds.every((id) => doc.layers.find((l) => l.id === id)?.groupId === g) ? g : null;
  })();

  const selectedArea = (doc.annotations ?? []).find(
    (a): a is AreaAnnotation => a.id === selectedAnnotationId && a.type === "area"
  );

  const addImage = useCallback(
    async (file: File) => {
      const { img } = await loadImageToCanvas(file);
      const assetId = newId();
      cache.set(assetId, img);
      const fit = Math.min(1, (doc.width * 0.8) / img.naturalWidth, (doc.height * 0.8) / img.naturalHeight);
      const x = (doc.width - img.naturalWidth * fit) / 2;
      const y = (doc.height - img.naturalHeight * fit) / 2;
      const layer = makeRasterLayer(assetId, img.naturalWidth, img.naturalHeight, { x, y, scaleX: fit, scaleY: fit, rotation: 0 }, file.name);
      doAction({ type: "LAYER_ADD", layer });
      setSelectedIds([layer.id]);
    },
    [cache, doc.width, doc.height, doAction]
  );

  const addText = useCallback(() => {
    const layer = makeTextLayer("Text", defaultTransform(doc.width * 0.12, doc.height * 0.42));
    doAction({ type: "LAYER_ADD", layer });
    setSelectedIds([layer.id]);
  }, [doc.width, doc.height, doAction]);

  const addShape = useCallback(
    (shape: ShapeKind) => {
      const w = 300;
      const h = shape === "line" ? 0 : 200;
      const layer = makeShapeLayer(shape, defaultTransform((doc.width - w) / 2, (doc.height - (h || 4)) / 2));
      doAction({ type: "LAYER_ADD", layer });
      setSelectedIds([layer.id]);
    },
    [doc.width, doc.height, doAction]
  );

  const download = useCallback(() => {
    const canvas = renderDocToCanvas(doc, cache);
    const a = document.createElement("a");
    a.download = `${doc.name || "export"}.png`;
    a.href = canvas.toDataURL("image/png");
    a.click();
  }, [doc, cache]);

  // Export one or more layers as PNG (transparent) or JPEG (white-matted),
  // cropped to their combined bounding box. Multiple layers flatten into one
  // image (a group exported as one). `ids` are composited in doc z-order.
  const exportLayers = useCallback(
    (ids: string[], format: "png" | "jpeg") => {
      const layers = doc.layers.filter((l) => ids.includes(l.id)); // doc order = back→front
      if (!layers.length) return;
      const rendered = renderLayersToCanvas(layers, cache);
      let out = rendered;
      if (format === "jpeg") {
        // JPEG has no alpha — flatten onto white so transparent edges aren't black.
        const c2 = document.createElement("canvas");
        c2.width = rendered.width;
        c2.height = rendered.height;
        const cx = c2.getContext("2d")!;
        cx.fillStyle = "#ffffff";
        cx.fillRect(0, 0, c2.width, c2.height);
        cx.drawImage(rendered, 0, 0);
        out = c2;
      }
      const base = layers.length === 1 ? layers[0].name || "layer" : `${doc.name || "export"}-group`;
      const safe = base.replace(/[^\w.-]+/g, "_") || "layer";
      const a = document.createElement("a");
      a.download = `${safe}.${format === "jpeg" ? "jpg" : "png"}`;
      a.href = format === "jpeg" ? out.toDataURL("image/jpeg", 0.92) : out.toDataURL("image/png");
      a.click();
    },
    [doc.layers, doc.name, cache]
  );

  // --- Interactive split: position cut lines on a raster layer, then apply ---
  const startSplit = useCallback(
    (axis: "x" | "y") => {
      const l = activeIds.length === 1 ? doc.layers.find((x) => x.id === activeIds[0]) : undefined;
      if (l?.type !== "raster") return;
      const dim = axis === "x" ? l.naturalWidth : l.naturalHeight;
      setSplit({ layerId: l.id, axis, cuts: [Math.round(dim / 2)] });
    },
    [doc.layers, activeIds]
  );

  const addCut = useCallback(() => {
    if (!split) return;
    const l = doc.layers.find((x) => x.id === split.layerId);
    if (l?.type !== "raster") return;
    const dim = split.axis === "x" ? l.naturalWidth : l.naturalHeight;
    const edges = [0, ...[...split.cuts].sort((a, b) => a - b), dim];
    // Add a cut in the middle of the widest current segment.
    let bestMid = dim / 2;
    let bestGap = -1;
    for (let i = 0; i < edges.length - 1; i++) {
      const gap = edges[i + 1] - edges[i];
      if (gap > bestGap) {
        bestGap = gap;
        bestMid = (edges[i] + edges[i + 1]) / 2;
      }
    }
    setSplit({ ...split, cuts: [...split.cuts, Math.round(bestMid)] });
  }, [split, doc.layers]);

  const applySplit = useCallback(async () => {
    if (!split) return;
    const l = doc.layers.find((x) => x.id === split.layerId);
    if (l?.type === "raster") {
      const slices = await splitRasterLayer(l, cache, split.axis, split.cuts);
      if (slices.length > 1) {
        doAction({ type: "LAYER_SPLIT", id: l.id, newLayers: slices });
        setSelectedIds([slices[0].id]);
      }
    }
    setSplit(null);
  }, [split, doc.layers, cache, doAction]);

  // Area generation → a non-blocking job. Frees the live mask so the next region
  // can be painted immediately; the job keeps its own snapshot.
  const generateArea = useCallback(
    (backend: AreaBackend) => {
      const mask = maskCanvasRef.current;
      if (!mask || !maskDirty) return;
      if (backend === "gemini") {
        if (!prompt.trim()) return;
        if (!localStorage.getItem("gemini-api-key")) {
          setSettingsOpen(true);
          return;
        }
      }
      const bbox = reservedBBox(mask);
      if (!bbox) return;
      if (overlapsReserved(bbox)) {
        setError("That region overlaps one that's already generating or frozen.");
        return;
      }
      const snap = snapshotCanvas(mask);
      const p = prompt.trim();
      if (backend === "gemini") recordPrompt(p);
      const ref = backend === "gemini" ? referenceImage || undefined : undefined;
      // Default Gemini masked edit is context-aware (whole-image awareness, only
      // the masked pixels written back); "Isolated" uses the legacy crop path.
      const useContext = backend === "gemini" && !isolated;
      const id = launch({
        backend,
        prompt: p || (backend === "local" ? "Remove" : ""),
        bbox,
        freeze: freezeArmed,
        run: ({ signal, onProgress }) =>
          useContext
            ? editRegionWithContextPatches(doc, cache, snap, { prompt: p, referenceImage: ref, signal })
            : editMaskedRegionPatches(doc, cache, snap, { backend, prompt: p, referenceImage: ref, signal, onProgress }),
      });
      if (id) clearMask();
    },
    [doc, cache, prompt, maskDirty, freezeArmed, isolated, referenceImage, launch, overlapsReserved, clearMask, recordPrompt]
  );

  const generateFull = useCallback(() => {
    if (!prompt.trim() || !hasVisibleContent(doc)) return;
    if (!localStorage.getItem("gemini-api-key")) {
      setSettingsOpen(true);
      return;
    }
    const bbox = { x: 0, y: 0, w: doc.width, h: doc.height };
    if (overlapsReserved(bbox)) {
      setError("Finish or cancel the active region edits first.");
      return;
    }
    const p = prompt.trim();
    recordPrompt(p);
    const ref = referenceImage || undefined;
    launch({
      backend: "gemini",
      prompt: p,
      bbox,
      freeze: false,
      run: async ({ signal }) => {
        const img = await aiEditFullDocument(doc, cache, p, signal, ref);
        const c = document.createElement("canvas");
        c.width = doc.width;
        c.height = doc.height;
        c.getContext("2d")!.drawImage(img, 0, 0, doc.width, doc.height);
        return [{ bbox, patch: c }];
      },
    });
  }, [doc, cache, prompt, referenceImage, launch, overlapsReserved, recordPrompt]);

  // Keyboard shortcuts.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const t = e.target as HTMLElement | null;
      const typing = t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
      const mod = e.metaKey || e.ctrlKey;
      if (e.key === "Escape") {
        setSelectedIds([]);
        return;
      }
      if (mod && (e.key === "g" || e.key === "G")) {
        e.preventDefault();
        if (e.shiftKey) ungroup();
        else group();
        return;
      }
      if (mod && (e.key === "z" || e.key === "Z")) {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
        return;
      }
      if (mod && (e.key === "s" || e.key === "S")) {
        e.preventDefault();
        download();
        return;
      }
      if (!typing && (e.key === "Delete" || e.key === "Backspace") && activeIds.length) {
        e.preventDefault();
        activeIds.forEach((id) => doAction({ type: "LAYER_DELETE", id }));
        setSelectedIds([]);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undo, redo, download, doAction, activeIds, group, ungroup]);

  const running = jobs.filter((j) => j.status === "running").length;
  const queued = jobs.filter((j) => j.status === "queued").length;
  const frozen = reservations.filter((r) => r.kind === "frozen");

  return (
    <div className="flex h-full flex-col bg-zinc-950">
      <TabBar onNew={() => setShowNew(true)} />
      <header className="flex flex-wrap items-center gap-1 border-b border-zinc-800 bg-zinc-900 px-3 py-2">
        <span className="mr-2 text-sm font-semibold tracking-wide text-white">Photo Editor</span>
        <button className={btn} onClick={() => setShowNew(true)}>New</button>
        <button className={btn} onClick={() => setShowOpen(true)}>Open</button>
        <button className={btn} onClick={saveNow}>Save</button>
        <span className="w-16 text-xs text-zinc-500" aria-live="polite">
          {saveStatus === "saving"
            ? "Saving…"
            : saveStatus === "saved"
              ? "Saved"
              : saveStatus === "error"
                ? "Save failed"
                : ""}
        </span>

        <div className="ml-1 flex overflow-hidden rounded-md border border-zinc-700">
          {MODES.map((m) => (
            <button
              key={m.id}
              onClick={() => setMode(m.id)}
              className={`px-3 py-1.5 text-sm ${mode === m.id ? "bg-zinc-700 text-white" : "text-zinc-400 hover:text-white"}`}
            >
              {m.label}
            </button>
          ))}
        </div>

        <span className="mx-1 h-5 w-px bg-zinc-700" />

        {mode === "manual" && (
          <>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) addImage(f);
                e.target.value = "";
              }}
            />
            <button className={btn} onClick={() => fileInputRef.current?.click()}>Image</button>
            <button className={btn} onClick={addText}>Text</button>
            <button className={btn} onClick={() => addShape("rect")}>Rect</button>
            <button className={btn} onClick={() => addShape("ellipse")}>Ellipse</button>
            <button className={btn} onClick={() => addShape("line")}>Line</button>
            <span className="mx-1 h-5 w-px bg-zinc-700" />
            <button
              className={`${btn} ${snapEnabled ? "bg-zinc-800 text-white" : ""}`}
              onClick={() => setSnapEnabled((v) => !v)}
              title="Snap to other elements, guides, and measurements (hold Alt to bypass)"
            >
              Snap
            </button>
            <button
              className={`${btn} ${gridEnabled ? "bg-zinc-800 text-white" : ""}`}
              onClick={() => setGridEnabled((v) => !v)}
              title="Show & snap to a pixel grid"
            >
              Grid
            </button>
            {gridEnabled && (
              <input
                type="number"
                min={1}
                value={gridDivisions}
                onChange={(e) => setGridDivisions(Math.max(1, Math.round(Number(e.target.value))))}
                className="w-14 rounded bg-zinc-800 px-1.5 py-1 text-sm text-white"
                title="Grid divisions (cells per axis)"
              />
            )}
          </>
        )}

        {mode === "ai" && (
          <>
            <div className="flex overflow-hidden rounded-md border border-zinc-700">
              <button
                onClick={() => setMaskTool("rect")}
                className={`px-2.5 py-1.5 text-sm ${maskTool === "rect" ? "bg-zinc-700 text-white" : "text-zinc-400 hover:text-white"}`}
              >
                Rect
              </button>
              <button
                onClick={() => setMaskTool("brush")}
                className={`px-2.5 py-1.5 text-sm ${maskTool === "brush" ? "bg-zinc-700 text-white" : "text-zinc-400 hover:text-white"}`}
              >
                Brush
              </button>
            </div>
            {maskTool === "brush" && (
              <input
                type="range"
                min={5}
                max={150}
                value={brushSize}
                onChange={(e) => setBrushSize(Number(e.target.value))}
                className="w-24"
                title="Brush size"
              />
            )}
            <button className={btn} onClick={clearMask} disabled={!maskDirty}>Clear</button>
            <button
              className={`${btn} ${freezeArmed ? "bg-blue-900/50 text-blue-200" : ""}`}
              onClick={() => setFreezeArmed((v) => !v)}
              title="Freeze a region after generating (blocks further AI edits there until unfrozen)"
            >
              Freeze
            </button>
            <span className="mx-1 h-5 w-px bg-zinc-700" />
            <div
              className="flex overflow-hidden rounded-md border border-zinc-700"
              title="How a masked AI edit sees the image"
            >
              <button
                onClick={() => setIsolated(false)}
                className={`px-2.5 py-1.5 text-sm ${!isolated ? "bg-zinc-700 text-white" : "text-zinc-400 hover:text-white"}`}
                title="In context — the model sees the whole image and edits only the masked region, so the result matches the scene's lighting, color, and perspective"
              >
                In context
              </button>
              <button
                onClick={() => setIsolated(true)}
                className={`px-2.5 py-1.5 text-sm ${isolated ? "bg-zinc-700 text-white" : "text-zinc-400 hover:text-white"}`}
                title="Isolated — the model sees only the masked crop. Maximum detail, but blind to the rest of the scene. Best for removal and small fixes."
              >
                Isolated
              </button>
            </div>
            {running + queued > 0 && (
              <span className="text-xs text-zinc-400">
                {running} generating{queued ? ` · ${queued} queued` : ""}
              </span>
            )}
          </>
        )}

        {mode === "view" && (
          <>
            <div className="flex overflow-hidden rounded-md border border-zinc-700">
              <button
                onClick={() => setMeasureTool("ruler")}
                className={`px-2.5 py-1.5 text-sm ${measureTool === "ruler" ? "bg-zinc-700 text-white" : "text-zinc-400 hover:text-white"}`}
              >
                Ruler
              </button>
              <button
                onClick={() => setMeasureTool("area")}
                className={`px-2.5 py-1.5 text-sm ${measureTool === "area" ? "bg-zinc-700 text-white" : "text-zinc-400 hover:text-white"}`}
              >
                Area
              </button>
            </div>
            {selectedArea ? (
              <>
                <span className="text-xs text-zinc-500">Split</span>
                <div className="flex overflow-hidden rounded border border-zinc-700">
                  {(["none", "x", "y"] as const).map((ax) => (
                    <button
                      key={ax}
                      onClick={() =>
                        doAction({
                          type: "ANNOTATION_UPDATE",
                          id: selectedArea.id,
                          patch: { splitAxis: ax, splitCount: ax === "none" ? 1 : Math.max(2, selectedArea.splitCount) },
                        })
                      }
                      className={`px-2 py-1 text-sm ${selectedArea.splitAxis === ax ? "bg-zinc-700 text-white" : "text-zinc-400 hover:text-white"}`}
                    >
                      {ax === "none" ? "None" : ax === "x" ? "Cols" : "Rows"}
                    </button>
                  ))}
                </div>
                {selectedArea.splitAxis !== "none" && (
                  <input
                    type="number"
                    min={2}
                    value={selectedArea.splitCount}
                    onChange={(e) =>
                      doAction({ type: "ANNOTATION_UPDATE", id: selectedArea.id, patch: { splitCount: Math.max(2, Number(e.target.value)) } })
                    }
                    className="w-14 rounded bg-zinc-800 px-1.5 py-1 text-sm text-white"
                    title="Number of sections"
                  />
                )}
              </>
            ) : (
              <span className="text-xs text-zinc-500">Drag to measure · Space to pan</span>
            )}
            {(doc.annotations?.length ?? 0) > 0 && (
              <button
                className={btn}
                onClick={() => {
                  doAction({ type: "ANNOTATION_CLEAR" });
                  setSelectedAnnotationId(null);
                }}
              >
                Clear
              </button>
            )}
          </>
        )}

        <div className="ml-auto flex items-center gap-1">
          <button className={btn} onClick={undo} disabled={!canUndo} title="Undo (⌘Z)">Undo</button>
          <button className={btn} onClick={redo} disabled={!canRedo} title="Redo (⌘⇧Z)">Redo</button>
          <button className={btn} onClick={download} title="Download PNG (⌘S)">Download</button>
          <button className={btn} onClick={() => setSettingsOpen(true)} title="Settings">⚙</button>
        </div>
      </header>

      {error && (
        <div className="mx-3 mt-2 rounded-lg border border-red-700 bg-red-900/50 px-3 py-2 text-sm text-red-300">
          {error}
          <button onClick={() => setError(null)} className="ml-2 text-red-400 hover:text-red-200">Dismiss</button>
        </div>
      )}

      <div className="relative flex min-h-0 flex-1">
        <div className="min-w-0 flex-1">
          <Stage
            selectedIds={activeIds}
            onSelect={select}
            mode={mode}
            maskTool={maskTool}
            brushSize={brushSize}
            maskCanvasRef={maskCanvasRef}
            onMaskPaint={onMaskPaint}
            reservations={reservations}
            cropBoxes={cropBoxes}
            pendingResults={pendingResults}
            onAcceptResult={accept}
            onRejectResult={reject}
            onRetryResult={retry}
            snapEnabled={snapEnabled}
            gridEnabled={gridEnabled}
            gridDivisions={gridDivisions}
            measureTool={measureTool}
            selectedAnnotationId={selectedAnnotationId}
            onSelectAnnotation={setSelectedAnnotationId}
            split={split}
            onSplitCuts={(cuts) => setSplit((s) => (s ? { ...s, cuts } : s))}
          />
        </div>
        <LayersPanel
          selectedIds={activeIds}
          onSelect={select}
          onStartSplit={startSplit}
          onExportLayers={exportLayers}
          onGroup={group}
          onUngroup={ungroup}
          canGroup={activeIds.length >= 2}
          canUngroup={!!selectedGroupId}
        />

        {split && (
          <div className="absolute left-1/2 top-3 z-40 flex -translate-x-1/2 items-center gap-2 rounded-lg border border-zinc-700 bg-zinc-900/95 px-3 py-2 text-sm text-zinc-300 shadow-xl backdrop-blur">
            <span className="text-xs text-zinc-400">
              Drag the {split.axis === "x" ? "vertical" : "horizontal"} line{split.cuts.length > 1 ? "s" : ""} · {split.cuts.length + 1} pieces
            </span>
            <button onClick={addCut} className="rounded bg-zinc-800 px-2 py-1 hover:bg-zinc-700">+ Cut</button>
            <button onClick={applySplit} className="rounded bg-blue-600 px-3 py-1 font-medium text-white hover:bg-blue-500">Apply</button>
            <button onClick={() => setSplit(null)} className="rounded px-2 py-1 text-zinc-400 hover:text-white">Cancel</button>
          </div>
        )}
      </div>

      {mode === "ai" && (
        <div className="border-t border-zinc-800 bg-zinc-900 px-3 py-3">
          {(jobs.length > 0 || frozen.length > 0) && (
            <div className="mb-2 flex flex-wrap gap-1.5">
              {jobs.map((j) => (
                <span
                  key={j.id}
                  className={`flex items-center gap-1.5 rounded px-2 py-1 text-xs ${
                    j.status === "error" ? "bg-red-900/50 text-red-300" : "bg-zinc-800 text-zinc-300"
                  }`}
                >
                  {j.status === "error"
                    ? `Error: ${j.error}`
                    : j.status === "queued"
                      ? "Queued"
                      : j.status === "review"
                        ? "Reviewing — accept on canvas"
                        : j.progress || "Generating…"}
                  {j.status === "review" ? (
                    <button onClick={() => reject(j.id)} className="text-zinc-500 hover:text-white" title="Reject">✕</button>
                  ) : (
                    <button onClick={() => cancel(j.id)} className="text-zinc-500 hover:text-white" title="Cancel">✕</button>
                  )}
                </span>
              ))}
              {frozen.map((r) => (
                <span key={r.id} className="flex items-center gap-1.5 rounded bg-blue-900/40 px-2 py-1 text-xs text-blue-200">
                  🔒 Frozen
                  <button onClick={() => unfreeze(r.id)} className="text-blue-300 hover:text-white" title="Unfreeze">unlock</button>
                </span>
              ))}
            </div>
          )}

          {!prompt.trim() && (
            <div className="mb-2 flex flex-wrap gap-1.5">
              {(maskDirty
                ? ["change the color", "improve the lighting", "replace it with something else"]
                : ["enhance the colors", "make it more vivid", "give it a cinematic look"]
              ).map((s) => (
                <button
                  key={s}
                  onClick={() => {
                    setPrompt(s);
                    histIdx.current = -1;
                    promptInputRef.current?.focus();
                  }}
                  className="rounded-full border border-zinc-700 px-3 py-1 text-xs text-zinc-400 transition-colors hover:border-zinc-500 hover:text-zinc-200"
                >
                  {s}
                </button>
              ))}
            </div>
          )}

          <div className="flex items-center gap-2">
            {maskDirty && <span className="rounded bg-red-900/50 px-2 py-1 text-xs text-red-300 whitespace-nowrap">Mask ready</span>}
            <input
              ref={refInputRef}
              type="file"
              accept="image/*"
              onChange={handleReferenceUpload}
              className="hidden"
            />
            {referencePreview ? (
              <div className="group relative flex flex-shrink-0 items-center gap-1">
                <button
                  onClick={() => refOriginalDataUrl && setCropModalDataUrl(refOriginalDataUrl)}
                  className="relative"
                  title="Re-crop reference"
                >
                  <img
                    src={referencePreview}
                    alt="Reference"
                    className="h-10 w-10 rounded-md border-2 border-purple-500 object-cover"
                  />
                  <div className="absolute inset-0 rounded-md bg-black/40 opacity-0 transition-opacity group-hover:opacity-100" />
                  <div className="absolute -bottom-1 -right-1 flex h-4 w-4 items-center justify-center rounded-full border border-zinc-900 bg-purple-500">
                    <svg className="h-2.5 w-2.5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7V5a2 2 0 012-2h2m10 0h2a2 2 0 012 2v2m0 10v2a2 2 0 01-2 2h-2M7 21H5a2 2 0 01-2-2v-2" />
                    </svg>
                  </div>
                </button>
                <button
                  onClick={clearReference}
                  className="p-0.5 text-zinc-500 transition-colors hover:text-red-400"
                  title="Remove reference"
                >
                  <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
            ) : (
              <button
                onClick={() => refInputRef.current?.click()}
                className="flex-shrink-0 rounded-lg border border-zinc-700 p-2.5 text-zinc-400 transition-colors hover:border-purple-500 hover:text-purple-400"
                title="Add reference image"
              >
                <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M2.25 15.75l5.159-5.159a2.25 2.25 0 013.182 0l5.159 5.159m-1.5-1.5l1.409-1.409a2.25 2.25 0 013.182 0l2.909 2.909M3.75 21h16.5A2.25 2.25 0 0022.5 18.75V5.25A2.25 2.25 0 0020.25 3H3.75A2.25 2.25 0 001.5 5.25v13.5A2.25 2.25 0 003.75 21z" />
                </svg>
              </button>
            )}
            <input
              ref={promptInputRef}
              type="text"
              value={prompt}
              onChange={(e) => {
                histIdx.current = -1; // editing a fresh draft, leave recall mode
                setPrompt(e.target.value);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  if (maskDirty) generateArea("gemini");
                  else generateFull();
                  return;
                }
                // ↑/↓ recall recent prompts (like a shell history).
                const h = promptHistory.current;
                if (e.key === "ArrowUp" && h.length) {
                  e.preventDefault();
                  histIdx.current = Math.min(histIdx.current + 1, h.length - 1);
                  setPrompt(h[histIdx.current]);
                } else if (e.key === "ArrowDown" && histIdx.current >= 0) {
                  e.preventDefault();
                  histIdx.current -= 1;
                  setPrompt(histIdx.current < 0 ? "" : h[histIdx.current]);
                }
              }}
              placeholder={
                maskDirty
                  ? isolated
                    ? "Describe the edit for the masked region (isolated)…"
                    : "Describe the edit for the masked region (in context)…"
                  : "Brush a region, or describe a whole-image edit…"
              }
              className="min-w-[12rem] flex-1 rounded-lg border border-zinc-700 bg-zinc-800 px-4 py-2.5 text-sm text-white placeholder:text-zinc-500 focus:border-blue-500 focus:outline-none"
            />
            {maskDirty && (
              <button
                onClick={() => generateArea("local")}
                title="Remove the masked content (on-device, no prompt needed)"
                className="whitespace-nowrap rounded-lg bg-green-700 px-4 py-2.5 text-sm font-medium text-white hover:bg-green-600"
              >
                Remove
              </button>
            )}
            {maskDirty ? (
              <button
                onClick={() => generateArea("gemini")}
                disabled={!prompt.trim()}
                title={
                  isolated
                    ? "Edit the masked region in isolation (model sees only the crop)"
                    : "Edit the masked region with whole-image context (only masked pixels change)"
                }
                className="whitespace-nowrap rounded-lg bg-purple-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-purple-500 disabled:opacity-40"
              >
                Generate
              </button>
            ) : (
              <button
                onClick={generateFull}
                disabled={!prompt.trim() || !hasVisibleContent(doc)}
                title="Edit the whole image"
                className="whitespace-nowrap rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-40"
              >
                Generate
              </button>
            )}
          </div>

          {cropModalDataUrl && (
            <ReferenceCropModal
              imageDataUrl={cropModalDataUrl}
              onConfirm={handleCropConfirm}
              onCancel={() => setCropModalDataUrl(null)}
            />
          )}
        </div>
      )}

      <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />

      {showNew && (
        <NewDocumentDialog
          onCreate={(d) => {
            openTab(d);
            setShowNew(false);
          }}
          onCreateFromImage={async (f) => {
            await newFromImage(f);
            setShowNew(false);
          }}
          onCancel={() => setShowNew(false)}
        />
      )}

      {showOpen && (
        <ProjectsDialog
          openIds={tabs.map((t) => t.id)}
          onOpen={(id) => {
            void openExisting(id);
            setShowOpen(false);
          }}
          onDelete={(id) => deleteProject(id)}
          onNewBlank={() => {
            setShowOpen(false);
            setShowNew(true);
          }}
          onNewFromImage={async (f) => {
            await newFromImage(f);
            setShowOpen(false);
          }}
          onClose={() => setShowOpen(false)}
        />
      )}
    </div>
  );
}

interface BootState {
  tabs: InitialTab[];
  activeId: string;
  seed: Record<string, string[]>; // projectId → assetIds already in IndexedDB
}

export default function EditorShell() {
  // Lazy state initializer so the cache is created exactly once, before any doc.
  const [cache] = useState(() => new AssetCache());

  // `boot` null + not restoring => the start screen. Once set, the workspace is
  // mounted; live tab open/close/switch is owned by the workspace reducer, and
  // `onEmpty` (last tab closed) returns here by clearing `boot`.
  const [boot, setBoot] = useState<BootState | null>(null);
  const [restoring, setRestoring] = useState(true);
  const [hasProjects, setHasProjects] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [showOpen, setShowOpen] = useState(false);

  // Restore the previous session's open tabs (or, for back-compat, the last
  // project) from IndexedDB before showing anything.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const ws = await loadWorkspace();
        const tabs: InitialTab[] = [];
        const seed: Record<string, string[]> = {};
        for (const id of ws?.openIds ?? []) {
          const r = await loadProject(id, cache);
          if (r) {
            tabs.push({ doc: r.doc, assetIds: r.assetIds });
            seed[r.doc.id] = r.assetIds;
          }
        }
        // Migration only: pre-workspace saves (C.1) had a lastProjectId but no
        // workspace meta. An EXISTING-but-empty workspace means the user closed
        // everything — respect it (start screen), don't resurrect via lastProjectId.
        if (tabs.length === 0 && ws === null) {
          const last = await loadLastProject(cache);
          if (last) {
            tabs.push({ doc: last.doc, assetIds: last.assetIds });
            seed[last.doc.id] = last.assetIds;
          }
        }
        if (cancelled) return;
        if (tabs.length > 0) {
          const activeId =
            ws?.activeId && tabs.some((t) => t.doc.id === ws.activeId) ? ws.activeId : tabs[0].doc.id;
          setBoot({ tabs, activeId, seed });
        }
      } catch {
        /* no/broken saved data — fall through to the start screen */
      } finally {
        if (!cancelled) setRestoring(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [cache]);

  // Keep the start screen's "Open existing" affordance in sync with what's saved
  // (e.g. after closing all tabs, or deleting the last project).
  useEffect(() => {
    if (boot || restoring) return;
    let cancelled = false;
    listProjects().then((p) => {
      if (!cancelled) setHasProjects(p.length > 0);
    });
    return () => {
      cancelled = true;
    };
  }, [boot, restoring]);

  // Closing the last tab empties the workspace → forget the open-tab set so a
  // reload returns to the start screen rather than resurrecting the last tab.
  const handleEmpty = useCallback(() => {
    void saveWorkspace([], "");
    setBoot(null);
  }, []);

  // Start-screen helpers: each creates the first tab and mounts the workspace.
  const startWithBlank = useCallback((d: Doc) => {
    setBoot({ tabs: [{ doc: d, assetIds: [] }], activeId: d.id, seed: {} });
  }, []);

  const startWithImage = useCallback(
    async (file: File) => {
      const { doc, assetIds } = await docFromImageFile(file, cache);
      setBoot({ tabs: [{ doc, assetIds }], activeId: doc.id, seed: {} });
    },
    [cache]
  );

  const startWithExisting = useCallback(
    async (id: string) => {
      const r = await loadProject(id, cache);
      if (r) setBoot({ tabs: [{ doc: r.doc, assetIds: r.assetIds }], activeId: r.doc.id, seed: { [r.doc.id]: r.assetIds } });
    },
    [cache]
  );

  if (restoring) {
    return (
      <div className="flex h-full flex-col items-center justify-center bg-zinc-950 p-6">
        <span className="text-sm text-zinc-500">Loading…</span>
      </div>
    );
  }

  if (!boot) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-6 bg-zinc-950 p-6">
        <h1 className="text-lg font-semibold text-white">Photo Editor</h1>
        <div className="flex w-full max-w-md flex-col items-center gap-4">
          <button
            onClick={() => setShowNew(true)}
            className="w-full rounded-lg bg-blue-600 px-4 py-3 text-sm font-medium text-white hover:bg-blue-500"
          >
            New blank document
          </button>
          {hasProjects && (
            <button
              onClick={() => setShowOpen(true)}
              className="w-full rounded-lg border border-zinc-700 px-4 py-2.5 text-sm font-medium text-zinc-200 hover:border-zinc-600"
            >
              Open existing project
            </button>
          )}
          <div className="text-xs text-zinc-500">or open an image</div>
          <div className="h-64 w-full">
            <ImageUpload onImageLoad={startWithImage} />
          </div>
        </div>
        {showNew && (
          <NewDocumentDialog
            onCreate={(d) => {
              startWithBlank(d);
              setShowNew(false);
            }}
            onCreateFromImage={async (f) => {
              await startWithImage(f);
              setShowNew(false);
            }}
            onCancel={() => setShowNew(false)}
          />
        )}
        {showOpen && (
          <ProjectsDialog
            openIds={[]}
            onOpen={(id) => {
              void startWithExisting(id);
              setShowOpen(false);
            }}
            onDelete={(id) => deleteProject(id)}
            onNewBlank={() => {
              setShowOpen(false);
              setShowNew(true);
            }}
            onNewFromImage={async (f) => {
              await startWithImage(f);
              setShowOpen(false);
            }}
            onClose={() => setShowOpen(false)}
          />
        )}
      </div>
    );
  }

  return (
    <DocProvider
      initialTabs={boot.tabs}
      initialActiveId={boot.activeId}
      cache={cache}
      onEmpty={handleEmpty}
    >
      <EditorBody seedByProject={boot.seed} />
    </DocProvider>
  );
}
