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
  type AiEditRecipe,
  type AreaAnnotation,
  type AssetBitmap,
  type Doc,
  type ShapeKind,
} from "@/lib/doc/types";
import { hasVisibleContent, renderDocToCanvas, renderLayersToCanvas } from "@/lib/doc/render";
import { aiEditCanvas } from "@/lib/doc/aiEditDoc";
import { cropRegions, editMaskedRegionPatches, reservedBBox, type AreaBackend } from "@/lib/doc/maskEdit";
import { editRegionWithContextPatches } from "@/lib/doc/contextEdit";
import { assemblePrompt } from "@/lib/doc/promptAssembly";
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
import PromptPreviewModal from "@/components/PromptPreviewModal";
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

const btn = "rounded-md px-2.5 py-1.5 text-sm text-zinc-300 transition-colors hover:bg-zinc-800 hover:text-white disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-zinc-300";

const MODES: { id: EditorMode; label: string; title: string }[] = [
  { id: "view", label: "View", title: "View mode — measure distances and areas; no edits" },
  { id: "manual", label: "Manual", title: "Manual mode — add and arrange images, text, and shapes" },
  { id: "ai", label: "AI", title: "AI mode — mask a region or describe a whole-image edit" },
];

function snapshotCanvas(src: HTMLCanvasElement): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = src.width;
  c.height = src.height;
  c.getContext("2d")!.drawImage(src, 0, 0);
  return c;
}

// Draw a cached bitmap (HTMLImageElement | ImageBitmap) onto a fresh canvas at
// its natural size — so it can be re-sent to the model as a reprompt input.
function bitmapToCanvas(bmp: AssetBitmap): HTMLCanvasElement {
  const w = bmp instanceof HTMLImageElement ? bmp.naturalWidth : bmp.width;
  const h = bmp instanceof HTMLImageElement ? bmp.naturalHeight : bmp.height;
  const c = document.createElement("canvas");
  c.width = Math.max(1, w);
  c.height = Math.max(1, h);
  c.getContext("2d")!.drawImage(bmp, 0, 0);
  return c;
}

// The doc-space bounding box a raster layer occupies, ignoring rotation/flip —
// AI-edit layers are placed axis-aligned (scale 1), so this is exact for them.
function rasterBBox(transform: { x: number; y: number; scaleX: number; scaleY: number }, w: number, h: number) {
  return { x: transform.x, y: transform.y, w: w * Math.abs(transform.scaleX), h: h * Math.abs(transform.scaleY) };
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
  // Advanced: when on, every Gemini edit first shows the fully-assembled prompt in
  // an editable preview so nothing is sent unseen. Persisted across sessions.
  const [advancedPrompt, setAdvancedPrompt] = useState(false);
  // Open prompt-preview request: holds the assembled text and a resolver that the
  // modal calls with the (possibly edited) text, or null if the user cancels.
  const [promptDraft, setPromptDraft] = useState<{
    text: string;
    resolve: (final: string | null) => void;
  } | null>(null);
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
    setAdvancedPrompt(localStorage.getItem("ai-advanced-prompt") === "1");
  }, []);

  // Resolve a pending prompt preview, if any (e.g. when the toggle flips off).
  const toggleAdvancedPrompt = useCallback(() => {
    setAdvancedPrompt((v) => {
      const next = !v;
      try {
        localStorage.setItem("ai-advanced-prompt", next ? "1" : "0");
      } catch {
        /* storage unavailable — preference just won't persist */
      }
      return next;
    });
  }, []);

  // Gate a Gemini edit on the advanced preview. When off, resolves immediately
  // with the assembled text; when on, opens the editable modal and resolves with
  // the user's confirmed text, or null if they cancel.
  const confirmPrompt = useCallback(
    (assembled: string): Promise<string | null> => {
      if (!advancedPrompt) return Promise.resolve(assembled);
      return new Promise((resolve) => setPromptDraft({ text: assembled, resolve }));
    },
    [advancedPrompt]
  );

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

  // Decode a canvas into the AssetCache as a fresh asset, returning its id. Used
  // both for finished patches and for reprompt input snapshots.
  const cacheCanvasAsset = useCallback(
    async (canvas: HTMLCanvasElement): Promise<string> => {
      const img = await base64ToImage(imageToBase64(canvas));
      const assetId = newId();
      cache.set(assetId, img);
      return assetId;
    },
    [cache]
  );

  // Commit a finished generation. With `replaceLayerId`, swap that layer's bitmap
  // in place (a reprompt of an existing AI-edit layer). Otherwise each patch (one
  // per masked region) becomes a new raster layer at its bbox — concurrency-safe
  // and non-occluding. The recipe (set for single-result Gemini edits) is stamped
  // onto the layer so it can be reprompted later.
  const onPatches = useCallback(
    async (patches: PatchResult[], meta?: { recipe?: AiEditRecipe; replaceLayerId?: string }) => {
      if (meta?.replaceLayerId && patches.length) {
        const { patch } = patches[0];
        const assetId = await cacheCanvasAsset(patch);
        doAction({
          type: "LAYER_REPLACE_RASTER",
          id: meta.replaceLayerId,
          assetId,
          naturalWidth: patch.width,
          naturalHeight: patch.height,
          aiEdit: meta.recipe,
        });
        setSelectedIds([meta.replaceLayerId]);
        return;
      }
      // A recipe only describes a single result, so attach it only when this
      // generation produced exactly one patch (full-image or single region).
      const recipe = patches.length === 1 ? meta?.recipe : undefined;
      let lastId: string | null = null;
      for (const { bbox, patch } of patches) {
        const assetId = await cacheCanvasAsset(patch);
        const layer = makeRasterLayer(
          assetId,
          patch.width,
          patch.height,
          { x: bbox.x, y: bbox.y, scaleX: 1, scaleY: 1, rotation: 0 },
          "AI edit",
          recipe ? { ...recipe, bbox } : undefined
        );
        doAction({ type: "LAYER_ADD", layer });
        lastId = layer.id;
      }
      if (lastId) setSelectedIds([lastId]);
    },
    [cacheCanvasAsset, doAction]
  );

  const { jobs, reservations, launch, cancel, accept, reject, retry, edit, unfreeze, overlapsReserved } = useAiJobs(
    doc.id,
    tabs.map((t) => t.id),
    onPatches
  );

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

  // Switching tabs (doc.id change) must not drag this doc's transient overlays
  // into the next one — the live mask, selection, split tool, and error banner are
  // all shared EditorBody state. Reset them as the active doc changes, using a
  // render-phase update (the codebase's setState-in-effect-free idiom). AI
  // jobs/reservations are already scoped per-doc inside useAiJobs.
  const [maskDocId, setMaskDocId] = useState(doc.id);
  if (maskDocId !== doc.id) {
    setMaskDocId(doc.id);
    setMaskDirty(false);
    setCropBoxes([]);
    setSelectedIds([]);
    setSelectedAnnotationId(null);
    setSplit(null);
    setError(null);
  }

  // The mask is one shared canvas element (reused across tabs), so clear its
  // pixels imperatively when the active doc changes.
  useEffect(() => {
    const m = maskCanvasRef.current;
    m?.getContext("2d")?.clearRect(0, 0, m.width, m.height);
  }, [doc.id]);

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
    async (backend: AreaBackend) => {
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
      const ref = backend === "gemini" ? referenceImage || undefined : undefined;
      // Default Gemini masked edit is context-aware (whole-image awareness, only
      // the masked pixels written back); "Isolated" uses the crop path, now with
      // the selection mask attached so the model edits only the marked shape.
      const useContext = backend === "gemini" && !isolated;
      // Assemble the exact instruction, then (when Advanced is on) let the user
      // review/edit it before anything is sent. Local "Remove" needs no prompt.
      let finalPrompt = "";
      if (backend === "gemini") {
        const assembled = assemblePrompt({
          flow: useContext ? "context" : "isolated",
          userPrompt: p,
          hasReference: !!ref,
          maskAware: !useContext,
        });
        const confirmed = await confirmPrompt(assembled);
        if (confirmed === null) return; // user cancelled the preview
        finalPrompt = confirmed;
        recordPrompt(p);
      }
      // Recipe (Gemini only): snapshot the model's input region — the bbox crop of
      // the flattened scene — so an accepted region layer can be reprompted later.
      // A local "Remove" has no prompt, so it isn't repromptable.
      let recipe: AiEditRecipe | undefined;
      if (backend === "gemini") {
        const flat = renderDocToCanvas(doc, cache);
        const crop = document.createElement("canvas");
        crop.width = Math.max(1, Math.round(bbox.w));
        crop.height = Math.max(1, Math.round(bbox.h));
        crop.getContext("2d")!.drawImage(flat, bbox.x, bbox.y, bbox.w, bbox.h, 0, 0, crop.width, crop.height);
        const sourceAssetId = await cacheCanvasAsset(crop);
        recipe = { prompt: p, sourceAssetId, bbox, referenceImage: ref };
      }
      const id = launch({
        backend,
        prompt: p || (backend === "local" ? "Remove" : ""),
        bbox,
        freeze: freezeArmed,
        recipe,
        run: ({ signal, onProgress }) =>
          useContext
            ? editRegionWithContextPatches(doc, cache, snap, { finalPrompt, referenceImage: ref, signal })
            : editMaskedRegionPatches(doc, cache, snap, { backend, finalPrompt, referenceImage: ref, signal, onProgress }),
      });
      if (id) clearMask();
    },
    [doc, cache, prompt, maskDirty, freezeArmed, isolated, referenceImage, launch, overlapsReserved, clearMask, recordPrompt, cacheCanvasAsset, confirmPrompt]
  );

  // "Edit" a reviewed result with a DIFFERENT instruction: re-edit the just-
  // generated patch(es) (input = the generated image, not the original) and put
  // the new result back into the same review overlay. Chains indefinitely; the
  // replace-in-place target (if any) is preserved by the scheduler.
  const editResult = useCallback(
    async (jobId: string, newPrompt: string) => {
      const p = newPrompt.trim();
      if (!p) return;
      const job = jobs.find((j) => j.id === jobId);
      if (!job?.result) return;
      const patches = job.result; // captured now — edit() clears job.result
      const ref = job.recipe?.referenceImage;
      let recipe: AiEditRecipe | undefined;
      if (patches.length === 1) {
        const sourceAssetId = await cacheCanvasAsset(patches[0].patch);
        recipe = { prompt: p, sourceAssetId, bbox: patches[0].bbox, referenceImage: ref };
      }
      recordPrompt(p);
      edit(jobId, {
        prompt: p,
        recipe,
        run: ({ signal }) =>
          Promise.all(patches.map(async (pt) => ({ bbox: pt.bbox, patch: await aiEditCanvas(pt.patch, p, signal, ref) }))),
      });
    },
    [jobs, edit, cacheCanvasAsset, recordPrompt]
  );

  // Reprompt an accepted AI-edit layer. "edit" applies a new instruction to the
  // layer's CURRENT bitmap; "retry" re-rolls the ORIGINAL instruction against the
  // snapshotted original input. Either way the result replaces the layer in place
  // after review (same id/position/order).
  const repromptLayer = useCallback(
    async (layerId: string, mode: "edit" | "retry", newPrompt?: string) => {
      const layer = doc.layers.find((l) => l.id === layerId);
      if (!layer || layer.type !== "raster" || !layer.aiEdit) return;
      if (!localStorage.getItem("gemini-api-key")) {
        setSettingsOpen(true);
        return;
      }
      const prev = layer.aiEdit;
      // Target where the layer sits NOW (it may have been moved since accept) so
      // the review preview lines up and the replacement lands in place.
      const bbox = rasterBBox(layer.transform, layer.naturalWidth, layer.naturalHeight);
      if (overlapsReserved(bbox)) {
        setError("That region overlaps one that's already generating or frozen.");
        return;
      }
      const ref = prev.referenceImage;
      let srcCanvas: HTMLCanvasElement;
      let promptToUse: string;
      let recipe: AiEditRecipe;
      if (mode === "retry") {
        const bmp = cache.get(prev.sourceAssetId);
        if (!bmp) {
          setError("The original input for this edit is no longer available.");
          return;
        }
        srcCanvas = bitmapToCanvas(bmp);
        promptToUse = prev.prompt;
        recipe = prev; // re-roll the same ask against the same input
      } else {
        const p = (newPrompt ?? "").trim();
        if (!p) return;
        const bmp = cache.get(layer.assetId);
        if (!bmp) {
          setError("This layer's image is no longer available.");
          return;
        }
        srcCanvas = bitmapToCanvas(bmp);
        promptToUse = p;
        const sourceAssetId = await cacheCanvasAsset(srcCanvas);
        recipe = { prompt: p, sourceAssetId, bbox, referenceImage: ref };
      }
      recordPrompt(promptToUse);
      launch({
        backend: "gemini",
        prompt: promptToUse,
        bbox,
        freeze: false,
        replaceLayerId: layerId,
        recipe,
        run: ({ signal }) => aiEditCanvas(srcCanvas, promptToUse, signal, ref).then((c) => [{ bbox, patch: c }]),
      });
    },
    [doc.layers, cache, launch, overlapsReserved, recordPrompt, cacheCanvasAsset]
  );

  const generateFull = useCallback(async () => {
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
    const ref = referenceImage || undefined;
    // Assemble + (when Advanced is on) let the user review/edit before sending.
    const assembled = assemblePrompt({ flow: "full", userPrompt: p, hasReference: !!ref });
    const finalPrompt = await confirmPrompt(assembled);
    if (finalPrompt === null) return; // user cancelled the preview
    recordPrompt(p);
    // Snapshot the exact input the model sees (the flattened doc) so the result
    // layer can be reprompted (Retry re-rolls against this snapshot).
    const flat = renderDocToCanvas(doc, cache);
    const sourceAssetId = await cacheCanvasAsset(flat);
    launch({
      backend: "gemini",
      prompt: p,
      bbox,
      freeze: false,
      recipe: { prompt: p, sourceAssetId, bbox, referenceImage: ref },
      run: ({ signal }) => aiEditCanvas(flat, finalPrompt, signal, ref, true).then((c) => [{ bbox, patch: c }]),
    });
  }, [doc, cache, prompt, referenceImage, launch, overlapsReserved, recordPrompt, cacheCanvasAsset, confirmPrompt]);

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
      if (!typing && (e.key === "Delete" || e.key === "Backspace")) {
        if (activeIds.length) {
          e.preventDefault();
          activeIds.forEach((id) => doAction({ type: "LAYER_DELETE", id }));
          setSelectedIds([]);
        } else if (selectedAnnotationId) {
          e.preventDefault();
          doAction({ type: "ANNOTATION_DELETE", id: selectedAnnotationId });
          setSelectedAnnotationId(null);
        }
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undo, redo, download, doAction, activeIds, selectedAnnotationId, group, ungroup]);

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

        <div className="ml-auto flex items-center gap-1">
          <button className={btn} onClick={undo} disabled={!canUndo} title="Undo (⌘Z)">Undo</button>
          <button className={btn} onClick={redo} disabled={!canRedo} title="Redo (⌘⇧Z)">Redo</button>
          <button className={btn} onClick={download} title="Download PNG (⌘S)">Download</button>
          <button className={`${btn} flex items-center`} onClick={() => setSettingsOpen(true)} title="Settings" aria-label="Settings">
            <svg className="h-[18px] w-[18px]" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.324.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 011.37.49l1.296 2.247a1.125 1.125 0 01-.26 1.431l-1.003.827c-.293.24-.438.613-.431.992a6.759 6.759 0 010 .255c-.007.378.138.75.43.99l1.005.828c.424.35.534.954.26 1.43l-1.298 2.247a1.125 1.125 0 01-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.57 6.57 0 01-.22.128c-.331.183-.581.495-.644.869l-.213 1.28c-.09.543-.56.941-1.11.941h-2.594c-.55 0-1.02-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 01-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 01-1.369-.49l-1.297-2.247a1.125 1.125 0 01.26-1.431l1.004-.827c.292-.24.437-.613.43-.992a6.932 6.932 0 010-.255c.007-.378-.138-.75-.43-.99l-1.004-.828a1.125 1.125 0 01-.26-1.43l1.297-2.247a1.125 1.125 0 011.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.087.22-.128.332-.183.582-.495.644-.869l.214-1.281z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
          </button>
        </div>
      </header>

      {error && (
        <div className="animate-overlay mx-3 mt-2 flex items-start gap-2 rounded-lg border border-red-700 bg-red-900/50 px-3 py-2 text-sm text-red-300">
          <svg className="mt-0.5 h-4 w-4 flex-shrink-0 text-red-400" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
          </svg>
          <span className="flex-1">{error}</span>
          <button onClick={() => setError(null)} className="flex-shrink-0 rounded p-0.5 text-red-400 transition-colors hover:text-red-200" aria-label="Dismiss error">
            <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
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
            onEditResult={editResult}
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
          onRepromptLayer={(id, p) => void repromptLayer(id, "edit", p)}
          onRetryLayer={(id) => void repromptLayer(id, "retry")}
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

      <div className="flex flex-wrap items-center gap-1 border-t border-zinc-800 bg-zinc-900 px-3 py-2">
        <div className="flex overflow-hidden rounded-md border border-zinc-700">
          {MODES.map((m) => (
            <button
              key={m.id}
              onClick={() => setMode(m.id)}
              title={m.title}
              className={`px-3 py-1.5 text-sm transition-colors ${mode === m.id ? "bg-zinc-700 text-white" : "text-zinc-400 hover:bg-zinc-800 hover:text-white"}`}
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
            <button className={btn} onClick={() => fileInputRef.current?.click()} title="Place an image onto the canvas">Image</button>
            <button className={btn} onClick={addText} title="Add a text layer">Text</button>
            <button className={btn} onClick={() => addShape("rect")} title="Add a rectangle">Rect</button>
            <button className={btn} onClick={() => addShape("ellipse")} title="Add an ellipse">Ellipse</button>
            <button className={btn} onClick={() => addShape("line")} title="Add a line">Line</button>
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
                title="Mask a rectangular region (drag on the canvas)"
                className={`px-2.5 py-1.5 text-sm transition-colors ${maskTool === "rect" ? "bg-zinc-700 text-white" : "text-zinc-400 hover:bg-zinc-800 hover:text-white"}`}
              >
                Rect
              </button>
              <button
                onClick={() => setMaskTool("brush")}
                title="Paint a freeform mask (adjust size with the slider)"
                className={`px-2.5 py-1.5 text-sm transition-colors ${maskTool === "brush" ? "bg-zinc-700 text-white" : "text-zinc-400 hover:bg-zinc-800 hover:text-white"}`}
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
                className={`px-2.5 py-1.5 text-sm transition-colors ${!isolated ? "bg-zinc-700 text-white" : "text-zinc-400 hover:bg-zinc-800 hover:text-white"}`}
                title="In context — the model sees the whole image and edits only the masked region, so the result matches the scene's lighting, color, and perspective"
              >
                In context
              </button>
              <button
                onClick={() => setIsolated(true)}
                className={`px-2.5 py-1.5 text-sm transition-colors ${isolated ? "bg-zinc-700 text-white" : "text-zinc-400 hover:bg-zinc-800 hover:text-white"}`}
                title="Isolated — the model sees only the masked crop. Maximum detail, but blind to the rest of the scene. Best for removal and small fixes."
              >
                Isolated
              </button>
            </div>
            <span className="mx-1 h-5 w-px bg-zinc-700" />
            <button
              className={`${btn} ${advancedPrompt ? "bg-zinc-800 text-white" : ""}`}
              onClick={toggleAdvancedPrompt}
              title="Advanced — review and edit the exact prompt (including blending/region guidance) before each AI edit is sent"
            >
              Advanced
            </button>
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
                title="Ruler — drag to measure a distance"
                className={`px-2.5 py-1.5 text-sm transition-colors ${measureTool === "ruler" ? "bg-zinc-700 text-white" : "text-zinc-400 hover:bg-zinc-800 hover:text-white"}`}
              >
                Ruler
              </button>
              <button
                onClick={() => setMeasureTool("area")}
                title="Area — drag to measure a rectangular region"
                className={`px-2.5 py-1.5 text-sm transition-colors ${measureTool === "area" ? "bg-zinc-700 text-white" : "text-zinc-400 hover:bg-zinc-800 hover:text-white"}`}
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
                  <svg className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24" aria-hidden="true">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M16.5 10.5V6.75a4.5 4.5 0 10-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 002.25-2.25v-6.75a2.25 2.25 0 00-2.25-2.25H6.75a2.25 2.25 0 00-2.25 2.25v6.75a2.25 2.25 0 002.25 2.25z" />
                  </svg>
                  Frozen
                  <button onClick={() => unfreeze(r.id)} className="text-blue-300 transition-colors hover:text-white" title="Unfreeze">unlock</button>
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

          {promptDraft && (
            <PromptPreviewModal
              initialPrompt={promptDraft.text}
              onConfirm={(final) => {
                promptDraft.resolve(final);
                setPromptDraft(null);
              }}
              onCancel={() => {
                promptDraft.resolve(null);
                setPromptDraft(null);
              }}
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
      <div className="flex h-full flex-col items-center justify-center gap-3 bg-zinc-950 p-6">
        <svg className="h-5 w-5 animate-spin text-zinc-600" fill="none" viewBox="0 0 24 24" aria-hidden="true">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-90" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
        <span className="text-sm text-zinc-500">Loading your workspace…</span>
      </div>
    );
  }

  if (!boot) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-6 bg-zinc-950 p-6">
        <div className="flex flex-col items-center gap-1.5">
          <h1 className="text-2xl font-semibold tracking-tight text-white">Photo Editor</h1>
          <p className="text-sm text-zinc-500">AI-powered layer editing, right in your browser</p>
        </div>
        <div className="flex w-full max-w-md flex-col items-center gap-4">
          <button
            onClick={() => setShowNew(true)}
            className="w-full rounded-lg bg-blue-600 px-4 py-3 text-sm font-medium text-white transition-colors hover:bg-blue-500"
          >
            New blank document
          </button>
          {hasProjects && (
            <button
              onClick={() => setShowOpen(true)}
              className="w-full rounded-lg border border-zinc-700 px-4 py-2.5 text-sm font-medium text-zinc-200 transition-colors hover:border-zinc-600 hover:bg-zinc-900"
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
