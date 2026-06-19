import { cornersDoc } from "./geometry";
import { areaSplitLines, contentSize, type Doc, type Layer, type Transform } from "./types";
import { measureTextLayout } from "./render";

// Figma-style snapping: a moving layer aligns (per axis) to other elements'
// edges/centers, the canvas, measurement points (magnets), the midpoint between
// two elements (equal-spacing / centering), and an optional grid.

export type SnapKind = "align" | "magnet" | "spacing" | "grid";

export interface SnapGuide {
  axis: "x" | "y";
  value: number; // doc coordinate of the guide line
  kind: SnapKind;
}

export interface SnapConfig {
  enabled: boolean;
  grid: boolean;
  gridDivisions: number; // canvas is divided into this many equal cells per axis
}

interface AABB {
  minX: number;
  maxX: number;
  cx: number;
  minY: number;
  maxY: number;
  cy: number;
}

// Axis-aligned bounding box (alignment uses the bbox, not rotated corners).
export function aabbOf(t: Transform, w: number, h: number): AABB {
  const c = cornersDoc(t, w, h);
  const xs = [c.tl.x, c.tr.x, c.br.x, c.bl.x];
  const ys = [c.tl.y, c.tr.y, c.br.y, c.bl.y];
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  return { minX, maxX, cx: (minX + maxX) / 2, minY, maxY, cy: (minY + maxY) / 2 };
}

function layerAABB(layer: Layer): AABB {
  const size = layer.type === "text" ? { w: layer.boxWidth, h: measureTextLayout(layer).height } : contentSize(layer);
  return aabbOf(layer.transform, size.w, size.h);
}

interface Cand {
  value: number;
  kind: SnapKind;
}

function bestSnap(movingVals: number[], targets: Cand[], threshold: number): { delta: number; value: number; kind: SnapKind } | null {
  let best: { delta: number; value: number; kind: SnapKind; abs: number } | null = null;
  for (const mv of movingVals) {
    for (const t of targets) {
      const d = t.value - mv;
      const abs = Math.abs(d);
      if (abs <= threshold && (!best || abs < best.abs)) best = { delta: d, value: t.value, kind: t.kind, abs };
    }
  }
  return best ? { delta: best.delta, value: best.value, kind: best.kind } : null;
}

// Given the moving layer's candidate AABB extents, return the snap correction
// (dx, dy) and the guide lines to draw. `movingXs`/`movingYs` are the moving
// box's [min, center, max] on each axis at the raw (unsnapped) position.
export function computeSnap(
  movingXs: number[],
  movingYs: number[],
  doc: Doc,
  excludeIds: string[],
  config: SnapConfig,
  thresholdDoc: number
): { dx: number; dy: number; guides: SnapGuide[] } {
  const xs: Cand[] = [];
  const ys: Cand[] = [];
  const exclude = new Set(excludeIds);

  const others: AABB[] = [];
  for (const l of doc.layers) {
    if (exclude.has(l.id) || !l.visible) continue;
    const a = layerAABB(l);
    others.push(a);
    xs.push({ value: a.minX, kind: "align" }, { value: a.cx, kind: "align" }, { value: a.maxX, kind: "align" });
    ys.push({ value: a.minY, kind: "align" }, { value: a.cy, kind: "align" }, { value: a.maxY, kind: "align" });
  }

  // Canvas edges + center.
  xs.push({ value: 0, kind: "align" }, { value: doc.width / 2, kind: "align" }, { value: doc.width, kind: "align" });
  ys.push({ value: 0, kind: "align" }, { value: doc.height / 2, kind: "align" }, { value: doc.height, kind: "align" });

  // Measurements as magnets: ruler endpoints/midpoint; area edges/center/section
  // centers + division lines.
  for (const a of doc.annotations ?? []) {
    if (a.type === "ruler") {
      xs.push({ value: a.ax, kind: "magnet" }, { value: a.bx, kind: "magnet" }, { value: (a.ax + a.bx) / 2, kind: "magnet" });
      ys.push({ value: a.ay, kind: "magnet" }, { value: a.by, kind: "magnet" }, { value: (a.ay + a.by) / 2, kind: "magnet" });
    } else {
      xs.push({ value: a.x, kind: "magnet" }, { value: a.x + a.w, kind: "magnet" }, { value: a.x + a.w / 2, kind: "magnet" });
      ys.push({ value: a.y, kind: "magnet" }, { value: a.y + a.h, kind: "magnet" }, { value: a.y + a.h / 2, kind: "magnet" });
      const lines = areaSplitLines(a);
      for (const v of lines.xs) xs.push({ value: v, kind: "magnet" });
      for (const v of lines.ys) ys.push({ value: v, kind: "magnet" });
      if (a.splitAxis === "x" && a.splitCount > 1)
        for (let i = 0; i < a.splitCount; i++) xs.push({ value: a.x + (a.w * (i + 0.5)) / a.splitCount, kind: "magnet" });
      if (a.splitAxis === "y" && a.splitCount > 1)
        for (let i = 0; i < a.splitCount; i++) ys.push({ value: a.y + (a.h * (i + 0.5)) / a.splitCount, kind: "magnet" });
    }
  }

  // Equal-spacing: the midpoint between each pair of other layers' centers.
  for (let i = 0; i < others.length; i++) {
    for (let j = i + 1; j < others.length; j++) {
      xs.push({ value: (others[i].cx + others[j].cx) / 2, kind: "spacing" });
      ys.push({ value: (others[i].cy + others[j].cy) / 2, kind: "spacing" });
    }
  }

  // Grid: proportional cells (canvas / divisions). Snap to the nearest cell line.
  if (config.grid && config.gridDivisions > 0) {
    const cw = doc.width / config.gridDivisions;
    const ch = doc.height / config.gridDivisions;
    for (const mv of movingXs) xs.push({ value: Math.round(mv / cw) * cw, kind: "grid" });
    for (const mv of movingYs) ys.push({ value: Math.round(mv / ch) * ch, kind: "grid" });
  }

  const sx = bestSnap(movingXs, xs, thresholdDoc);
  const sy = bestSnap(movingYs, ys, thresholdDoc);

  const guides: SnapGuide[] = [];
  if (sx) guides.push({ axis: "x", value: sx.value, kind: sx.kind });
  if (sy) guides.push({ axis: "y", value: sy.value, kind: sy.kind });

  return { dx: sx?.delta ?? 0, dy: sy?.delta ?? 0, guides };
}
