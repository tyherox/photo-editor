// The serializable document model. A Doc is a plain, JSON-serializable object —
// it holds NO bitmaps (those live in the AssetCache keyed by `assetId`). This
// keeps undo snapshots cheap and makes future IndexedDB persistence a drop-in.

// Every value here is BOTH a valid CSS `mix-blend-mode` AND a canvas
// `globalCompositeOperation`, so on-screen render and export stay in lockstep.
// "normal" maps to canvas "source-over".
export type BlendMode =
  | "normal" | "multiply" | "screen" | "overlay" | "darken" | "lighten"
  | "color-dodge" | "color-burn" | "hard-light" | "soft-light"
  | "difference" | "exclusion" | "hue" | "saturation" | "color" | "luminosity";

export const BLEND_MODES: BlendMode[] = [
  "normal", "multiply", "screen", "overlay", "darken", "lighten",
  "color-dodge", "color-burn", "hard-light", "soft-light",
  "difference", "exclusion", "hue", "saturation", "color", "luminosity",
];

export interface Transform {
  x: number;        // document-space position of the layer's local origin (top-left, pre-transform)
  y: number;
  scaleX: number;   // negative => horizontal flip
  scaleY: number;   // negative => vertical flip
  rotation: number; // radians, clockwise, applied about the local origin (see geometry.ts)
}

export interface LayerBase {
  id: string;
  name: string;
  transform: Transform;
  opacity: number;   // 0..1
  blendMode: BlendMode;
  visible: boolean;
  locked: boolean;
  groupId?: string;  // layers sharing a groupId are selected/moved as one unit
}

// Heavy bitmaps live in the AssetCache keyed by `assetId` — never in the Doc.
export interface RasterLayer extends LayerBase {
  type: "raster";
  assetId: string;
  naturalWidth: number;  // intrinsic px of the bitmap (the local content box)
  naturalHeight: number;
}

export type TextAlign = "left" | "center" | "right";
export interface TextLayer extends LayerBase {
  type: "text";
  text: string;
  fontFamily: string;
  fontSize: number;   // doc px, pre-transform
  fontWeight: number; // 100..900
  color: string;      // CSS color
  align: TextAlign;
  lineHeight: number; // multiplier, e.g. 1.2
  boxWidth: number;   // wrapping width in doc px (the local content width)
  italic: boolean;
  underline: boolean;
}

export type ShapeKind = "rect" | "ellipse" | "line";
export interface ShapeLayer extends LayerBase {
  type: "shape";
  shape: ShapeKind;
  width: number;       // local content box, doc px
  height: number;
  fill: string;        // CSS color or "transparent"
  stroke: string;
  strokeWidth: number; // doc px
  radius: number;      // rect corner radius, doc px (0 for ellipse/line)
}

export type Layer = RasterLayer | TextLayer | ShapeLayer;

// Annotations are document metadata (measurements/guides), NOT content. They are
// never flattened into export or the AI input (renderDocToCanvas ignores them),
// but persist across edits/AI and live in undo history with the rest of the Doc.
export interface RulerAnnotation {
  type: "ruler";
  id: string;
  ax: number; // endpoint A, doc coords
  ay: number;
  bx: number; // endpoint B, doc coords
  by: number;
}

export type SplitAxis = "none" | "x" | "y";
// A measured rectangle that can be divided into equal sections (columns on x,
// rows on y). Division lines double as snap targets for laying out elements.
export interface AreaAnnotation {
  type: "area";
  id: string;
  x: number; // doc coords (top-left)
  y: number;
  w: number;
  h: number;
  splitAxis: SplitAxis;
  splitCount: number; // number of equal sections (>= 1)
}

export type Annotation = RulerAnnotation | AreaAnnotation;

export interface Doc {
  id: string;
  name: string;
  width: number;       // document size, doc px
  height: number;
  background: string;  // CSS color; "transparent" allowed
  layers: Layer[];     // index 0 = back, last = front
  annotations: Annotation[]; // measurements/guides — not exported/flattened
}

// Bitmaps stored in the AssetCache.
export type AssetBitmap = HTMLImageElement | ImageBitmap;

// --- Factories -------------------------------------------------------------
// These touch `crypto.randomUUID` (browser/Node global) — only call from event
// handlers or effects, never during render or module init.

export function newId(): string {
  return crypto.randomUUID();
}

export function defaultTransform(x = 0, y = 0): Transform {
  return { x, y, scaleX: 1, scaleY: 1, rotation: 0 };
}

function baseLayer(name: string, transform: Transform): LayerBase {
  return {
    id: newId(),
    name,
    transform,
    opacity: 1,
    blendMode: "normal",
    visible: true,
    locked: false,
  };
}

export function makeRasterLayer(
  assetId: string,
  naturalWidth: number,
  naturalHeight: number,
  transform: Transform,
  name = "Image"
): RasterLayer {
  return { ...baseLayer(name, transform), type: "raster", assetId, naturalWidth, naturalHeight };
}

export function makeTextLayer(
  text: string,
  transform: Transform,
  opts: Partial<Omit<TextLayer, keyof LayerBase | "type">> = {}
): TextLayer {
  return {
    ...baseLayer("Text", transform),
    type: "text",
    text,
    // A concrete stack (no CSS var()) so DOM and canvas export resolve the SAME
    // font — canvas ctx.font cannot parse `var(--...)`. Matches the app body font.
    fontFamily: opts.fontFamily ?? "Arial, Helvetica, sans-serif",
    fontSize: opts.fontSize ?? 64,
    fontWeight: opts.fontWeight ?? 600,
    color: opts.color ?? "#ffffff",
    align: opts.align ?? "left",
    lineHeight: opts.lineHeight ?? 1.2,
    boxWidth: opts.boxWidth ?? 400,
    italic: opts.italic ?? false,
    underline: opts.underline ?? false,
  };
}

export function makeShapeLayer(
  shape: ShapeKind,
  transform: Transform,
  opts: Partial<Omit<ShapeLayer, keyof LayerBase | "type" | "shape">> = {}
): ShapeLayer {
  return {
    ...baseLayer(shape === "rect" ? "Rectangle" : shape === "ellipse" ? "Ellipse" : "Line", transform),
    type: "shape",
    shape,
    width: opts.width ?? 300,
    height: opts.height ?? 200,
    fill: opts.fill ?? (shape === "line" ? "transparent" : "#3b82f6"),
    stroke: opts.stroke ?? (shape === "line" ? "#ffffff" : "transparent"),
    strokeWidth: opts.strokeWidth ?? (shape === "line" ? 4 : 0),
    radius: opts.radius ?? 0,
  };
}

export function emptyDoc(width: number, height: number, background = "#ffffff"): Doc {
  return { id: newId(), name: "Untitled", width, height, background, layers: [], annotations: [] };
}

export function makeRuler(ax: number, ay: number, bx: number, by: number): RulerAnnotation {
  return { type: "ruler", id: newId(), ax, ay, bx, by };
}

export function makeArea(x: number, y: number, w: number, h: number): AreaAnnotation {
  return { type: "area", id: newId(), x, y, w, h, splitAxis: "none", splitCount: 1 };
}

// Division line positions (doc coords) within a split area, used by both the
// on-canvas render and the snapping engine so they always agree.
export function areaSplitLines(a: AreaAnnotation): { xs: number[]; ys: number[] } {
  const xs: number[] = [];
  const ys: number[] = [];
  if (a.splitCount > 1 && a.splitAxis === "x") {
    for (let i = 1; i < a.splitCount; i++) xs.push(a.x + (a.w * i) / a.splitCount);
  }
  if (a.splitCount > 1 && a.splitAxis === "y") {
    for (let i = 1; i < a.splitCount; i++) ys.push(a.y + (a.h * i) / a.splitCount);
  }
  return { xs, ys };
}

// The local content box of a layer (pre-transform), used by geometry + render.
export function contentSize(layer: Layer, textHeight?: number): { w: number; h: number } {
  switch (layer.type) {
    case "raster":
      return { w: layer.naturalWidth, h: layer.naturalHeight };
    case "shape":
      return { w: layer.width, h: layer.height };
    case "text":
      return { w: layer.boxWidth, h: textHeight ?? layer.fontSize * layer.lineHeight };
  }
}
