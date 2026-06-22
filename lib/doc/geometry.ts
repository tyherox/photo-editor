import type { Transform } from "./types";

// Pure geometry core. No React, no DOM. Two ideas keep export WYSIWYG and the
// drag math sane:
//  1. transform-origin is ALWAYS (0,0); the affine is translate → rotate → scale.
//     CSS and canvas replay the identical order, so on-screen === export.
//  2. "anchor the opposite corner" (scale) and "pivot about center" (rotate) are
//     achieved by recomputing the origin (x,y) — not by moving transform-origin.

export interface Vec {
  x: number;
  y: number;
}

export interface Viewport {
  zoom: number;
  panX: number; // screen px
  panY: number;
}

const MIN_EXTENT = 8; // min scaled size of a layer in doc px (mirrors Canvas.tsx's Math.max(8, …))

export function rotate(v: Vec, angle: number): Vec {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return { x: v.x * c - v.y * s, y: v.x * s + v.y * c };
}

// Map a layer-local point (pre-transform) into document space:
//   doc = (x,y) + R(rotation) · (lx*scaleX, ly*scaleY)
export function affinePoint(t: Transform, lx: number, ly: number): Vec {
  const r = rotate({ x: lx * t.scaleX, y: ly * t.scaleY }, t.rotation);
  return { x: t.x + r.x, y: t.y + r.y };
}

// --- Viewport mapping ------------------------------------------------------
// Derive everything from the world element's live rect so pan/zoom/scroll/
// padding are already baked in (mirrors Canvas.getCanvasCoords). Read the rect
// ONCE at pointer-down and reuse it + zoom for the whole interaction.

export function screenToDoc(
  clientX: number,
  clientY: number,
  worldRect: { left: number; top: number },
  zoom: number
): Vec {
  return { x: (clientX - worldRect.left) / zoom, y: (clientY - worldRect.top) / zoom };
}

export function docToScreen(
  docX: number,
  docY: number,
  worldRect: { left: number; top: number },
  zoom: number
): Vec {
  return { x: worldRect.left + docX * zoom, y: worldRect.top + docY * zoom };
}

// --- Corners ---------------------------------------------------------------

export interface Corners {
  tl: Vec;
  tr: Vec;
  br: Vec;
  bl: Vec;
}

export function cornersDoc(t: Transform, w: number, h: number): Corners {
  return {
    tl: affinePoint(t, 0, 0),
    tr: affinePoint(t, w, 0),
    br: affinePoint(t, w, h),
    bl: affinePoint(t, 0, h),
  };
}

export function layerCenterDoc(t: Transform, w: number, h: number): Vec {
  return affinePoint(t, w / 2, h / 2);
}

export function cssTransformFor(t: Transform): string {
  return `translate(${t.x}px, ${t.y}px) rotate(${t.rotation}rad) scale(${t.scaleX}, ${t.scaleY})`;
}

// --- Interaction helpers ---------------------------------------------------
// Each `begin*` snapshots immutable start state at pointer-down; each `compute*`
// returns a fresh Transform for the current pointer position (in doc space).

export function computeMove(t0: Transform, pointerDoc0: Vec, pointerDoc: Vec): Transform {
  return { ...t0, x: t0.x + (pointerDoc.x - pointerDoc0.x), y: t0.y + (pointerDoc.y - pointerDoc0.y) };
}

export type ScaleHandle = "tl" | "tr" | "br" | "bl" | "t" | "r" | "b" | "l";

// Normalized local fraction each handle grabs (0,0.5,1 on each axis). The
// anchor is the opposite fraction (1-fx, 1-fy).
const HANDLE_FRAC: Record<ScaleHandle, { fx: number; fy: number }> = {
  tl: { fx: 0, fy: 0 },
  tr: { fx: 1, fy: 0 },
  br: { fx: 1, fy: 1 },
  bl: { fx: 0, fy: 1 },
  t: { fx: 0.5, fy: 0 },
  r: { fx: 1, fy: 0.5 },
  b: { fx: 0.5, fy: 1 },
  l: { fx: 0, fy: 0.5 },
};

export interface ScaleStart {
  t0: Transform;
  w0: number;
  h0: number;
  fx: number;
  fy: number;
  anchorDoc: Vec; // the opposite corner/edge, fixed in doc space for the whole drag
}

export function beginScale(t0: Transform, w0: number, h0: number, handle: ScaleHandle): ScaleStart {
  const { fx, fy } = HANDLE_FRAC[handle];
  const anchorDoc = affinePoint(t0, (1 - fx) * w0, (1 - fy) * h0);
  return { t0, w0, h0, fx, fy, anchorDoc };
}

function clampScale(s: number, size: number): number {
  if (size <= 0) return s;
  const sign = s < 0 ? -1 : 1;
  if (Math.abs(s) * size < MIN_EXTENT) return (sign * MIN_EXTENT) / size;
  return s;
}

export function computeScale(s: ScaleStart, pointerDoc: Vec, uniform = false): Transform {
  // Pointer relative to the fixed anchor, expressed in the layer's UNrotated frame.
  const v = { x: pointerDoc.x - s.anchorDoc.x, y: pointerDoc.y - s.anchorDoc.y };
  const u = rotate(v, -s.t0.rotation);

  const dxLocal = (2 * s.fx - 1) * s.w0; // 0 for edge handles that don't change x
  const dyLocal = (2 * s.fy - 1) * s.h0;

  let sX = dxLocal !== 0 ? u.x / dxLocal : s.t0.scaleX;
  let sY = dyLocal !== 0 ? u.y / dyLocal : s.t0.scaleY;

  if (uniform && dxLocal !== 0 && dyLocal !== 0 && s.t0.scaleX !== 0 && s.t0.scaleY !== 0) {
    const driver = Math.max(Math.abs(sX / s.t0.scaleX), Math.abs(sY / s.t0.scaleY));
    sX = Math.sign(sX || 1) * Math.abs(s.t0.scaleX) * driver;
    sY = Math.sign(sY || 1) * Math.abs(s.t0.scaleY) * driver;
  }

  sX = clampScale(sX, s.w0);
  sY = clampScale(sY, s.h0);

  // Recompute origin so the anchor corner stays pinned:
  //   anchorDoc = origin + R(rot)·(aLocal·newScale)  =>  origin = anchorDoc - R(rot)·(aLocal·newScale)
  const aLocal = { x: (1 - s.fx) * s.w0, y: (1 - s.fy) * s.h0 };
  const rotated = rotate({ x: aLocal.x * sX, y: aLocal.y * sY }, s.t0.rotation);
  return { ...s.t0, scaleX: sX, scaleY: sY, x: s.anchorDoc.x - rotated.x, y: s.anchorDoc.y - rotated.y };
}

// --- Text box resize -------------------------------------------------------
// A text layer's width is its wrap width (`boxWidth`), and its height is derived
// from the wrapped content. So horizontal handles must change boxWidth — NOT
// scaleX (which would stretch/skew the glyphs). The opposite vertical edge stays
// pinned in doc space; the dragged edge follows the pointer along the local x
// axis. Top/bottom-only handles don't change width (auto height), so they're
// rejected here.

const MIN_TEXT_WIDTH = 16; // min wrap width in doc px

export interface TextResizeStart {
  t0: Transform;
  fx: number;        // 0 = left handle (right edge pinned) | 1 = right handle (left edge pinned)
  pinnedTopDoc: Vec; // top corner of the pinned vertical edge, fixed for the whole drag
}

// Returns null for handles that don't control width (t / b).
export function beginTextResize(t0: Transform, w0: number, handle: ScaleHandle): TextResizeStart | null {
  const { fx } = HANDLE_FRAC[handle];
  if (fx === 0.5) return null;
  const pinnedTopDoc = affinePoint(t0, (1 - fx) * w0, 0); // opposite edge's top corner
  return { t0, fx, pinnedTopDoc };
}

export function computeTextResize(s: TextResizeStart, pointerDoc: Vec): { boxWidth: number; transform: Transform } {
  const dirX = rotate({ x: 1, y: 0 }, s.t0.rotation); // unit local-x axis, in doc space
  const v = { x: pointerDoc.x - s.pinnedTopDoc.x, y: pointerDoc.y - s.pinnedTopDoc.y };
  const proj = v.x * dirX.x + v.y * dirX.y; // signed distance pointer→pinned along local x (doc units)
  const sx = s.t0.scaleX || 1;
  const boxWidth = Math.max(MIN_TEXT_WIDTH, Math.abs(proj) / Math.abs(sx));

  // Keep the pinned vertical edge fixed. Right handle: pinned IS the origin, so
  // the origin doesn't move. Left handle: pinned is the right edge, so move the
  // origin to sit boxWidth to its left (in the rotated/scaled local x).
  let { x, y } = s.t0;
  if (s.fx === 0) {
    const off = rotate({ x: boxWidth * sx, y: 0 }, s.t0.rotation);
    x = s.pinnedTopDoc.x - off.x;
    y = s.pinnedTopDoc.y - off.y;
  }
  return { boxWidth, transform: { ...s.t0, x, y } };
}

export interface RotateStart {
  t0: Transform;
  w0: number;
  h0: number;
  centerDoc: Vec;
  startAngle: number;
}

export function beginRotate(t0: Transform, w0: number, h0: number, pointerDoc: Vec): RotateStart {
  const centerDoc = layerCenterDoc(t0, w0, h0);
  const startAngle = Math.atan2(pointerDoc.y - centerDoc.y, pointerDoc.x - centerDoc.x);
  return { t0, w0, h0, centerDoc, startAngle };
}

export function computeRotate(s: RotateStart, pointerDoc: Vec, snap = false): Transform {
  const cur = Math.atan2(pointerDoc.y - s.centerDoc.y, pointerDoc.x - s.centerDoc.x);
  let rot = s.t0.rotation + (cur - s.startAngle);
  if (snap) {
    const step = Math.PI / 12; // 15°
    rot = Math.round(rot / step) * step;
  }
  // Keep the center fixed: origin = center - R(rot)·(half·scale)
  const half = rotate({ x: (s.w0 / 2) * s.t0.scaleX, y: (s.h0 / 2) * s.t0.scaleY }, rot);
  return { ...s.t0, rotation: rot, x: s.centerDoc.x - half.x, y: s.centerDoc.y - half.y };
}
