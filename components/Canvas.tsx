"use client";

import { useRef, useEffect, useCallback, useState, forwardRef, useImperativeHandle } from "react";
import { getMaskRegions, type BBox } from "@/lib/crop-inpaint-stitch";

export type MaskTool = "brush" | "rect";

interface Props {
  image: HTMLImageElement | null;
  brushSize: number;
  maskEnabled: boolean;
  maskVisible?: boolean;
  maskOpacity?: number;
  tool?: MaskTool;
  cropPadding?: number;
  cropSquare?: boolean;
  manualCrop?: BBox | null;
  onManualCropChange?: (bbox: BBox | null) => void;
  comparing?: boolean;
  compareSrc?: string | null;
  displayWidth: number;
  displayHeight: number;
  onMaskChange?: (hasMask: boolean) => void;
}

export interface CanvasHandle {
  getImageCanvas: () => HTMLCanvasElement | null;
  getMaskCanvas: () => HTMLCanvasElement | null;
  clearMask: () => void;
  setImage: (img: HTMLImageElement) => void;
  undo: () => void;
}

const MASK_RGB = "255, 50, 50";
// Painted solid; transparency is applied once as a CSS layer opacity so
// overlapping strokes never accumulate to opaque.
const MASK_FILL = `rgba(${MASK_RGB}, 1)`;

const Canvas = forwardRef<CanvasHandle, Props>(function Canvas(
  {
    image,
    brushSize,
    maskEnabled,
    maskVisible = true,
    maskOpacity = 0.5,
    tool = "brush",
    cropPadding = 2.0,
    cropSquare = false,
    manualCrop = null,
    onManualCropChange,
    comparing = false,
    compareSrc = null,
    displayWidth,
    displayHeight,
    onMaskChange,
  },
  ref
) {
  const imageCanvasRef = useRef<HTMLCanvasElement>(null);
  const maskCanvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const isDrawing = useRef(false);
  const lastPos = useRef<{ x: number; y: number } | null>(null);
  const maskHistory = useRef<ImageData[]>([]);
  const [cursorPos, setCursorPos] = useState<{ x: number; y: number } | null>(null);

  // Rectangle tool: start/current in canvas pixels, the display-space anchor for the
  // live preview, plus the preview rect itself (display coords).
  const rectStart = useRef<{ x: number; y: number } | null>(null);
  const rectCurrent = useRef<{ x: number; y: number } | null>(null);
  const startDisplay = useRef<{ x: number; y: number } | null>(null);
  const [rectPreview, setRectPreview] = useState<{ x: number; y: number; w: number; h: number } | null>(null);

  // The exact region(s) that will be sent to the model (native px) — one per
  // non-contiguous mask blob.
  const [cropBoxes, setCropBoxes] = useState<BBox[]>([]);

  // Before/after comparison slider (percentage from the left).
  const [dividerPct, setDividerPct] = useState(50);
  const [draggingDivider, setDraggingDivider] = useState(false);
  // Offset between the cursor and the divider at grab time, so dragging doesn't jump.
  const dividerGrabDx = useRef(0);

  const nativeWidth = image?.naturalWidth || 800;
  const nativeHeight = image?.naturalHeight || 600;
  const scaleX = displayWidth / nativeWidth;
  const scaleY = displayHeight / nativeHeight;

  const recomputeCropBox = useCallback(() => {
    const mask = maskCanvasRef.current;
    setCropBoxes(mask ? getMaskRegions(mask, cropPadding, cropSquare) : []);
  }, [cropPadding, cropSquare]);

  useImperativeHandle(ref, () => ({
    getImageCanvas: () => imageCanvasRef.current,
    getMaskCanvas: () => maskCanvasRef.current,
    clearMask: () => {
      const ctx = maskCanvasRef.current?.getContext("2d");
      if (ctx && maskCanvasRef.current) {
        ctx.clearRect(0, 0, maskCanvasRef.current.width, maskCanvasRef.current.height);
      }
      setCropBoxes([]);
      setRectPreview(null);
      onMaskChange?.(false);
    },
    setImage: (img: HTMLImageElement) => {
      const canvas = imageCanvasRef.current;
      if (!canvas) return;
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext("2d")!;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0);

      const mask = maskCanvasRef.current;
      if (mask) {
        mask.width = img.naturalWidth;
        mask.height = img.naturalHeight;
        mask.getContext("2d")!.clearRect(0, 0, mask.width, mask.height);
      }
      maskHistory.current = [];
      setCropBoxes([]);
      setRectPreview(null);
    },
    undo: () => {
      const ctx = maskCanvasRef.current?.getContext("2d");
      if (!ctx || !maskCanvasRef.current) return;
      if (maskHistory.current.length > 0) {
        const prev = maskHistory.current.pop()!;
        ctx.putImageData(prev, 0, 0);
      } else {
        ctx.clearRect(0, 0, maskCanvasRef.current.width, maskCanvasRef.current.height);
      }
      recomputeCropBox();
    },
  }));

  useEffect(() => {
    if (!image || !imageCanvasRef.current || !maskCanvasRef.current) return;
    const canvas = imageCanvasRef.current;
    const mask = maskCanvasRef.current;
    canvas.width = nativeWidth;
    canvas.height = nativeHeight;
    mask.width = nativeWidth;
    mask.height = nativeHeight;

    const ctx = canvas.getContext("2d")!;
    ctx.clearRect(0, 0, nativeWidth, nativeHeight);
    ctx.drawImage(image, 0, 0);

    mask.getContext("2d")!.clearRect(0, 0, nativeWidth, nativeHeight);
    maskHistory.current = [];
    setCropBoxes([]);
    setRectPreview(null);
  }, [image, nativeWidth, nativeHeight]);

  // Re-evaluate the sent-region preview when the padding (backend) changes.
  useEffect(() => {
    recomputeCropBox();
  }, [recomputeCropBox]);

  const getCanvasCoords = useCallback(
    (clientX: number, clientY: number): { x: number; y: number } | null => {
      const canvas = maskCanvasRef.current;
      if (!canvas) return null;
      const rect = canvas.getBoundingClientRect();
      const sx = canvas.width / rect.width;
      const sy = canvas.height / rect.height;
      return { x: (clientX - rect.left) * sx, y: (clientY - rect.top) * sy };
    },
    []
  );

  const getDisplayCoords = useCallback((clientX: number, clientY: number) => {
    const rect = maskCanvasRef.current?.getBoundingClientRect();
    if (!rect) return null;
    return { x: clientX - rect.left, y: clientY - rect.top };
  }, []);

  const saveMaskState = useCallback(() => {
    const ctx = maskCanvasRef.current?.getContext("2d");
    if (!ctx || !maskCanvasRef.current) return;
    const data = ctx.getImageData(0, 0, maskCanvasRef.current.width, maskCanvasRef.current.height);
    maskHistory.current.push(data);
    if (maskHistory.current.length > 30) maskHistory.current.shift();
  }, []);

  const drawBrush = useCallback(
    (x: number, y: number) => {
      const ctx = maskCanvasRef.current?.getContext("2d");
      if (!ctx) return;
      const scale = maskCanvasRef.current!.width / displayWidth;
      const r = (brushSize / 2) * scale;
      ctx.fillStyle = MASK_FILL;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    },
    [brushSize, displayWidth]
  );

  const drawLine = useCallback(
    (from: { x: number; y: number }, to: { x: number; y: number }) => {
      const ctx = maskCanvasRef.current?.getContext("2d");
      if (!ctx) return;
      const scale = maskCanvasRef.current!.width / displayWidth;
      const r = (brushSize / 2) * scale;
      ctx.strokeStyle = MASK_FILL;
      ctx.lineWidth = r * 2;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.beginPath();
      ctx.moveTo(from.x, from.y);
      ctx.lineTo(to.x, to.y);
      ctx.stroke();
    },
    [brushSize, displayWidth]
  );

  const startStroke = useCallback(
    (clientX: number, clientY: number) => {
      if (comparing || !maskEnabled || !maskVisible || !image) return;
      const pos = getCanvasCoords(clientX, clientY);
      if (!pos) return;
      saveMaskState();
      isDrawing.current = true;

      if (tool === "rect") {
        rectStart.current = pos;
        rectCurrent.current = pos;
        const d = getDisplayCoords(clientX, clientY);
        if (d) setRectPreview({ x: d.x, y: d.y, w: 0, h: 0 });
        return;
      }

      lastPos.current = pos;
      drawBrush(pos.x, pos.y);
      onMaskChange?.(true);
    },
    [comparing, maskEnabled, maskVisible, image, tool, getCanvasCoords, getDisplayCoords, saveMaskState, drawBrush, onMaskChange]
  );

  const onDividerMove = useCallback(
    (e: React.MouseEvent) => {
      const d = getDisplayCoords(e.clientX, e.clientY);
      if (!d) return;
      const x = d.x - dividerGrabDx.current;
      setDividerPct(Math.max(2, Math.min(98, (x / displayWidth) * 100)));
    },
    [getDisplayCoords, displayWidth]
  );

  const moveStroke = useCallback(
    (clientX: number, clientY: number) => {
      if (!isDrawing.current || !maskEnabled) return;

      if (tool === "rect") {
        const pos = getCanvasCoords(clientX, clientY);
        if (pos) rectCurrent.current = pos;
        const d = getDisplayCoords(clientX, clientY);
        const ds = startDisplay.current;
        if (d && ds) {
          setRectPreview({
            x: Math.min(ds.x, d.x),
            y: Math.min(ds.y, d.y),
            w: Math.abs(d.x - ds.x),
            h: Math.abs(d.y - ds.y),
          });
        }
        return;
      }

      const pos = getCanvasCoords(clientX, clientY);
      if (!pos) return;
      if (lastPos.current) drawLine(lastPos.current, pos);
      drawBrush(pos.x, pos.y);
      lastPos.current = pos;
    },
    [maskEnabled, tool, getCanvasCoords, getDisplayCoords, drawBrush, drawLine]
  );

  const endStroke = useCallback(() => {
    if (tool === "rect" && isDrawing.current) {
      const a = rectStart.current;
      const b = rectCurrent.current;
      if (a && b) {
        const x = Math.min(a.x, b.x);
        const y = Math.min(a.y, b.y);
        const w = Math.abs(b.x - a.x);
        const h = Math.abs(b.y - a.y);
        if (w > 2 && h > 2) {
          const ctx = maskCanvasRef.current?.getContext("2d");
          if (ctx) {
            ctx.fillStyle = MASK_FILL;
            ctx.fillRect(x, y, w, h);
            onMaskChange?.(true);
          }
        }
      }
      rectStart.current = null;
      rectCurrent.current = null;
      startDisplay.current = null;
      setRectPreview(null);
    }
    isDrawing.current = false;
    lastPos.current = null;
    recomputeCropBox();
  }, [tool, onMaskChange, recomputeCropBox]);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      startDisplay.current = getDisplayCoords(e.clientX, e.clientY);
      startStroke(e.clientX, e.clientY);
    },
    [startStroke, getDisplayCoords]
  );

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      const d = getDisplayCoords(e.clientX, e.clientY);
      if (d) setCursorPos(d);
      moveStroke(e.clientX, e.clientY);
    },
    [moveStroke, getDisplayCoords]
  );

  const handleTouchStart = useCallback(
    (e: React.TouchEvent) => {
      const t = e.touches[0];
      if (!t) return;
      if (maskEnabled && maskVisible && image) e.preventDefault();
      startDisplay.current = getDisplayCoords(t.clientX, t.clientY);
      startStroke(t.clientX, t.clientY);
    },
    [startStroke, getDisplayCoords, maskEnabled, maskVisible, image]
  );

  const handleTouchMove = useCallback(
    (e: React.TouchEvent) => {
      const t = e.touches[0];
      if (!t) return;
      if (isDrawing.current) e.preventDefault();
      moveStroke(t.clientX, t.clientY);
    },
    [moveStroke]
  );

  // Manual override (one box) wins; otherwise show every auto-detected region.
  const displayedRegions: BBox[] = manualCrop ? [manualCrop] : cropBoxes;
  // Resize handles only make sense for a single region (manual or one blob).
  const singleRegion = displayedRegions.length === 1 ? displayedRegions[0] : null;

  // Square-constrained resize: drag a corner; the opposite corner stays anchored.
  const resizeAnchor = useRef<{ x: number; y: number } | null>(null);
  const [resizing, setResizing] = useState(false);

  const beginResize = useCallback(
    (oppX: number, oppY: number) => (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      resizeAnchor.current = { x: oppX, y: oppY };
      setResizing(true);
    },
    []
  );

  const onResizeMove = useCallback(
    (e: React.MouseEvent) => {
      const a = resizeAnchor.current;
      if (!a) return;
      const p = getCanvasCoords(e.clientX, e.clientY);
      if (!p) return;
      const px = Math.max(0, Math.min(p.x, nativeWidth));
      const py = Math.max(0, Math.min(p.y, nativeHeight));

      if (cropSquare) {
        // Square-constrained (the opposite corner stays anchored).
        const dirX = px >= a.x ? 1 : -1;
        const dirY = py >= a.y ? 1 : -1;
        const maxX = dirX > 0 ? nativeWidth - a.x : a.x;
        const maxY = dirY > 0 ? nativeHeight - a.y : a.y;
        let s = Math.min(Math.abs(px - a.x), Math.abs(py - a.y));
        s = Math.max(8, Math.min(s, maxX, maxY));
        const x = dirX > 0 ? a.x : a.x - s;
        const y = dirY > 0 ? a.y : a.y - s;
        onManualCropChange?.({ x: Math.round(x), y: Math.round(y), w: Math.round(s), h: Math.round(s) });
        return;
      }

      // Free rectangle: drag a corner, opposite corner anchored.
      const x = Math.min(px, a.x);
      const y = Math.min(py, a.y);
      const w = Math.max(8, Math.abs(px - a.x));
      const h = Math.max(8, Math.abs(py - a.y));
      onManualCropChange?.({ x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) });
    },
    [getCanvasCoords, nativeWidth, nativeHeight, onManualCropChange, cropSquare]
  );

  const endResize = useCallback(() => {
    resizeAnchor.current = null;
    setResizing(false);
  }, []);

  const showRing = !!image && !!cursorPos && maskVisible && maskEnabled && tool === "brush" && !resizing && !comparing;

  const showCompare = comparing && !!compareSrc;
  const showCrop = displayedRegions.length > 0 && maskVisible && !showCompare;
  // Anchor the single count-label to the topmost-leftmost region, centered over
  // its top edge (away from the corner handles) and clamped inside the canvas.
  const labelText = displayedRegions.length > 1 ? `Areas sent to AI (${displayedRegions.length})` : "Area sent to AI";
  const labelW = displayedRegions.length > 1 ? 132 : 92;
  const anchor = showCrop
    ? displayedRegions.reduce((a, b) => (b.y < a.y || (b.y === a.y && b.x < a.x) ? b : a))
    : null;
  const labelPos = anchor
    ? {
        left: Math.max(0, Math.min(anchor.x * scaleX + (anchor.w * scaleX - labelW) / 2, displayWidth - labelW)),
        top: Math.max(0, Math.min(anchor.y * scaleY, displayHeight - 16)),
      }
    : null;

  // Corner handles for the single region: [displayX, displayY, oppXnative, oppYnative, cursor]
  const handles = singleRegion
    ? ([
        [singleRegion.x, singleRegion.y, singleRegion.x + singleRegion.w, singleRegion.y + singleRegion.h, "nwse-resize"],
        [singleRegion.x + singleRegion.w, singleRegion.y, singleRegion.x, singleRegion.y + singleRegion.h, "nesw-resize"],
        [singleRegion.x, singleRegion.y + singleRegion.h, singleRegion.x + singleRegion.w, singleRegion.y, "nesw-resize"],
        [singleRegion.x + singleRegion.w, singleRegion.y + singleRegion.h, singleRegion.x, singleRegion.y, "nwse-resize"],
      ] as const)
    : [];

  return (
    <div
      ref={containerRef}
      className="relative"
      style={{
        width: displayWidth,
        height: displayHeight,
        cursor:
          image && maskEnabled && maskVisible
            ? tool === "rect"
              ? "crosshair"
              : "none"
            : "default",
      }}
      onMouseLeave={() => {
        setCursorPos(null);
        endStroke();
      }}
    >
      <canvas
        ref={imageCanvasRef}
        className="absolute top-0 left-0 rounded-lg"
        style={{ width: displayWidth, height: displayHeight }}
      />
      <canvas
        ref={maskCanvasRef}
        className="absolute top-0 left-0 rounded-lg transition-opacity touch-none"
        style={{
          width: displayWidth,
          height: displayHeight,
          opacity: showCompare ? 0 : maskVisible ? maskOpacity : 0,
          pointerEvents: showCompare ? "none" : "auto",
        }}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={endStroke}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={endStroke}
      />

      {/* Before/after comparison: the previous image revealed left of the divider */}
      {showCompare && (
        <>
          <img
            src={compareSrc!}
            alt="before"
            draggable={false}
            className="absolute top-0 left-0 rounded-lg select-none pointer-events-none"
            style={{ width: displayWidth, height: displayHeight, clipPath: `inset(0 ${100 - dividerPct}% 0 0)` }}
          />
          <div
            className="absolute top-0 bottom-0 z-30 w-0.5 -translate-x-1/2 bg-white/90 pointer-events-none"
            style={{ left: `${dividerPct}%` }}
          />
          <div
            onMouseDown={(e) => {
              e.preventDefault();
              const d = getDisplayCoords(e.clientX, e.clientY);
              dividerGrabDx.current = d ? d.x - (dividerPct / 100) * displayWidth : 0;
              setDraggingDivider(true);
            }}
            className="absolute z-40 flex h-8 w-8 -translate-x-1/2 -translate-y-1/2 cursor-ew-resize items-center justify-center rounded-full border-2 border-white bg-zinc-900/80 text-white shadow-lg"
            style={{ left: `${dividerPct}%`, top: "50%" }}
          >
            <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7l-5 5 5 5M16 7l5 5-5 5" />
            </svg>
          </div>
          <span className="absolute top-2 left-2 z-30 rounded bg-black/70 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-white pointer-events-none">
            Before
          </span>
          <span className="absolute top-2 right-2 z-30 rounded bg-black/70 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-white pointer-events-none">
            After
          </span>
          {draggingDivider && (
            <div
              className="absolute inset-0 z-50 cursor-ew-resize"
              onMouseMove={onDividerMove}
              onMouseUp={() => setDraggingDivider(false)}
              onMouseLeave={() => setDraggingDivider(false)}
            />
          )}
        </>
      )}

      {/* Live rectangle-selection preview */}
      {!showCompare && rectPreview && tool === "rect" && (
        <div
          className="absolute pointer-events-none rounded-sm border-2 border-red-400 bg-red-500/20"
          style={{ left: rectPreview.x, top: rectPreview.y, width: rectPreview.w, height: rectPreview.h }}
        />
      )}

      {/* Exact region(s) that will be sent to the model (drag corners to resize) */}
      {showCrop &&
        displayedRegions.map((b, i) => (
          <div
            key={i}
            className={`absolute z-20 pointer-events-none rounded-sm border-2 border-dashed ${
              manualCrop ? "border-cyan-300" : "border-cyan-400/90"
            }`}
            style={{ left: b.x * scaleX, top: b.y * scaleY, width: b.w * scaleX, height: b.h * scaleY }}
          />
        ))}

      {/* Label — centered over the top region, clamped inside the canvas so it's
          never clipped, never under the toolbar, and never over the corner handles */}
      {labelPos && (
        <span
          className="absolute z-30 flex items-center gap-1 rounded-sm px-1 py-0.5 text-[10px] font-medium leading-none bg-cyan-400 text-zinc-900 whitespace-nowrap pointer-events-none"
          style={{ left: labelPos.left, top: labelPos.top }}
        >
          {labelText}
          {manualCrop && (
            <button
              onClick={() => onManualCropChange?.(null)}
              title="Reset to automatic"
              className="pointer-events-auto -my-0.5 ml-0.5 rounded bg-zinc-900/20 px-1 leading-none hover:bg-zinc-900/40"
            >
              reset
            </button>
          )}
        </span>
      )}

      {/* Corner resize handles — white-on-top and clamped inside the canvas so
          they stay visible (not hidden behind the label) and grabbable at edges */}
      {!showCompare && handles.map(([hx, hy, oppX, oppY, cur], i) => (
        <div
          key={i}
          onMouseDown={beginResize(oppX, oppY)}
          className="absolute z-40 pointer-events-auto h-3.5 w-3.5 rounded-sm border-2 border-cyan-600 bg-white shadow hover:bg-cyan-100"
          style={{
            left: Math.max(0, Math.min(hx * scaleX - 7, displayWidth - 14)),
            top: Math.max(0, Math.min(hy * scaleY - 7, displayHeight - 14)),
            cursor: cur,
          }}
        />
      ))}

      {/* Full-canvas capture layer while resizing */}
      {resizing && (
        <div
          className="absolute inset-0 z-50"
          onMouseMove={onResizeMove}
          onMouseUp={endResize}
          onMouseLeave={endResize}
        />
      )}

      {/* Brush-size cursor ring */}
      {showRing && (
        <div
          className="absolute pointer-events-none border-2 border-white/70 rounded-full"
          style={{
            width: brushSize,
            height: brushSize,
            left: cursorPos!.x - brushSize / 2,
            top: cursorPos!.y - brushSize / 2,
          }}
        />
      )}
    </div>
  );
});

export default Canvas;
