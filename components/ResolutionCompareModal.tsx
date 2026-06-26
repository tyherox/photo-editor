"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useEscapeKey } from "@/lib/useEscapeKey";
import { compareResolution, loadImageFile, type CompareResult, type CompareSource } from "@/lib/resolution-compare";
import { dragHasFiles, imageFilesFromDataTransfer } from "@/lib/image-import";

interface Props {
  onClose: () => void;
}

type Slot = { file: File; img: HTMLImageElement; url: string };
type Side = "a" | "b";
type Rect = { x: number; y: number; w: number; h: number }; // fractions of the image (0–1)
type SummaryRow = { ai: number; bi: number; nameA: string; nameB: string; effA: number; effB: number; noiseA: number; noiseB: number; pxA: number; pxB: number };
type Tally = { a: number; b: number; tie: number };
type SummaryState = { rows: SummaryRow[]; leads: { detail: Tally; clean: Tally; pixels: Tally } };

// Which side leads on an axis (lowerBetter for noise). Within 6% → tie.
function lead(x: number, y: number, lowerBetter = false): "a" | "b" | "tie" {
  const hi = Math.max(x, y) || 1;
  if (Math.abs(x - y) / hi < 0.06) return "tie";
  const aBetter = lowerBetter ? x < y : x > y;
  return aBetter ? "a" : "b";
}
const cls = (l: "a" | "b" | "tie", side: "a" | "b") => (l === side ? "font-medium text-amber-300" : l === "tie" ? "text-zinc-500" : "");

const ZOOM_CANVAS = 512; // backing pixel size of each zoom canvas
const MIN_VIEW = 0.02; // tightest scene fraction shown in the inspector
const MAX_VIEW = 0.4;
const MIN_CROP = 0.02; // ignore accidental micro-drags

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

// Native pixel crop of an image at a fractional rect (for cropped diagnostics).
function cropToCanvas(img: HTMLImageElement, r: Rect): HTMLCanvasElement {
  const nw = img.naturalWidth, nh = img.naturalHeight;
  const cw = Math.max(2, Math.round(r.w * nw));
  const ch = Math.max(2, Math.round(r.h * nh));
  const cx = Math.max(0, Math.min(nw - cw, Math.round(r.x * nw)));
  const cy = Math.max(0, Math.min(nh - ch, Math.round(r.y * nh)));
  const c = document.createElement("canvas");
  c.width = cw;
  c.height = ch;
  c.getContext("2d")!.drawImage(img, cx, cy, cw, ch, 0, 0, cw, ch);
  return c;
}

export default function ResolutionCompareModal({ onClose }: Props) {
  // Each side holds an ordered list of images; one is "active" (shown big and fed
  // to the comparison). Lists let you load a stack and step/reorder through pairs.
  const [listA, setListA] = useState<Slot[]>([]);
  const [listB, setListB] = useState<Slot[]>([]);
  const [idxA, setIdxA] = useState(0);
  const [idxB, setIdxB] = useState(0);

  const cIdxA = Math.min(idxA, Math.max(0, listA.length - 1));
  const cIdxB = Math.min(idxB, Math.max(0, listB.length - 1));
  const a: Slot | null = listA[cIdxA] ?? null;
  const b: Slot | null = listB[cIdxB] ?? null;

  // The stack-summary section appears once there's a list on either side. Pairs are
  // index-aligned; if exactly one side is a single image it's broadcast against the
  // other's whole list (compare many variants to one reference).
  const lenA = listA.length, lenB = listB.length;
  const showSummary = lenA >= 1 && lenB >= 1 && Math.max(lenA, lenB) >= 2;
  const pairCount = !showSummary ? 0 : lenA === 1 || lenB === 1 ? Math.max(lenA, lenB) : Math.min(lenA, lenB);

  const [result, setResult] = useState<CompareResult | null>(null);
  const [cropResult, setCropResult] = useState<CompareResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Whole-stack summary (computed on demand — each pair runs a full analysis).
  const [summary, setSummary] = useState<SummaryState | null>(null);
  const [summaryProgress, setSummaryProgress] = useState<number | null>(null);
  // Inspector crop centre (follows the cursor) and zoom (wheel), both 0–1 fractions.
  const [focus, setFocus] = useState({ x: 0.5, y: 0.5 });
  const [view, setView] = useState(0.08);
  // Diagnostics crop: committed rect + the live drag rect.
  const [crop, setCrop] = useState<Rect | null>(null);
  const [cropDraft, setCropDraft] = useState<Rect | null>(null);
  const dragStart = useRef<{ x: number; y: number } | null>(null);
  const dragRect = useRef<Rect | null>(null);
  useEscapeKey(onClose);

  const zoomARef = useRef<HTMLCanvasElement>(null);
  const zoomBRef = useRef<HTMLCanvasElement>(null);
  const inputARef = useRef<HTMLInputElement>(null);
  const inputBRef = useRef<HTMLInputElement>(null);

  // Decode files into slots, skipping any that fail to load.
  const loadSlots = useCallback(async (files: File[]): Promise<Slot[]> => {
    const out: Slot[] = [];
    for (const file of files) {
      try {
        const img = await loadImageFile(file);
        out.push({ file, img, url: img.src });
      } catch {
        setError("Could not read one of the images.");
      }
    }
    return out;
  }, []);

  // The drop / pick rules:
  //  • both sides empty + exactly 2 images → fill A and B (quick "compare these two")
  //  • target side empty → 1 image sets it; several become its list
  //  • target side already has images → append them (build a stack), select the first new
  const handleFiles = useCallback(
    async (files: File[], side: Side) => {
      if (!files.length) return;
      const slots = await loadSlots(files);
      if (!slots.length) return;
      setError(null);
      const setL = side === "a" ? setListA : setListB;
      const setI = side === "a" ? setIdxA : setIdxB;
      const base = side === "a" ? listA : listB;
      const bothEmpty = listA.length === 0 && listB.length === 0;
      if (slots.length === 2 && bothEmpty) {
        setListA([slots[0]]); setIdxA(0);
        setListB([slots[1]]); setIdxB(0);
      } else if (base.length === 0) {
        setL(slots); setI(0);
      } else {
        setL([...base, ...slots]); setI(base.length);
      }
    },
    [loadSlots, listA, listB]
  );

  const select = useCallback((side: Side, i: number) => {
    (side === "a" ? setIdxA : setIdxB)(i);
  }, []);

  const removeAt = useCallback((side: Side, i: number) => {
    (side === "a" ? setListA : setListB)((prev) => prev.filter((_, j) => j !== i));
    (side === "a" ? setIdxA : setIdxB)((cur) => Math.max(0, i < cur ? cur - 1 : cur));
  }, []);

  // Manual reorder within a side; keep the active item active by shifting its index.
  const reorder = useCallback((side: Side, from: number, to: number) => {
    (side === "a" ? setListA : setListB)((prev) => {
      const arr = [...prev];
      const [m] = arr.splice(from, 1);
      arr.splice(to, 0, m);
      return arr;
    });
    (side === "a" ? setIdxA : setIdxB)((cur) => {
      if (cur === from) return to;
      if (from < cur && to >= cur) return cur - 1;
      if (from > cur && to <= cur) return cur + 1;
      return cur;
    });
  }, []);

  // Which side is under a file drag (for the highlight).
  const [dragSide, setDragSide] = useState<Side | null>(null);

  // Analyze every paired image in the stacks (sequential, yielding between pairs so
  // the progress label updates — each comparison runs the full effective-res probe).
  const analyzeAll = useCallback(async () => {
    const la = listA, lb = listB;
    const n = la.length === 1 || lb.length === 1 ? Math.max(la.length, lb.length) : Math.min(la.length, lb.length);
    if (n < 1) return;
    setSummaryProgress(0);
    const rows: SummaryRow[] = [];
    const leads = { detail: { a: 0, b: 0, tie: 0 }, clean: { a: 0, b: 0, tie: 0 }, pixels: { a: 0, b: 0, tie: 0 } };
    const bump = (t: Tally, l: "a" | "b" | "tie") => { t[l]++; };
    for (let i = 0; i < n; i++) {
      await new Promise((r) => setTimeout(r, 0));
      const ai = Math.min(i, la.length - 1), bi = Math.min(i, lb.length - 1);
      try {
        const res = compareResolution(la[ai].img, lb[bi].img);
        const pxA = Math.max(res.a.width, res.a.height), pxB = Math.max(res.b.width, res.b.height);
        rows.push({ ai, bi, nameA: la[ai].file.name, nameB: lb[bi].file.name, effA: res.a.effectivePx, effB: res.b.effectivePx, noiseA: res.a.noise, noiseB: res.b.noise, pxA, pxB });
        bump(leads.detail, lead(res.a.effectivePx, res.b.effectivePx));
        bump(leads.clean, lead(res.a.noise, res.b.noise, true));
        bump(leads.pixels, lead(pxA, pxB));
      } catch {
        /* skip a pair that fails */
      }
      setSummaryProgress(i + 1);
    }
    setSummary({ rows, leads });
    setSummaryProgress(null);
  }, [listA, listB]);

  // A changed stack invalidates a computed summary.
  useEffect(() => {
    setSummary(null);
    setSummaryProgress(null);
  }, [listA, listB]);

  // ← / → step BOTH stacks together so you walk version-pairs in lockstep. Capture
  // phase + stopImmediatePropagation keeps the editor behind from also acting.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      const d = e.key === "ArrowRight" ? 1 : -1;
      setIdxA((i) => Math.max(0, Math.min(listA.length - 1, i + d)));
      setIdxB((i) => Math.max(0, Math.min(listB.length - 1, i + d)));
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [listA.length, listB.length]);

  // Whole-image comparison whenever both active images are present.
  useEffect(() => {
    if (a && b) {
      try {
        setResult(compareResolution(a.img, b.img));
        setError(null);
        const maxLong = Math.max(a.img.naturalWidth, a.img.naturalHeight, b.img.naturalWidth, b.img.naturalHeight);
        setView(Math.max(MIN_VIEW, Math.min(MAX_VIEW, ZOOM_CANVAS / maxLong)));
      } catch {
        setError("Comparison failed.");
      }
    } else {
      setResult(null);
    }
  }, [a, b]);

  // Cropped comparison — same fractional region from both images.
  useEffect(() => {
    if (a && b && crop) {
      try {
        setCropResult(compareResolution(cropToCanvas(a.img, crop) as CompareSource, cropToCanvas(b.img, crop) as CompareSource));
      } catch {
        setCropResult(null);
      }
    } else {
      setCropResult(null);
    }
  }, [a, b, crop]);

  // Aligned zoom crops, sampled from the ORIGINAL full-res images so a large image
  // shows real detail (not blocky upscaled grid pixels).
  useEffect(() => {
    if (!a || !b) return;
    for (const [ref, img] of [[zoomARef, a.img], [zoomBRef, b.img]] as const) {
      const cv = ref.current;
      if (!cv) continue;
      const nw = img.naturalWidth, nh = img.naturalHeight;
      const side = Math.max(4, Math.min(Math.min(nw, nh), Math.round(view * Math.max(nw, nh))));
      const sx = Math.max(0, Math.min(nw - side, Math.round(focus.x * nw - side / 2)));
      const sy = Math.max(0, Math.min(nh - side, Math.round(focus.y * nh - side / 2)));
      cv.width = ZOOM_CANVAS;
      cv.height = ZOOM_CANVAS;
      const ctx = cv.getContext("2d")!;
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.clearRect(0, 0, ZOOM_CANVAS, ZOOM_CANVAS);
      ctx.drawImage(img, sx, sy, side, side, 0, 0, ZOOM_CANVAS, ZOOM_CANVAS);
    }
  }, [a, b, focus, view]);

  // Wheel zoom via a NATIVE non-passive listener — React's onWheel is passive, so
  // preventDefault there wouldn't stop the modal from also scrolling.
  const attachWheel = useCallback((node: HTMLDivElement | null) => {
    if (!node) return;
    const handler = (e: WheelEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setView((v) => Math.max(MIN_VIEW, Math.min(MAX_VIEW, v * (e.deltaY > 0 ? 1.15 : 1 / 1.15))));
    };
    node.addEventListener("wheel", handler, { passive: false });
    return () => node.removeEventListener("wheel", handler);
  }, []);

  function frac(e: React.MouseEvent<HTMLDivElement>) {
    const r = e.currentTarget.getBoundingClientRect();
    return { x: clamp01((e.clientX - r.left) / r.width), y: clamp01((e.clientY - r.top) / r.height) };
  }
  function onDown(e: React.MouseEvent<HTMLDivElement>) {
    const p = frac(e);
    dragStart.current = p;
    dragRect.current = { x: p.x, y: p.y, w: 0, h: 0 };
    setCropDraft(dragRect.current);
  }
  function onMove(e: React.MouseEvent<HTMLDivElement>) {
    const p = frac(e);
    if (dragStart.current) {
      const s = dragStart.current;
      const rect = { x: Math.min(s.x, p.x), y: Math.min(s.y, p.y), w: Math.abs(p.x - s.x), h: Math.abs(p.y - s.y) };
      dragRect.current = rect;
      setCropDraft(rect);
    } else {
      setFocus(p);
    }
  }
  function endDrag() {
    if (dragStart.current) {
      const rect = dragRect.current;
      // A real drag sets the crop; a click (tiny rect) clears it.
      setCrop(rect && rect.w >= MIN_CROP && rect.h >= MIN_CROP ? rect : null);
    }
    dragStart.current = null;
    dragRect.current = null;
    setCropDraft(null);
  }

  const overlay = cropDraft ?? crop;

  return (
    <div
      className="animate-overlay fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
      onClick={onClose}
      // Swallow file drags so dropping onto the comparison modal doesn't also
      // bubble to the editor-wide drop handler behind it (which would open the
      // images as new tabs). Slot drop handlers run first, deeper in the tree.
      onDragEnter={(e) => { if (dragHasFiles(e.dataTransfer)) e.stopPropagation(); }}
      onDragOver={(e) => { if (dragHasFiles(e.dataTransfer)) { e.preventDefault(); e.stopPropagation(); } }}
      onDrop={(e) => { if (dragHasFiles(e.dataTransfer)) { e.preventDefault(); e.stopPropagation(); } }}
    >
      <div
        className="animate-dialog flex max-h-[92vh] w-[min(960px,92vw)] flex-col gap-3 overflow-auto rounded-xl border border-zinc-700 bg-zinc-900 p-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium text-white">Resolution comparison</h3>
          <span className="text-xs text-zinc-500">Which image has more real detail (not just pixel count)</span>
        </div>

        {/* Upload sides — each holds a reorderable stack of images */}
        <div className="grid grid-cols-2 gap-3">
          {(["a", "b"] as const).map((side) => {
            const list = side === "a" ? listA : listB;
            const active = side === "a" ? a : b;
            const activeIdx = side === "a" ? cIdxA : cIdxB;
            const inputRef = side === "a" ? inputARef : inputBRef;
            return (
              <div
                key={side}
                onDragEnter={(e) => { if (!dragHasFiles(e.dataTransfer)) return; e.preventDefault(); setDragSide(side); }}
                onDragOver={(e) => { if (!dragHasFiles(e.dataTransfer)) return; e.preventDefault(); e.dataTransfer.dropEffect = "copy"; }}
                onDragLeave={(e) => { if (!dragHasFiles(e.dataTransfer)) return; setDragSide((s) => (s === side ? null : s)); }}
                onDrop={(e) => { if (!dragHasFiles(e.dataTransfer)) return; e.preventDefault(); setDragSide(null); void handleFiles(imageFilesFromDataTransfer(e.dataTransfer), side); }}
                className={`flex min-h-[120px] flex-col rounded-lg border border-dashed p-2 transition-colors ${
                  dragSide === side ? "border-blue-500 bg-zinc-800/70" : "border-zinc-700 bg-zinc-800/40"
                }`}
              >
                <input
                  ref={inputRef}
                  type="file"
                  accept="image/*"
                  multiple
                  className="hidden"
                  onChange={(e) => { const files = Array.from(e.target.files ?? []); e.target.value = ""; if (files.length) void handleFiles(files, side); }}
                />
                {!active ? (
                  <button
                    type="button"
                    onClick={() => inputRef.current?.click()}
                    className="flex flex-1 cursor-pointer flex-col items-center justify-center gap-1 text-center hover:opacity-90"
                  >
                    <span className="text-sm text-zinc-500">Click or drop Image {side.toUpperCase()}</span>
                    <span className="text-xs text-zinc-600">2 images fill both · drop several for a stack</span>
                  </button>
                ) : (
                  <div className="flex flex-col gap-1">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={active.url} alt={`Image ${side}`} className="mx-auto max-h-[160px] max-w-full rounded" />
                    <span className="max-w-full truncate text-xs text-zinc-400" title={active.file.name}>
                      <span className="font-medium text-zinc-200">Image {side.toUpperCase()}</span> · {active.file.name} · {active.img.naturalWidth}×{active.img.naturalHeight}
                      {list.length > 1 && <span className="text-zinc-500"> · {activeIdx + 1}/{list.length}</span>}
                    </span>
                    <ThumbStrip
                      list={list}
                      active={activeIdx}
                      onSelect={(i) => select(side, i)}
                      onRemove={(i) => removeAt(side, i)}
                      onReorder={(from, to) => reorder(side, from, to)}
                      onAdd={() => inputRef.current?.click()}
                    />
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {error && <div className="rounded-md border border-red-700 bg-red-900/40 px-3 py-2 text-sm text-red-300">{error}</div>}

        {result && a && b && (
          <>
            <div className="flex items-center justify-between">
              <span className="text-xs text-zinc-500">
                Hover to move the zoom · scroll to zoom · <span className="text-zinc-400">drag to crop a region for diagnostics</span>
                {showSummary && <span className="text-zinc-400"> · ← → step both stacks</span>}
              </span>
              {crop && (
                <button onClick={() => setCrop(null)} className="text-xs text-amber-300 hover:text-amber-200">Clear crop ✕</button>
              )}
            </div>

            {/* Previews with aligned pixel-level zoom */}
            <div className="grid grid-cols-2 gap-3">
              {(["a", "b"] as const).map((which) => {
                const slot = which === "a" ? a! : b!;
                // Outline of exactly what the inspector shows: a `side`-px square at
                // `focus`, edge-clamped — same maths as the zoom render, so the marker
                // tracks zoom (scroll) and position (hover).
                const nw = slot.img.naturalWidth, nh = slot.img.naturalHeight;
                const side = Math.max(4, Math.min(Math.min(nw, nh), Math.round(view * Math.max(nw, nh))));
                const mx = Math.max(0, Math.min(nw - side, focus.x * nw - side / 2));
                const my = Math.max(0, Math.min(nh - side, focus.y * nh - side / 2));
                const marker = { left: `${(mx / nw) * 100}%`, top: `${(my / nh) * 100}%`, width: `${(side / nw) * 100}%`, height: `${(side / nh) * 100}%` };
                return (
                  <div key={which} className="flex flex-col gap-1">
                    <div
                      ref={attachWheel}
                      className="relative mx-auto w-fit cursor-crosshair select-none overflow-hidden rounded-lg border border-zinc-700"
                      onMouseDown={onDown}
                      onMouseMove={onMove}
                      onMouseUp={endDrag}
                      onMouseLeave={endDrag}
                      title="Hover to move the zoom · scroll to zoom · drag to crop"
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={slot.url} alt={`Image ${which}`} draggable={false} className="block max-h-[200px] max-w-full" />
                      {/* zoom region marker — outlines exactly what the inspector shows */}
                      <span className="pointer-events-none absolute border-2 border-amber-400 bg-amber-400/10" style={marker} />
                      {/* crop rectangle (committed or in-progress) */}
                      {overlay && overlay.w > 0 && overlay.h > 0 && (
                        <span
                          className="pointer-events-none absolute border-2 border-dashed border-sky-400 bg-sky-400/10"
                          style={{ left: `${overlay.x * 100}%`, top: `${overlay.y * 100}%`, width: `${overlay.w * 100}%`, height: `${overlay.h * 100}%` }}
                        />
                      )}
                    </div>
                    <span className="max-w-full truncate text-xs font-medium text-zinc-400" title={slot.file.name}>
                      Image {which.toUpperCase()} · {slot.file.name}
                    </span>
                    <canvas ref={which === "a" ? zoomARef : zoomBRef} className="aspect-square w-full rounded-lg border border-zinc-700 bg-black" />
                  </div>
                );
              })}
            </div>

            {/* Difference heatmap */}
            <div className="flex flex-col gap-1">
              <span className="text-xs text-zinc-500">Pixel difference (|A − B|) — brighter = larger difference</span>
              <DiffView diff={result.diff} />
            </div>

            {/* Diagnostics — whole image, plus the cropped region when one is set */}
            <div className={cropResult ? "grid grid-cols-1 gap-3 md:grid-cols-2" : ""}>
              <ResultBlock title="Whole image" result={result} nameA={a.file.name} nameB={b.file.name} />
              {cropResult && <ResultBlock title="Cropped region" result={cropResult} nameA={a.file.name} nameB={b.file.name} />}
            </div>

            <p className="text-[11px] leading-relaxed text-zinc-500">
              Three independent axes, no single &quot;winner&quot; — they can disagree.{" "}
              <span className="text-zinc-400">Effective resolution</span> is real-detail long side (probed across scales; not fooled
              by a soft upscale or by sharpening). <span className="text-zinc-400">Noise</span> is grain in flat areas (lower =
              cleaner). <span className="text-zinc-400">Pixel size</span> is raw dimensions. A clean upscale often has more pixels and
              less grain but slightly less real detail than the original — pick the trade-off you want. Drag a preview to compare a region.
            </p>

            {showSummary && (
              <div className="flex flex-col gap-2 border-t border-zinc-800 pt-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-semibold uppercase tracking-wide text-zinc-400">
                    Stack summary · {pairCount} pair{pairCount === 1 ? "" : "s"}
                  </span>
                  {summary ? (
                    <span className="text-[11px] text-zinc-400">
                      leads — detail <span className="font-medium text-amber-300">A {summary.leads.detail.a}·B {summary.leads.detail.b}</span>
                      {" · "}cleaner <span className="font-medium text-amber-300">A {summary.leads.clean.a}·B {summary.leads.clean.b}</span>
                      {" · "}pixels <span className="font-medium text-amber-300">A {summary.leads.pixels.a}·B {summary.leads.pixels.b}</span>
                    </span>
                  ) : (
                    <button
                      onClick={() => void analyzeAll()}
                      disabled={summaryProgress !== null}
                      className="rounded-md border border-zinc-700 px-2 py-1 text-xs text-zinc-200 transition-colors hover:border-zinc-500 disabled:opacity-50"
                    >
                      {summaryProgress !== null ? `Analyzing ${summaryProgress}/${pairCount}…` : `Analyze all ${pairCount} pairs`}
                    </button>
                  )}
                </div>
                {summary && (
                  <table className="w-full text-left text-xs text-zinc-300">
                    <thead className="text-zinc-500">
                      <tr>
                        <th className="py-1 pr-2 font-normal">#</th>
                        <th className="py-1 pr-2 font-normal">Pair (A / B)</th>
                        <th className="py-1 pr-2 font-normal">Detail ↑</th>
                        <th className="py-1 pr-2 font-normal">Noise ↓</th>
                        <th className="py-1 font-normal">Pixels ↑</th>
                      </tr>
                    </thead>
                    <tbody>
                      {summary.rows.map((r) => {
                        const isActive = r.ai === cIdxA && r.bi === cIdxB;
                        const ld = lead(r.effA, r.effB), lc = lead(r.noiseA, r.noiseB, true), lp = lead(r.pxA, r.pxB);
                        return (
                          <tr
                            key={`${r.ai}-${r.bi}`}
                            onClick={() => { setIdxA(r.ai); setIdxB(r.bi); }}
                            title="Jump to this pair"
                            className={`cursor-pointer border-t border-zinc-800 hover:bg-zinc-800/50 ${isActive ? "bg-zinc-800/40" : ""}`}
                          >
                            <td className="py-1 pr-2 text-zinc-500">{r.ai === r.bi ? r.ai + 1 : `${r.ai + 1}/${r.bi + 1}`}</td>
                            <td className="py-1 pr-2">
                              <span className="block max-w-[150px] truncate text-zinc-400" title={r.nameA}>{r.nameA}</span>
                              <span className="block max-w-[150px] truncate text-zinc-500" title={r.nameB}>{r.nameB}</span>
                            </td>
                            <td className="py-1 pr-2 whitespace-nowrap">
                              <span className={`block ${cls(ld, "a")}`}>~{r.effA}px</span>
                              <span className={`block ${cls(ld, "b")}`}>~{r.effB}px</span>
                            </td>
                            <td className="py-1 pr-2 whitespace-nowrap">
                              <span className={`block ${cls(lc, "a")}`}>{r.noiseA.toFixed(2)}%</span>
                              <span className={`block ${cls(lc, "b")}`}>{r.noiseB.toFixed(2)}%</span>
                            </td>
                            <td className="py-1 whitespace-nowrap">
                              <span className={`block ${cls(lp, "a")}`}>{r.pxA}px</span>
                              <span className={`block ${cls(lp, "b")}`}>{r.pxB}px</span>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                )}
              </div>
            )}
          </>
        )}

        <div className="flex justify-end">
          <button onClick={onClose} className="px-4 py-2 text-sm text-zinc-400 transition-colors hover:text-white">Close</button>
        </div>
      </div>
    </div>
  );
}

// Horizontal stack of an image side: click to make active, drag to reorder, × to
// remove, ＋ to add more. Reorder uses HTML5 drag-and-drop carrying a non-"Files"
// payload, so the surrounding file-drop handlers ignore it.
function ThumbStrip({
  list,
  active,
  onSelect,
  onRemove,
  onReorder,
  onAdd,
}: {
  list: Slot[];
  active: number;
  onSelect: (i: number) => void;
  onRemove: (i: number) => void;
  onReorder: (from: number, to: number) => void;
  onAdd: () => void;
}) {
  const from = useRef<number | null>(null);
  return (
    <div className="mt-1 flex items-center gap-1 overflow-x-auto pb-1">
      {list.map((slot, i) => (
        <div
          key={i}
          draggable
          onDragStart={(e) => { from.current = i; e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/x-thumb", String(i)); }}
          onDragOver={(e) => { if (from.current !== null) { e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = "move"; } }}
          onDrop={(e) => { if (from.current !== null) { e.preventDefault(); e.stopPropagation(); if (from.current !== i) onReorder(from.current, i); from.current = null; } }}
          onDragEnd={() => { from.current = null; }}
          onClick={() => onSelect(i)}
          title={slot.file.name}
          className={`group relative h-12 w-12 flex-shrink-0 cursor-pointer overflow-hidden rounded border ${
            i === active ? "border-amber-400 ring-1 ring-amber-400" : "border-zinc-700 hover:border-zinc-500"
          }`}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={slot.url} alt="" draggable={false} className="h-full w-full object-cover" />
          <span className="absolute bottom-0 left-0 bg-black/60 px-1 text-[9px] leading-tight text-zinc-200">{i + 1}</span>
          <button
            onClick={(e) => { e.stopPropagation(); onRemove(i); }}
            className="absolute right-0 top-0 hidden h-4 w-4 items-center justify-center rounded-bl bg-black/70 text-[10px] text-white hover:bg-red-600 group-hover:flex"
            title="Remove"
          >
            ✕
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={onAdd}
        className="flex h-12 w-12 flex-shrink-0 items-center justify-center rounded border border-dashed border-zinc-600 text-lg text-zinc-400 hover:border-zinc-400 hover:text-zinc-200"
        title="Add images"
      >
        ＋
      </button>
    </div>
  );
}

function ResultBlock({ title, result, nameA, nameB }: { title: string; result: CompareResult; nameA: string; nameB: string }) {
  return (
    <div className="rounded-lg border border-zinc-700 bg-zinc-800/40 p-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-xs font-semibold uppercase tracking-wide text-zinc-400">{title}</span>
        <span className="text-[11px] text-zinc-500">{result.commonW}×{result.commonH} grid</span>
      </div>
      <table className="w-full text-left text-xs text-zinc-300">
        <thead className="text-zinc-500">
          <tr>
            <th className="py-1 pr-2 font-normal">Metric</th>
            <th className="max-w-[120px] truncate py-1 pr-2 font-normal" title={nameA}>Image A · {nameA}</th>
            <th className="max-w-[120px] truncate py-1 font-normal" title={nameB}>Image B · {nameB}</th>
          </tr>
        </thead>
        <tbody>
          {/* Three primary axes — they can disagree; no overall winner. */}
          <Row label="Effective resolution ↑" a={`~${result.a.effectivePx}px`} b={`~${result.b.effectivePx}px`} hiA={result.a.effectivePx >= result.b.effectivePx} hiB={result.b.effectivePx >= result.a.effectivePx} />
          <Row label="Noise / grain ↓" a={`${result.a.noise.toFixed(2)}%`} b={`${result.b.noise.toFixed(2)}%`} hiA={result.a.noise <= result.b.noise} hiB={result.b.noise <= result.a.noise} />
          <Row label="Pixel size ↑" a={`${result.a.width}×${result.a.height}`} b={`${result.b.width}×${result.b.height}`} hiA={result.a.width * result.a.height >= result.b.width * result.b.height} hiB={result.b.width * result.b.height >= result.a.width * result.a.height} />
          <Row label="Detail score (HF)" a={result.a.hfRatio.toFixed(4)} b={result.b.hfRatio.toFixed(4)} hiA={result.a.hfRatio >= result.b.hfRatio} hiB={result.b.hfRatio >= result.a.hfRatio} />
          <Row label="Acutance ↑" a={result.a.acutance.toFixed(3)} b={result.b.acutance.toFixed(3)} hiA={result.a.acutance >= result.b.acutance} hiB={result.b.acutance >= result.a.acutance} />
          <Row label="Edge width px ↓" a={result.a.edgeWidth.toFixed(2)} b={result.b.edgeWidth.toFixed(2)} hiA={result.a.edgeWidth <= result.b.edgeWidth} hiB={result.b.edgeWidth <= result.a.edgeWidth} />
        </tbody>
      </table>
    </div>
  );
}

function Row({ label, a, b, hiA, hiB }: { label: string; a: string; b: string; hiA?: boolean; hiB?: boolean }) {
  // hiA && hiB means the two values are equal (the callers use >= / <=), so it's a
  // tie — grey both rather than highlighting both.
  const tie = !!hiA && !!hiB;
  const cls = (hi?: boolean) => (tie ? "text-zinc-500" : hi ? "font-semibold text-amber-300" : "");
  return (
    <tr className="border-t border-zinc-800">
      <td className="py-1 pr-2 text-zinc-400">{label}</td>
      <td className={`py-1 pr-2 ${cls(hiA)}`}>{a}</td>
      <td className={`py-1 ${cls(hiB)}`}>{b}</td>
    </tr>
  );
}

function DiffView({ diff }: { diff: HTMLCanvasElement }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    cv.width = diff.width;
    cv.height = diff.height;
    cv.getContext("2d")!.drawImage(diff, 0, 0);
  }, [diff]);
  return <canvas ref={ref} className="max-h-[200px] w-full rounded-lg border border-zinc-700 object-contain" />;
}
