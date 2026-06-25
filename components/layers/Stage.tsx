"use client";

import {
  Fragment,
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";
import { useAssetCache, useDoc, useDocActions } from "@/lib/doc/DocContext";
import { affinePoint, cornersDoc, rotate, screenToDoc, type Vec } from "@/lib/doc/geometry";
import { computeSnap } from "@/lib/doc/snapping";
import {
  areaSplitLines,
  contentSize,
  makeArea,
  makeGuide,
  makeRuler,
  type AreaAnnotation,
  type Doc,
  type GuideAnnotation,
  type RulerAnnotation,
} from "@/lib/doc/types";
import { measureTextLayout } from "@/lib/doc/render";
import type { BBox } from "@/lib/crop-inpaint-stitch";
import type { Reservation } from "@/lib/doc/useAiJobs";
import LayerView from "./LayerView";
import TransformBox from "./TransformBox";
import GroupBox from "./GroupBox";
import CanvasRulers, { RULER, RULER_UNITS, formatRulerValue, nearestTickDoc, type RulerUnit } from "./CanvasRulers";

export type EditorMode = "view" | "manual" | "ai";

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(v, hi));
const MASK_FILL = "rgba(239,68,68,1)";
const SNAP_PX = 8; // screen-px snap threshold for measurement endpoints

const midpoint = (a: Vec, b: Vec): Vec => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

// Shared style for the pending-result review buttons (zoom-compensated overlay).
const pendingBtn = (bg: string): CSSProperties => ({
  whiteSpace: "nowrap",
  padding: "4px 10px",
  borderRadius: 6,
  fontSize: 13,
  fontWeight: 500,
  color: "#fff",
  background: bg,
  border: "none",
  cursor: "pointer",
  touchAction: "none",
});

// Candidate snap points so measurements lock to other elements: every visible
// layer's corners/edge-mids/center, plus the canvas corners/edges/center.
function snapTargets(doc: Doc): Vec[] {
  const pts: Vec[] = [];
  for (const l of doc.layers) {
    if (!l.visible) continue;
    const size = l.type === "text" ? { w: l.boxWidth, h: measureTextLayout(l).height } : contentSize(l);
    const c = cornersDoc(l.transform, size.w, size.h);
    pts.push(c.tl, c.tr, c.br, c.bl, midpoint(c.tl, c.br), midpoint(c.tl, c.tr), midpoint(c.tr, c.br), midpoint(c.br, c.bl), midpoint(c.bl, c.tl));
  }
  const { width: W, height: H } = doc;
  pts.push({ x: 0, y: 0 }, { x: W, y: 0 }, { x: W, y: H }, { x: 0, y: H }, { x: W / 2, y: H / 2 }, { x: W / 2, y: 0 }, { x: W, y: H / 2 }, { x: W / 2, y: H }, { x: 0, y: H / 2 });
  return pts;
}

function snapToTarget(p: Vec, targets: Vec[], zoom: number): { pt: Vec; hit: boolean } {
  const th = SNAP_PX / zoom; // doc px
  let best: Vec | null = null;
  let bestD = th;
  for (const t of targets) {
    const d = Math.hypot(t.x - p.x, t.y - p.y);
    if (d < bestD) {
      bestD = d;
      best = t;
    }
  }
  return best ? { pt: best, hit: true } : { pt: p, hit: false };
}

export default function Stage({
  selectedIds = [],
  onSelect,
  mode = "manual",
  maskTool = "rect",
  brushSize = 40,
  maskCanvasRef,
  onMaskPaint,
  reservations = [],
  cropBoxes = [],
  pendingResults = [],
  onAcceptResult,
  onRejectResult,
  onRetryResult,
  onEditResult,
  snapEnabled = true,
  gridEnabled = false,
  gridDivisions = 10,
  measureTool = "ruler",
  selectedAnnotationId = null,
  onSelectAnnotation,
  split = null,
  onSplitCuts,
}: {
  selectedIds?: string[];
  onSelect: (id: string | null, additive?: boolean) => void;
  mode?: EditorMode;
  maskTool?: "brush" | "rect";
  brushSize?: number;
  maskCanvasRef?: RefObject<HTMLCanvasElement | null>;
  onMaskPaint?: () => void;
  reservations?: Reservation[];
  cropBoxes?: BBox[];
  pendingResults?: { id: string; items: { bbox: BBox; src: string }[] }[];
  onAcceptResult?: (id: string) => void;
  onRejectResult?: (id: string) => void;
  onRetryResult?: (id: string) => void;
  onEditResult?: (id: string, prompt: string) => void;
  snapEnabled?: boolean;
  gridEnabled?: boolean;
  gridDivisions?: number;
  measureTool?: "ruler" | "area";
  selectedAnnotationId?: string | null;
  onSelectAnnotation?: (id: string | null) => void;
  split?: { layerId: string; axis: "x" | "y"; cuts: number[] } | null;
  onSplitCuts?: (cuts: number[]) => void;
}) {
  const doc = useDoc();
  const cache = useAssetCache();
  const { doAction, commit } = useDocActions();
  const containerRef = useRef<HTMLDivElement>(null);
  const worldRef = useRef<HTMLDivElement>(null);

  const [vp, setVp] = useState({ zoom: 1, panX: 0, panY: 0 });
  const [panning, setPanning] = useState(false);
  const [spaceDown, setSpaceDown] = useState(false);
  const vpRef = useRef(vp);
  useEffect(() => {
    vpRef.current = vp;
  });

  // Container size (for laying out the edge rulers) and the chosen ruler unit.
  const [containerSize, setContainerSize] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const c = containerRef.current;
    if (!c) return;
    const ro = new ResizeObserver(() => setContainerSize({ w: c.clientWidth, h: c.clientHeight }));
    ro.observe(c);
    setContainerSize({ w: c.clientWidth, h: c.clientHeight });
    return () => ro.disconnect();
  }, []);

  const [rulerUnit, setRulerUnit] = useState<RulerUnit>(() => {
    if (typeof window === "undefined") return "px";
    const saved = localStorage.getItem("ruler-unit");
    return saved && (RULER_UNITS as string[]).includes(saved) ? (saved as RulerUnit) : "px";
  });
  const changeUnit = useCallback((u: RulerUnit) => {
    setRulerUnit(u);
    localStorage.setItem("ruler-unit", u);
  }, []);

  // Hold Space to pan in any mode (frees the measure surface in View mode).
  useEffect(() => {
    const typing = (t: EventTarget | null) => {
      const el = t as HTMLElement | null;
      return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
    };
    const down = (e: KeyboardEvent) => {
      if (e.code === "Space" && !typing(e.target)) {
        e.preventDefault();
        setSpaceDown(true);
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === "Space") setSpaceDown(false);
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, []);

  // Fit the document into the viewport (centered, never upscaled past 100%).
  const fitToView = useCallback(() => {
    const c = containerRef.current;
    if (!c) return;
    const cw = c.clientWidth;
    const ch = c.clientHeight;
    if (!cw || !ch) return;
    const pad = 64;
    const zoom = clamp(Math.min((cw - pad) / doc.width, (ch - pad) / doc.height), 0.05, 1);
    setVp({ zoom, panX: (cw - doc.width * zoom) / 2, panY: (ch - doc.height * zoom) / 2 });
  }, [doc.width, doc.height]);

  // Fit once per mount (provider remounts on a new doc, so this re-runs per doc).
  const fittedRef = useRef(false);
  useEffect(() => {
    if (fittedRef.current) return;
    const c = containerRef.current;
    if (!c || !c.clientWidth || !c.clientHeight) return;
    fitToView();
    fittedRef.current = true;
  }, [fitToView]);

  // Zoom to an absolute level, keeping the viewport center fixed.
  const applyZoom = (target: number) => {
    const c = containerRef.current;
    if (!c) return;
    const rect = c.getBoundingClientRect();
    const cx = rect.width / 2;
    const cy = rect.height / 2;
    const { zoom, panX, panY } = vpRef.current;
    const newZoom = clamp(target, 0.05, 8);
    const docX = (cx - panX) / zoom;
    const docY = (cy - panY) / zoom;
    setVp({ zoom: newZoom, panX: cx - docX * newZoom, panY: cy - docY * newZoom });
  };

  // Wheel zoom toward the cursor. Native non-passive listener so preventDefault works.
  useEffect(() => {
    const c = containerRef.current;
    if (!c) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = c.getBoundingClientRect();
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;
      const { zoom, panX, panY } = vpRef.current;
      const newZoom = clamp(zoom * Math.exp(-e.deltaY * 0.0015), 0.05, 8);
      const docX = (cx - panX) / zoom;
      const docY = (cy - panY) / zoom;
      setVp({ zoom: newZoom, panX: cx - docX * newZoom, panY: cy - docY * newZoom });
    };
    c.addEventListener("wheel", onWheel, { passive: false });
    return () => c.removeEventListener("wheel", onWheel);
  }, []);

  // Pan on background drag; a background click (no drag) deselects.
  const pan = useRef<{ startX: number; startY: number; panX: number; panY: number; moved: boolean } | null>(null);

  const onPointerDown = useCallback((e: ReactPointerEvent) => {
    // Only fires for the background — layers/handles/mask stopPropagation.
    containerRef.current?.setPointerCapture(e.pointerId);
    pan.current = { startX: e.clientX, startY: e.clientY, panX: vpRef.current.panX, panY: vpRef.current.panY, moved: false };
    setPanning(true);
  }, []);

  const onPointerMove = useCallback((e: ReactPointerEvent) => {
    const p = pan.current;
    if (!p) return;
    const dx = e.clientX - p.startX;
    const dy = e.clientY - p.startY;
    if (!p.moved && Math.hypot(dx, dy) > 3) p.moved = true;
    setVp((v) => ({ ...v, panX: p.panX + dx, panY: p.panY + dy }));
  }, []);

  const onPointerUp = useCallback(
    (e: ReactPointerEvent) => {
      const p = pan.current;
      containerRef.current?.releasePointerCapture(e.pointerId);
      if (p && !p.moved) {
        onSelect(null);
        onSelectAnnotation?.(null);
      }
      pan.current = null;
      setPanning(false);
    },
    [onSelect, onSelectAnnotation]
  );

  const getWorldRect = useCallback(() => worldRef.current?.getBoundingClientRect() ?? null, []);

  // --- Mask painting (doc-space brush or rectangle onto maskCanvasRef) ------
  const painting = useRef(false);
  const lastDoc = useRef<Vec | null>(null);
  const rectStart = useRef<Vec | null>(null);
  const [rectPreview, setRectPreview] = useState<{ x: number; y: number; w: number; h: number } | null>(null);

  // While a pending result's "Compare" button is held, hide its preview to reveal
  // the original beneath.
  const [comparingId, setComparingId] = useState<string | null>(null);
  // Which pending result has its "Edit" (reprompt) input open, and its draft text.
  const [editingResultId, setEditingResultId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");

  const maskCtx = () => maskCanvasRef?.current?.getContext("2d") ?? null;
  const docPoint = (e: ReactPointerEvent): Vec | null => {
    const rect = getWorldRect();
    return rect ? screenToDoc(e.clientX, e.clientY, rect, vpRef.current.zoom) : null;
  };
  const dab = (ctx: CanvasRenderingContext2D, p: Vec) => {
    const r = brushSize / 2 / vpRef.current.zoom; // screen-constant radius
    ctx.fillStyle = MASK_FILL;
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.fill();
  };

  // Plain handlers (recreated per render is fine — passed to a <canvas>, and
  // they read live refs). Not memoized, so no stale-closure / deps churn.
  const inReserved = (p: Vec) =>
    reservations.some((r) => p.x >= r.bbox.x && p.x <= r.bbox.x + r.bbox.w && p.y >= r.bbox.y && p.y <= r.bbox.y + r.bbox.h);

  const maskDown = (e: ReactPointerEvent) => {
    if (spaceDown) return; // Space-pan takes precedence — don't paint or swallow the drag
    e.stopPropagation();
    const ctx = maskCtx();
    const p = docPoint(e);
    if (!ctx || !p || inReserved(p)) return; // can't paint into a reserved region
    try {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    } catch {
      // ignore (e.g. synthetic events without an active pointer)
    }
    painting.current = true;
    if (maskTool === "rect") {
      rectStart.current = p;
      setRectPreview({ x: p.x, y: p.y, w: 0, h: 0 });
      return;
    }
    lastDoc.current = p;
    dab(ctx, p);
    onMaskPaint?.();
  };

  const maskMove = (e: ReactPointerEvent) => {
    if (!painting.current) return;
    const p = docPoint(e);
    if (!p) return;
    if (maskTool === "rect") {
      const s = rectStart.current;
      if (s) setRectPreview({ x: Math.min(s.x, p.x), y: Math.min(s.y, p.y), w: Math.abs(p.x - s.x), h: Math.abs(p.y - s.y) });
      return;
    }
    const ctx = maskCtx();
    if (!ctx) return;
    const from = lastDoc.current ?? p;
    ctx.strokeStyle = MASK_FILL;
    ctx.lineWidth = brushSize / vpRef.current.zoom;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    dab(ctx, p);
    lastDoc.current = p;
  };

  const maskUp = (e: ReactPointerEvent) => {
    if (maskTool === "rect" && painting.current) {
      const ctx = maskCtx();
      const s = rectStart.current;
      const p = docPoint(e);
      if (ctx && s && p) {
        const x = Math.min(s.x, p.x);
        const y = Math.min(s.y, p.y);
        const w = Math.abs(p.x - s.x);
        const h = Math.abs(p.y - s.y);
        if (w > 1 && h > 1) {
          ctx.fillStyle = MASK_FILL;
          ctx.fillRect(x, y, w, h);
          onMaskPaint?.();
        }
      }
      rectStart.current = null;
      setRectPreview(null);
    }
    const wasBrushStroke = maskTool !== "rect" && painting.current;
    painting.current = false;
    lastDoc.current = null;
    if (wasBrushStroke) onMaskPaint?.(); // recompute impact area after the full stroke
  };

  // --- Measurements (View mode): rulers + areas, drag to create/edit --------
  type AreaRect = { x: number; y: number; w: number; h: number };
  type MeasureI =
    | { kind: "ruler-new"; worldRect: DOMRect; zoom: number; targets: Vec[] }
    | { kind: "ruler-edit"; id: string; which: "a" | "b"; worldRect: DOMRect; zoom: number; targets: Vec[] }
    | { kind: "area-new"; worldRect: DOMRect; zoom: number; targets: Vec[]; ax: number; ay: number }
    | { kind: "area-move"; id: string; worldRect: DOMRect; zoom: number; targets: Vec[]; t0: AreaRect; p0: Vec }
    | { kind: "area-resize"; id: string; worldRect: DOMRect; zoom: number; targets: Vec[]; fixed: Vec };

  const measureRef = useRef<MeasureI | null>(null);
  const [measuring, setMeasuring] = useState(false);
  const [preview, setPreview] = useState<{ ax: number; ay: number; bx: number; by: number } | null>(null);
  const [areaPreview, setAreaPreview] = useState<AreaRect | null>(null);
  const [snapHit, setSnapHit] = useState<Vec | null>(null);
  // Mirror the in-progress geometry in refs so commit reads the live value
  // (the pointer-up handler's state closure can lag the last move).
  const previewRef = useRef<{ ax: number; ay: number; bx: number; by: number } | null>(null);
  const areaPreviewRef = useRef<AreaRect | null>(null);

  const toPx = (p: Vec): Vec => ({ x: vp.panX + p.x * vp.zoom, y: vp.panY + p.y * vp.zoom });
  const docAt = (e: ReactPointerEvent, m: MeasureI) => screenToDoc(e.clientX, e.clientY, m.worldRect, m.zoom);

  const measureDown = (e: ReactPointerEvent) => {
    e.stopPropagation();
    onSelectAnnotation?.(null); // clicking empty canvas deselects
    const worldRect = getWorldRect();
    if (!worldRect) return;
    const zoom = vpRef.current.zoom;
    const targets = snapTargets(doc);
    const s = snapToTarget(screenToDoc(e.clientX, e.clientY, worldRect, zoom), targets, zoom);
    if (measureTool === "area") {
      measureRef.current = { kind: "area-new", worldRect, zoom, targets, ax: s.pt.x, ay: s.pt.y };
      const a = { x: s.pt.x, y: s.pt.y, w: 0, h: 0 };
      areaPreviewRef.current = a;
      setAreaPreview(a);
    } else {
      measureRef.current = { kind: "ruler-new", worldRect, zoom, targets };
      const p = { ax: s.pt.x, ay: s.pt.y, bx: s.pt.x, by: s.pt.y };
      previewRef.current = p;
      setPreview(p);
    }
    setSnapHit(s.hit ? s.pt : null);
    setMeasuring(true);
  };

  const endpointDown = (id: string, which: "a" | "b") => (e: ReactPointerEvent) => {
    e.stopPropagation();
    const worldRect = getWorldRect();
    if (!worldRect) return;
    measureRef.current = { kind: "ruler-edit", id, which, worldRect, zoom: vpRef.current.zoom, targets: snapTargets(doc) };
    setMeasuring(true);
  };

  const areaBodyDown = (a: AreaAnnotation) => (e: ReactPointerEvent) => {
    e.stopPropagation();
    onSelectAnnotation?.(a.id);
    const worldRect = getWorldRect();
    if (!worldRect) return;
    const zoom = vpRef.current.zoom;
    measureRef.current = {
      kind: "area-move",
      id: a.id,
      worldRect,
      zoom,
      targets: snapTargets(doc),
      t0: { x: a.x, y: a.y, w: a.w, h: a.h },
      p0: screenToDoc(e.clientX, e.clientY, worldRect, zoom),
    };
    setMeasuring(true);
  };

  const areaCornerDown = (a: AreaAnnotation, fixed: Vec) => (e: ReactPointerEvent) => {
    e.stopPropagation();
    const worldRect = getWorldRect();
    if (!worldRect) return;
    measureRef.current = { kind: "area-resize", id: a.id, worldRect, zoom: vpRef.current.zoom, targets: snapTargets(doc), fixed };
    setMeasuring(true);
  };

  const measureMove = (e: ReactPointerEvent) => {
    const m = measureRef.current;
    if (!m) return;
    const raw = docAt(e, m);
    const s = snapToTarget(raw, m.targets, m.zoom);
    setSnapHit(s.hit ? s.pt : null);
    if (m.kind === "ruler-new") {
      const p = { ax: previewRef.current?.ax ?? s.pt.x, ay: previewRef.current?.ay ?? s.pt.y, bx: s.pt.x, by: s.pt.y };
      previewRef.current = p;
      setPreview(p);
    } else if (m.kind === "ruler-edit") {
      doAction({ type: "ANNOTATION_UPDATE", id: m.id, patch: m.which === "a" ? { ax: s.pt.x, ay: s.pt.y } : { bx: s.pt.x, by: s.pt.y } }, true);
    } else if (m.kind === "area-new") {
      const a = { x: Math.min(m.ax, s.pt.x), y: Math.min(m.ay, s.pt.y), w: Math.abs(s.pt.x - m.ax), h: Math.abs(s.pt.y - m.ay) };
      areaPreviewRef.current = a;
      setAreaPreview(a);
    } else if (m.kind === "area-move") {
      const corner = snapToTarget({ x: m.t0.x + (raw.x - m.p0.x), y: m.t0.y + (raw.y - m.p0.y) }, m.targets, m.zoom);
      setSnapHit(corner.hit ? corner.pt : null);
      doAction({ type: "ANNOTATION_UPDATE", id: m.id, patch: { x: corner.pt.x, y: corner.pt.y } }, true);
    } else {
      doAction(
        { type: "ANNOTATION_UPDATE", id: m.id, patch: { x: Math.min(m.fixed.x, s.pt.x), y: Math.min(m.fixed.y, s.pt.y), w: Math.abs(s.pt.x - m.fixed.x), h: Math.abs(s.pt.y - m.fixed.y) } },
        true
      );
    }
  };

  const measureUp = () => {
    const m = measureRef.current;
    const p = previewRef.current;
    const a = areaPreviewRef.current;
    if (m?.kind === "ruler-new" && p) {
      if (Math.hypot(p.bx - p.ax, p.by - p.ay) > 4) {
        doAction({ type: "ANNOTATION_ADD", annotation: makeRuler(p.ax, p.ay, p.bx, p.by) });
      }
    } else if (m?.kind === "area-new" && a) {
      if (a.w > 4 && a.h > 4) {
        const area = makeArea(a.x, a.y, a.w, a.h);
        doAction({ type: "ANNOTATION_ADD", annotation: area });
        onSelectAnnotation?.(area.id);
      }
    } else if (m) {
      commit();
    }
    measureRef.current = null;
    previewRef.current = null;
    areaPreviewRef.current = null;
    setMeasuring(false);
    setPreview(null);
    setAreaPreview(null);
    setSnapHit(null);
  };

  // --- Guides: drag out of a ruler edge to drop a canvas-spanning line -------
  // axis "x" = vertical guide (from the left ruler, pins doc x); axis "y" =
  // horizontal guide (from the top ruler, pins doc y).
  const guideRef = useRef<{ axis: "x" | "y"; id?: string; worldRect: DOMRect; zoom: number; onRuler: boolean } | null>(null);
  const [guideDrag, setGuideDrag] = useState<{ axis: "x" | "y"; value: number; onRuler: boolean } | null>(null);

  // Snap a guide's raw doc coordinate to content (layers/canvas/measurements)
  // first, then fall back to the nearest visible ruler tick. When repositioning,
  // `excludeId` keeps the dragged guide from magnetizing to its own old position.
  const snapGuide = (axis: "x" | "y", raw: number, zoom: number, excludeId?: string): number => {
    if (snapEnabled) {
      const snapDoc = excludeId ? { ...doc, annotations: doc.annotations.filter((a) => a.id !== excludeId) } : doc;
      const { dx, dy } = computeSnap(axis === "x" ? [raw] : [], axis === "y" ? [raw] : [], snapDoc, [], { enabled: true, grid: gridEnabled, gridDivisions }, SNAP_PX / zoom);
      const d = axis === "x" ? dx : dy;
      if (d !== 0) return raw + d;
    }
    const tick = nearestTickDoc(raw, zoom, rulerUnit, axis === "x" ? doc.width : doc.height, 4);
    return tick ?? raw;
  };

  // Is the pointer over either ruler strip? Dropping a guide there removes it.
  const pointerOnRuler = (e: ReactPointerEvent): boolean => {
    const c = containerRef.current;
    if (!c) return false;
    const r = c.getBoundingClientRect();
    return e.clientX - r.left < RULER || e.clientY - r.top < RULER;
  };

  const guideStart = (axis: "x" | "y", id?: string) => (e: ReactPointerEvent) => {
    e.stopPropagation();
    if (id) onSelectAnnotation?.(id); // grabbing an existing guide selects it
    const worldRect = getWorldRect();
    if (!worldRect) return;
    const zoom = vpRef.current.zoom;
    guideRef.current = { axis, id, worldRect, zoom, onRuler: false };
    const p = screenToDoc(e.clientX, e.clientY, worldRect, zoom);
    setGuideDrag({ axis, value: snapGuide(axis, axis === "x" ? p.x : p.y, zoom, id), onRuler: false });
  };

  const guideMove = (e: ReactPointerEvent) => {
    const g = guideRef.current;
    if (!g) return;
    const p = screenToDoc(e.clientX, e.clientY, g.worldRect, g.zoom);
    const onRuler = !!g.id && pointerOnRuler(e); // existing guide dragged back onto ruler → delete
    g.onRuler = onRuler;
    const value = snapGuide(g.axis, g.axis === "x" ? p.x : p.y, g.zoom, g.id);
    setGuideDrag({ axis: g.axis, value, onRuler });
    if (g.id && !onRuler) doAction({ type: "ANNOTATION_UPDATE", id: g.id, patch: { value } }, true);
  };

  const guideUp = (e: ReactPointerEvent) => {
    const g = guideRef.current;
    const d = guideDrag;
    if (g && d) {
      const dropOnRuler = pointerOnRuler(e);
      if (g.id) {
        if (dropOnRuler) doAction({ type: "ANNOTATION_DELETE", id: g.id });
        else commit();
      } else if (!dropOnRuler) {
        doAction({ type: "ANNOTATION_ADD", annotation: makeGuide(g.axis, d.value) });
      }
    }
    guideRef.current = null;
    setGuideDrag(null);
  };

  const annotations = doc.annotations ?? [];
  const rulers = annotations.filter((a): a is RulerAnnotation => a.type === "ruler");
  const areas = annotations.filter((a): a is AreaAnnotation => a.type === "area");
  const guides = annotations.filter((a): a is GuideAnnotation => a.type === "guide");
  const selectedLayers = doc.layers.filter((l) => selectedIds.includes(l.id));
  const single = selectedLayers.length === 1 ? selectedLayers[0] : undefined;

  // --- Split: draggable cut lines over the targeted raster layer ------------
  const splitTarget =
    split && mode === "manual" ? doc.layers.find((l) => l.id === split.layerId) : undefined;
  const sLayer = splitTarget && splitTarget.type === "raster" ? splitTarget : undefined;
  const splitDrag = useRef<{ index: number; worldRect: DOMRect; zoom: number } | null>(null);
  const [splitDragging, setSplitDragging] = useState(false);

  // Project a doc point into the layer's local coords (inverse of the transform).
  const inverseLocal = (t: { x: number; y: number; scaleX: number; scaleY: number; rotation: number }, p: Vec): Vec => {
    const r = rotate({ x: p.x - t.x, y: p.y - t.y }, -t.rotation);
    return { x: r.x / t.scaleX, y: r.y / t.scaleY };
  };

  const cutHandleDown = (index: number) => (e: ReactPointerEvent) => {
    e.stopPropagation();
    const worldRect = getWorldRect();
    if (!worldRect) return;
    splitDrag.current = { index, worldRect, zoom: vpRef.current.zoom };
    setSplitDragging(true);
  };

  const splitMove = (e: ReactPointerEvent) => {
    const sd = splitDrag.current;
    if (!sd || !sLayer || !split || !onSplitCuts) return;
    const t = sLayer.transform;
    const dim = split.axis === "x" ? sLayer.naturalWidth : sLayer.naturalHeight;
    let p = screenToDoc(e.clientX, e.clientY, sd.worldRect, sd.zoom);
    // Snap the cut to grid/elements when the layer is axis-aligned (rotation 0).
    if (t.rotation === 0 && snapEnabled) {
      const cfg = { enabled: true, grid: gridEnabled, gridDivisions };
      const { dx, dy } = computeSnap(
        split.axis === "x" ? [p.x] : [],
        split.axis === "y" ? [p.y] : [],
        doc,
        [sLayer.id],
        cfg,
        SNAP_PX / sd.zoom
      );
      p = { x: p.x + dx, y: p.y + dy };
    }
    const local = inverseLocal(t, p);
    const v = Math.max(1, Math.min(dim - 1, split.axis === "x" ? local.x : local.y));
    const cuts = split.cuts.slice();
    cuts[sd.index] = v;
    onSplitCuts(cuts);
  };

  const splitUp = () => {
    splitDrag.current = null;
    setSplitDragging(false);
  };

  const transparentBg =
    !doc.background || doc.background === "transparent"
      ? {
          backgroundImage:
            "linear-gradient(45deg,#3f3f46 25%,transparent 25%),linear-gradient(-45deg,#3f3f46 25%,transparent 25%),linear-gradient(45deg,transparent 75%,#3f3f46 75%),linear-gradient(-45deg,transparent 75%,#3f3f46 75%)",
          backgroundSize: "24px 24px",
          backgroundPosition: "0 0,0 12px,12px -12px,-12px 0",
          backgroundColor: "#27272a",
        }
      : { background: doc.background };

  return (
    <div
      ref={containerRef}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      className="relative h-full w-full overflow-hidden bg-zinc-950"
      style={{ touchAction: "none", cursor: panning ? "grabbing" : spaceDown ? "grab" : "default" }}
    >
      <div
        ref={worldRef}
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          width: doc.width,
          height: doc.height,
          transformOrigin: "0 0",
          transform: `translate(${vp.panX}px, ${vp.panY}px) scale(${vp.zoom})`,
          isolation: "isolate",
          boxShadow: "0 0 0 1px rgba(255,255,255,0.12), 0 8px 40px rgba(0,0,0,0.5)",
          ...transparentBg,
        }}
      >
        {doc.layers.map((layer) => (
          <LayerView key={layer.id} layer={layer} cache={cache} onSelect={onSelect} />
        ))}

        {/* Mask overlay — doc-resolution canvas, painted in mask mode. */}
        <canvas
          ref={maskCanvasRef}
          width={doc.width}
          height={doc.height}
          onPointerDown={maskDown}
          onPointerMove={maskMove}
          onPointerUp={maskUp}
          style={{
            position: "absolute",
            left: 0,
            top: 0,
            width: doc.width,
            height: doc.height,
            opacity: 0.5,
            // Yield to Space-pan (like View mode's measure surface) so holding
            // Space lets background drags pan instead of painting the mask.
            pointerEvents: mode === "ai" && !spaceDown ? "auto" : "none",
            cursor: spaceDown ? (panning ? "grabbing" : "grab") : "crosshair",
            touchAction: "none",
          }}
        />

        {/* Live rectangle-selection preview */}
        {rectPreview && (
          <div
            style={{
              position: "absolute",
              left: rectPreview.x,
              top: rectPreview.y,
              width: rectPreview.w,
              height: rectPreview.h,
              pointerEvents: "none",
              border: "2px solid #f87171",
              background: "rgba(239,68,68,0.25)",
            }}
          />
        )}

        {/* Impact area — the exact region(s) sent to the model (selection + padding). */}
        {mode === "ai" &&
          cropBoxes.map((b, i) => (
            <div
              key={i}
              style={{
                position: "absolute",
                left: b.x,
                top: b.y,
                width: b.w,
                height: b.h,
                pointerEvents: "none",
                boxSizing: "border-box",
                border: "2px dashed #22d3ee",
              }}
            >
              {i === 0 && (
                <span
                  style={{
                    position: "absolute",
                    bottom: "100%",
                    left: 0,
                    transformOrigin: "0 100%",
                    transform: `scale(${1 / vp.zoom})`,
                    whiteSpace: "nowrap",
                    padding: "2px 6px",
                    borderRadius: 4,
                    fontSize: 12,
                    color: "#0b0f14",
                    background: "#22d3ee",
                  }}
                >
                  {cropBoxes.length > 1 ? `Impact area (${cropBoxes.length})` : "Impact area"}
                </span>
              )}
            </div>
          ))}

        {/* AI region reservations: running = red hatch, frozen = blue lock.
            "review" reservations are drawn by the preview overlay below instead. */}
        {reservations
          .filter((r) => r.kind !== "review")
          .map((r) => (
            <div
              key={r.id}
              style={{
                position: "absolute",
                left: r.bbox.x,
                top: r.bbox.y,
                width: r.bbox.w,
                height: r.bbox.h,
                pointerEvents: "none",
                border: `2px solid ${r.kind === "running" ? "#f87171" : "#60a5fa"}`,
                backgroundImage: `repeating-linear-gradient(45deg, ${
                  r.kind === "running" ? "rgba(239,68,68,0.18)" : "rgba(96,165,250,0.16)"
                } 0 8px, transparent 8px 16px)`,
              }}
            >
              <span
                style={{
                  position: "absolute",
                  top: 4,
                  left: 4,
                  transformOrigin: "0 0",
                  transform: `scale(${1 / vp.zoom})`,
                  whiteSpace: "nowrap",
                  padding: "2px 6px",
                  borderRadius: 4,
                  fontSize: 12,
                  color: "#fff",
                  background: "rgba(0,0,0,0.6)",
                }}
              >
                {r.kind === "running" ? "Generating…" : "🔒 Frozen"}
              </span>
            </div>
          ))}

        {/* Pending AI results awaiting review: show the feathered patch(es) over
            the canvas (nothing is in the layer stack yet) with Accept / Reject /
            Retry, plus hold-to-compare to peek at the original beneath. */}
        {pendingResults.map((res) => {
          const hidden = comparingId === res.id;
          // Union of the result's patch bboxes — anchors the control cluster.
          const x1 = Math.min(...res.items.map((it) => it.bbox.x));
          const y1 = Math.min(...res.items.map((it) => it.bbox.y));
          const x2 = Math.max(...res.items.map((it) => it.bbox.x + it.bbox.w));
          return (
            <Fragment key={res.id}>
              {!hidden &&
                res.items.map((it, i) => (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    key={i}
                    src={it.src}
                    alt=""
                    style={{
                      position: "absolute",
                      left: it.bbox.x,
                      top: it.bbox.y,
                      width: it.bbox.w,
                      height: it.bbox.h,
                      pointerEvents: "none",
                    }}
                  />
                ))}
              {/* dashed outline so the reviewed region is visible while comparing */}
              <div
                style={{
                  position: "absolute",
                  left: x1,
                  top: y1,
                  width: x2 - x1,
                  height: Math.max(...res.items.map((it) => it.bbox.y + it.bbox.h)) - y1,
                  pointerEvents: "none",
                  boxSizing: "border-box",
                  border: "2px dashed #a78bfa",
                }}
              />
              <div
                onPointerDown={(e) => e.stopPropagation()}
                style={{
                  position: "absolute",
                  left: x1,
                  top: y1,
                  transformOrigin: "0 100%",
                  transform: `translateY(-6px) scale(${1 / vp.zoom})`,
                  marginTop: -6,
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "flex-start",
                  gap: 4,
                  pointerEvents: "auto",
                }}
              >
                <div style={{ display: "flex", gap: 4 }}>
                  <button
                    onClick={() => onAcceptResult?.(res.id)}
                    style={pendingBtn("#16a34a")}
                    title="Keep this result (adds it as a layer)"
                  >
                    ✓ Accept
                  </button>
                  <button
                    onClick={() => onRetryResult?.(res.id)}
                    style={pendingBtn("#7c3aed")}
                    title="Try again with the SAME instruction (re-rolls the original ask)"
                  >
                    ↻ Retry
                  </button>
                  <button
                    onClick={() => {
                      setEditingResultId((cur) => (cur === res.id ? null : res.id));
                      setEditText("");
                    }}
                    style={pendingBtn(editingResultId === res.id ? "#4338ca" : "#6366f1")}
                    title="Edit this result with a NEW instruction (refines the generated image)"
                  >
                    ✎ Edit
                  </button>
                  <button
                    onClick={() => onRejectResult?.(res.id)}
                    style={pendingBtn("#52525b")}
                    title="Discard this result"
                  >
                    ✕ Reject
                  </button>
                  <button
                    onPointerDown={() => setComparingId(res.id)}
                    onPointerUp={() => setComparingId(null)}
                    onPointerLeave={() => setComparingId((c) => (c === res.id ? null : c))}
                    style={pendingBtn("#3f3f46")}
                    title="Hold to compare with the original"
                  >
                    ⇄ Compare
                  </button>
                </div>
                {editingResultId === res.id && (
                  <div style={{ display: "flex", gap: 4 }}>
                    <input
                      autoFocus
                      value={editText}
                      onChange={(e) => setEditText(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && editText.trim()) {
                          onEditResult?.(res.id, editText.trim());
                          setEditingResultId(null);
                          setEditText("");
                        } else if (e.key === "Escape") {
                          setEditingResultId(null);
                          setEditText("");
                        }
                      }}
                      placeholder="Describe a change to this result…"
                      style={{
                        width: 260,
                        padding: "5px 9px",
                        borderRadius: 6,
                        fontSize: 13,
                        color: "#fff",
                        background: "#27272a",
                        border: "1px solid #52525b",
                        outline: "none",
                      }}
                    />
                    <button
                      onClick={() => {
                        if (!editText.trim()) return;
                        onEditResult?.(res.id, editText.trim());
                        setEditingResultId(null);
                        setEditText("");
                      }}
                      style={pendingBtn("#6366f1")}
                      title="Generate from this result with the new instruction"
                    >
                      Go
                    </button>
                  </div>
                )}
              </div>
            </Fragment>
          );
        })}

        {/* Grid overlay — rendered last so it sits on top of the layers. */}
        {gridEnabled && (
          <div
            className="pointer-events-none absolute left-0 top-0"
            style={{
              width: doc.width,
              height: doc.height,
              // Neutral gray so the grid is visible on both a light canvas and
              // dark content layers (it renders on top of everything).
              backgroundImage:
                "linear-gradient(to right, rgba(127,127,127,0.5) 1px, transparent 1px), linear-gradient(to bottom, rgba(127,127,127,0.5) 1px, transparent 1px)",
              backgroundSize: `${doc.width / Math.max(1, gridDivisions)}px ${doc.height / Math.max(1, gridDivisions)}px`,
            }}
          />
        )}
      </div>

      {mode === "manual" && single && !split && (
        <TransformBox
          layer={single}
          viewport={vp}
          getWorldRect={getWorldRect}
          snap={{ enabled: snapEnabled, grid: gridEnabled, gridDivisions }}
          onSelect={onSelect}
        />
      )}

      {mode === "manual" && selectedLayers.length > 1 && !split && (
        <GroupBox
          layers={selectedLayers}
          viewport={vp}
          getWorldRect={getWorldRect}
          snap={{ enabled: snapEnabled, grid: gridEnabled, gridDivisions }}
          onSelect={onSelect}
        />
      )}

      {/* Split cut lines over the targeted raster layer (follow its transform). */}
      {sLayer && split && (
        <>
          <svg className="pointer-events-none absolute inset-0 z-[22] h-full w-full overflow-visible">
            {split.cuts.map((c, i) => {
              const t = sLayer.transform;
              const a = split.axis === "x" ? affinePoint(t, c, 0) : affinePoint(t, 0, c);
              const b = split.axis === "x" ? affinePoint(t, c, sLayer.naturalHeight) : affinePoint(t, sLayer.naturalWidth, c);
              const A = toPx(a);
              const B = toPx(b);
              return <line key={i} x1={A.x} y1={A.y} x2={B.x} y2={B.y} stroke="#22d3ee" strokeWidth={1.5} strokeDasharray="5 4" />;
            })}
          </svg>
          {split.cuts.map((c, i) => {
            const t = sLayer.transform;
            const a = split.axis === "x" ? affinePoint(t, c, 0) : affinePoint(t, 0, c);
            const b = split.axis === "x" ? affinePoint(t, c, sLayer.naturalHeight) : affinePoint(t, sLayer.naturalWidth, c);
            const M = midpoint(toPx(a), toPx(b));
            return (
              <div
                key={i}
                onPointerDown={cutHandleDown(i)}
                className="absolute z-[23]"
                style={{
                  left: M.x - 7,
                  top: M.y - 7,
                  width: 14,
                  height: 14,
                  borderRadius: "50%",
                  background: "#22d3ee",
                  border: "2px solid #0e7490",
                  cursor: split.axis === "x" ? "ew-resize" : "ns-resize",
                  touchAction: "none",
                }}
              />
            );
          })}
        </>
      )}

      {splitDragging && (
        <div
          className="fixed inset-0 z-[60]"
          style={{ cursor: split?.axis === "x" ? "ew-resize" : "ns-resize", touchAction: "none" }}
          onPointerMove={splitMove}
          onPointerUp={splitUp}
          onPointerLeave={splitUp}
        />
      )}

      {/* Measure surface — captures drags to create rulers in View mode. */}
      {mode === "view" && (
        <div
          onPointerDown={measureDown}
          className="absolute inset-0 z-10"
          style={{ pointerEvents: spaceDown ? "none" : "auto", cursor: "crosshair", touchAction: "none" }}
        />
      )}

      {/* Measurement lines/rects (constant stroke, container space, all modes). */}
      <svg className="pointer-events-none absolute inset-0 z-[15] h-full w-full overflow-visible">
        {rulers.map((a) => {
          const A = toPx({ x: a.ax, y: a.ay });
          const B = toPx({ x: a.bx, y: a.by });
          return <line key={a.id} x1={A.x} y1={A.y} x2={B.x} y2={B.y} stroke="#f59e0b" strokeWidth={1.5} />;
        })}
        {preview &&
          (() => {
            const A = toPx({ x: preview.ax, y: preview.ay });
            const B = toPx({ x: preview.bx, y: preview.by });
            return <line x1={A.x} y1={A.y} x2={B.x} y2={B.y} stroke="#f59e0b" strokeWidth={1.5} strokeDasharray="6 4" />;
          })()}
        {areas.map((a) => {
          const tl = toPx({ x: a.x, y: a.y });
          const wpx = a.w * vp.zoom;
          const hpx = a.h * vp.zoom;
          const lines = areaSplitLines(a);
          return (
            <Fragment key={a.id}>
              <rect x={tl.x} y={tl.y} width={wpx} height={hpx} fill="none" stroke="#f59e0b" strokeWidth={1.5} />
              {lines.xs.map((vx, i) => {
                const p = toPx({ x: vx, y: a.y });
                return <line key={`x${i}`} x1={p.x} y1={tl.y} x2={p.x} y2={tl.y + hpx} stroke="#f59e0b" strokeWidth={1} strokeDasharray="4 3" />;
              })}
              {lines.ys.map((vy, i) => {
                const p = toPx({ x: a.x, y: vy });
                return <line key={`y${i}`} x1={tl.x} y1={p.y} x2={tl.x + wpx} y2={p.y} stroke="#f59e0b" strokeWidth={1} strokeDasharray="4 3" />;
              })}
            </Fragment>
          );
        })}
        {areaPreview &&
          (() => {
            const tl = toPx({ x: areaPreview.x, y: areaPreview.y });
            return (
              <rect x={tl.x} y={tl.y} width={areaPreview.w * vp.zoom} height={areaPreview.h * vp.zoom} fill="rgba(245,158,11,0.10)" stroke="#f59e0b" strokeWidth={1.5} strokeDasharray="6 4" />
            );
          })()}
      </svg>

      {/* Ruler endpoints + labels (container space). */}
      {rulers.map((a) => {
        const A = toPx({ x: a.ax, y: a.ay });
        const B = toPx({ x: a.bx, y: a.by });
        const M = midpoint(A, B);
        const len = Math.round(Math.hypot(a.bx - a.ax, a.by - a.ay));
        const ang = Math.round((Math.atan2(a.by - a.ay, a.bx - a.ax) * 180) / Math.PI);
        return (
          <Fragment key={a.id}>
            {mode === "view" &&
              ([["a", A], ["b", B]] as const).map(([which, P]) => (
                <div
                  key={which}
                  onPointerDown={endpointDown(a.id, which)}
                  className="absolute z-20"
                  style={{ left: P.x - 6, top: P.y - 6, width: 12, height: 12, borderRadius: "50%", background: "#f59e0b", border: "2px solid #1c1917", cursor: "move", touchAction: "none" }}
                />
              ))}
            <div
              className="absolute z-20 flex items-center gap-1 rounded font-medium"
              style={{
                left: M.x,
                top: M.y,
                transform: "translate(-50%, -50%)",
                pointerEvents: mode === "view" ? "auto" : "none",
                whiteSpace: "nowrap",
                padding: "1px 6px",
                fontSize: 11,
                color: "#1c1917",
                background: "#f59e0b",
              }}
            >
              {len} px · {ang}°
              {mode === "view" && (
                <button
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={() => doAction({ type: "ANNOTATION_DELETE", id: a.id })}
                  className="ml-0.5 rounded px-1 text-[10px] hover:bg-black/20"
                  title="Delete measurement"
                >
                  ✕
                </button>
              )}
            </div>
          </Fragment>
        );
      })}

      {/* Area bodies, corner handles, and size labels (container space). */}
      {areas.map((a) => {
        const tl = toPx({ x: a.x, y: a.y });
        const wpx = a.w * vp.zoom;
        const hpx = a.h * vp.zoom;
        const isSel = a.id === selectedAnnotationId;
        const corners: { key: string; cx: number; cy: number; fixed: Vec; cur: string }[] = [
          { key: "tl", cx: a.x, cy: a.y, fixed: { x: a.x + a.w, y: a.y + a.h }, cur: "nwse-resize" },
          { key: "tr", cx: a.x + a.w, cy: a.y, fixed: { x: a.x, y: a.y + a.h }, cur: "nesw-resize" },
          { key: "br", cx: a.x + a.w, cy: a.y + a.h, fixed: { x: a.x, y: a.y }, cur: "nwse-resize" },
          { key: "bl", cx: a.x, cy: a.y + a.h, fixed: { x: a.x + a.w, y: a.y }, cur: "nesw-resize" },
        ];
        const section =
          a.splitAxis !== "none" && a.splitCount > 1
            ? ` · ${a.splitCount}${a.splitAxis === "x" ? " cols" : " rows"} (${Math.round((a.splitAxis === "x" ? a.w : a.h) / a.splitCount)} px)`
            : "";
        return (
          <Fragment key={a.id}>
            {mode === "view" && (
              <div
                onPointerDown={areaBodyDown(a)}
                className="absolute z-20"
                style={{
                  left: tl.x,
                  top: tl.y,
                  width: wpx,
                  height: hpx,
                  cursor: "move",
                  touchAction: "none",
                  background: isSel ? "rgba(245,158,11,0.06)" : "transparent",
                  outline: isSel ? "1px solid rgba(245,158,11,0.6)" : "none",
                }}
              />
            )}
            {mode === "view" &&
              isSel &&
              corners.map((c) => {
                const P = toPx({ x: c.cx, y: c.cy });
                return (
                  <div
                    key={c.key}
                    onPointerDown={areaCornerDown(a, c.fixed)}
                    className="absolute z-[21]"
                    style={{ left: P.x - 6, top: P.y - 6, width: 12, height: 12, background: "#fff", border: "2px solid #b45309", borderRadius: 2, cursor: c.cur, touchAction: "none" }}
                  />
                );
              })}
            <div
              className="absolute z-[21] flex items-center gap-1 rounded font-medium"
              style={{
                left: tl.x,
                top: tl.y - 22,
                pointerEvents: mode === "view" ? "auto" : "none",
                whiteSpace: "nowrap",
                padding: "1px 6px",
                fontSize: 11,
                color: "#1c1917",
                background: "#f59e0b",
              }}
            >
              {Math.round(a.w)} × {Math.round(a.h)} px{section}
              {mode === "view" && (
                <button
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={() => doAction({ type: "ANNOTATION_DELETE", id: a.id })}
                  className="ml-0.5 rounded px-1 text-[10px] hover:bg-black/20"
                  title="Delete area"
                >
                  ✕
                </button>
              )}
            </div>
          </Fragment>
        );
      })}

      {/* Snap indicator */}
      {snapHit &&
        (() => {
          const P = toPx(snapHit);
          return (
            <div
              className="pointer-events-none absolute z-20"
              style={{ left: P.x - 9, top: P.y - 9, width: 18, height: 18, borderRadius: "50%", border: "2px solid #22d3ee" }}
            />
          );
        })()}

      {/* Guide lines (canvas-spanning), clipped to start past the ruler strips. */}
      <svg className="pointer-events-none absolute inset-0 z-[16] h-full w-full overflow-visible">
        {guides.map((g) => {
          const sel = g.id === selectedAnnotationId;
          const stroke = sel ? "#67e8f9" : "#22d3ee";
          const sw = sel ? 2 : 1;
          if (g.axis === "x") {
            const X = vp.panX + g.value * vp.zoom;
            return X < RULER || X > containerSize.w ? null : <line key={g.id} x1={X} y1={RULER} x2={X} y2={containerSize.h} stroke={stroke} strokeWidth={sw} />;
          }
          const Y = vp.panY + g.value * vp.zoom;
          return Y < RULER || Y > containerSize.h ? null : <line key={g.id} x1={RULER} y1={Y} x2={containerSize.w} y2={Y} stroke={stroke} strokeWidth={sw} />;
        })}
      </svg>

      {/* Grab handles to reposition / delete existing guides (all modes). The
          thin hit strip sits on the line itself; drop on a ruler to remove. */}
      {guides.map((g) => {
          if (g.axis === "x") {
            const X = vp.panX + g.value * vp.zoom;
            if (X < RULER || X > containerSize.w) return null;
            return <div key={g.id} onPointerDown={guideStart(g.axis, g.id)} className="absolute z-20" style={{ left: X - 3, top: RULER, width: 6, height: containerSize.h - RULER, cursor: "ew-resize", touchAction: "none" }} title="Drag to move · drop on the ruler to remove" />;
          }
          const Y = vp.panY + g.value * vp.zoom;
          if (Y < RULER || Y > containerSize.h) return null;
          return <div key={g.id} onPointerDown={guideStart(g.axis, g.id)} className="absolute z-20" style={{ left: RULER, top: Y - 3, width: containerSize.w - RULER, height: 6, cursor: "ns-resize", touchAction: "none" }} title="Drag to move · drop on the ruler to remove" />;
        })}

      {/* Selected guide: value pill + delete button anchored at the ruler edge. */}
      {guides.map((g) => {
        if (g.id !== selectedAnnotationId) return null;
        const isX = g.axis === "x";
        const X = vp.panX + g.value * vp.zoom;
        const Y = vp.panY + g.value * vp.zoom;
        if (isX ? X < RULER || X > containerSize.w : Y < RULER || Y > containerSize.h) return null;
        return (
          <div
            key={g.id}
            className="absolute z-[21] flex items-center gap-1 rounded font-medium tabular-nums"
            style={{ left: isX ? X + 4 : RULER + 4, top: isX ? RULER + 4 : Y + 4, padding: "1px 6px", fontSize: 11, color: "#06212a", background: "#22d3ee", whiteSpace: "nowrap" }}
          >
            {isX ? "X" : "Y"} {formatRulerValue(g.value, rulerUnit, isX ? doc.width : doc.height)}
            <button
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => {
                doAction({ type: "ANNOTATION_DELETE", id: g.id });
                onSelectAnnotation?.(null);
              }}
              className="ml-0.5 rounded px-1 text-[10px] hover:bg-black/20"
              title="Delete guide"
            >
              ✕
            </button>
          </div>
        );
      })}

      {/* Full-window capture while measuring. */}
      {measuring && (
        <div
          className="fixed inset-0 z-[60]"
          style={{ cursor: "crosshair", touchAction: "none" }}
          onPointerMove={measureMove}
          onPointerUp={measureUp}
          onPointerLeave={measureUp}
        />
      )}

      {/* Full-window capture while dragging a guide out of / along a ruler. */}
      {guideDrag && (
        <div
          className="fixed inset-0 z-[60]"
          style={{ cursor: guideDrag.axis === "x" ? "ew-resize" : "ns-resize", touchAction: "none" }}
          onPointerMove={guideMove}
          onPointerUp={guideUp}
          onPointerLeave={guideUp}
        />
      )}

      {/* Canvas dimension rulers along the top/left edges — always visible,
          zoom-aware, with a selectable unit. */}
      <CanvasRulers
        vp={vp}
        containerW={containerSize.w}
        containerH={containerSize.h}
        docWidth={doc.width}
        docHeight={doc.height}
        unit={rulerUnit}
        onUnitChange={changeUnit}
      />

      {/* Pull a guide out of a ruler edge: top → vertical guide (X), left →
          horizontal guide (Y). Sit above the rulers so they catch the drag. */}
      {containerSize.w > RULER && containerSize.h > RULER && (
        <>
          <div
            onPointerDown={guideStart("x")}
            className="absolute z-[41]"
            style={{ left: RULER, top: 0, width: containerSize.w - RULER, height: RULER, cursor: "col-resize", touchAction: "none" }}
            title="Drag down to add a vertical guide"
          />
          <div
            onPointerDown={guideStart("y")}
            className="absolute z-[41]"
            style={{ left: 0, top: RULER, width: RULER, height: containerSize.h - RULER, cursor: "row-resize", touchAction: "none" }}
            title="Drag right to add a horizontal guide"
          />
        </>
      )}

      {/* Live guide while dragging: dashed line + precise value at the ruler. */}
      {guideDrag &&
        (() => {
          const color = guideDrag.onRuler ? "#ef4444" : "#22d3ee";
          const isX = guideDrag.axis === "x";
          const X = vp.panX + guideDrag.value * vp.zoom;
          const Y = vp.panY + guideDrag.value * vp.zoom;
          const label = guideDrag.onRuler
            ? "Release to remove"
            : `${isX ? "X" : "Y"} ${formatRulerValue(guideDrag.value, rulerUnit, isX ? doc.width : doc.height)}`;
          return (
            <>
              <svg className="pointer-events-none absolute inset-0 z-[45] h-full w-full overflow-visible">
                {isX ? (
                  <line x1={X} y1={RULER} x2={X} y2={containerSize.h} stroke={color} strokeWidth={1} strokeDasharray="4 3" />
                ) : (
                  <line x1={RULER} y1={Y} x2={containerSize.w} y2={Y} stroke={color} strokeWidth={1} strokeDasharray="4 3" />
                )}
              </svg>
              <div
                className="pointer-events-none absolute z-[46] rounded font-medium tabular-nums"
                style={{ left: isX ? X + 4 : RULER + 4, top: isX ? RULER + 4 : Y + 4, padding: "1px 6px", fontSize: 11, color: "#06212a", background: color, whiteSpace: "nowrap" }}
              >
                {label}
              </div>
            </>
          );
        })()}

      {/* Zoom controls (stop pointer events from reaching the pan handler). */}
      <div
        onPointerDown={(e) => e.stopPropagation()}
        className="absolute bottom-4 left-7 z-30 flex items-center gap-0.5 rounded-lg border border-zinc-700 bg-zinc-900/90 p-1 text-zinc-300 shadow-lg backdrop-blur"
      >
        <button
          onClick={() => applyZoom(vp.zoom / 1.25)}
          title="Zoom out"
          className="flex h-7 w-7 items-center justify-center rounded hover:bg-zinc-800 hover:text-white"
        >
          −
        </button>
        <button
          onClick={() => applyZoom(1)}
          title="Reset to 100%"
          className="min-w-[3.25rem] rounded px-1 text-center text-xs tabular-nums hover:bg-zinc-800 hover:text-white"
        >
          {Math.round(vp.zoom * 100)}%
        </button>
        <button
          onClick={() => applyZoom(vp.zoom * 1.25)}
          title="Zoom in"
          className="flex h-7 w-7 items-center justify-center rounded hover:bg-zinc-800 hover:text-white"
        >
          +
        </button>
        <button
          onClick={fitToView}
          title="Fit to screen"
          className="rounded px-2 py-1 text-xs hover:bg-zinc-800 hover:text-white"
        >
          Fit
        </button>
      </div>
    </div>
  );
}
