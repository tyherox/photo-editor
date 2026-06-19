import type { AssetCache } from "./assetCache";
import type { Doc, Layer, ShapeLayer, TextLayer } from "./types";
import { contentSize } from "./types";
import { cornersDoc } from "./geometry";

// Flatten a Doc to a canvas, replaying the EXACT affine + blend the on-screen
// CSS render uses (transform-origin 0,0; translate → rotate → scale), so export
// is WYSIWYG. Also exposes text layout measurement shared by the on-screen box.

let measureCanvas: HTMLCanvasElement | null = null;
function measureCtx(): CanvasRenderingContext2D {
  if (!measureCanvas) measureCanvas = document.createElement("canvas");
  return measureCanvas.getContext("2d")!;
}

export function fontString(layer: TextLayer): string {
  return `${layer.italic ? "italic " : ""}${layer.fontWeight} ${layer.fontSize}px ${layer.fontFamily}`;
}

// Greedy word-wrap to a pixel width. Honors explicit newlines. Used identically
// for export drawing and for measuring the text box height.
export function wrapText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    const words = paragraph.split(" ");
    let line = "";
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (ctx.measureText(candidate).width > maxWidth && line) {
        lines.push(line);
        line = word;
      } else {
        line = candidate;
      }
    }
    lines.push(line);
  }
  return lines;
}

export interface TextLayout {
  lines: string[];
  lineHeightPx: number;
  height: number;
}

export function measureTextLayout(layer: TextLayer): TextLayout {
  const ctx = measureCtx();
  ctx.font = fontString(layer);
  const lines = wrapText(ctx, layer.text, layer.boxWidth);
  const lineHeightPx = layer.fontSize * layer.lineHeight;
  return { lines, lineHeightPx, height: Math.max(lineHeightPx, lines.length * lineHeightPx) };
}

function roundRectPath(ctx: CanvasRenderingContext2D, w: number, h: number, r: number) {
  const radius = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(radius, 0);
  ctx.arcTo(w, 0, w, h, radius);
  ctx.arcTo(w, h, 0, h, radius);
  ctx.arcTo(0, h, 0, 0, radius);
  ctx.arcTo(0, 0, w, 0, radius);
  ctx.closePath();
}

function drawShapeLocal(ctx: CanvasRenderingContext2D, layer: ShapeLayer) {
  const { shape, width, height, fill, stroke, strokeWidth } = layer;
  if (shape === "line") {
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(width, height);
    if (strokeWidth > 0) {
      ctx.strokeStyle = stroke;
      ctx.lineWidth = strokeWidth;
      ctx.lineCap = "round";
      ctx.stroke();
    }
    return;
  }
  if (shape === "ellipse") {
    ctx.beginPath();
    ctx.ellipse(width / 2, height / 2, width / 2, height / 2, 0, 0, Math.PI * 2);
  } else {
    roundRectPath(ctx, width, height, layer.radius);
  }
  if (fill && fill !== "transparent") {
    ctx.fillStyle = fill;
    ctx.fill();
  }
  if (stroke && stroke !== "transparent" && strokeWidth > 0) {
    ctx.strokeStyle = stroke;
    ctx.lineWidth = strokeWidth;
    ctx.stroke();
  }
}

function drawTextLocal(ctx: CanvasRenderingContext2D, layer: TextLayer) {
  ctx.font = fontString(layer);
  ctx.fillStyle = layer.color;
  ctx.textBaseline = "top";
  ctx.textAlign = layer.align;
  const { lines, lineHeightPx } = measureTextLayout(layer);
  const x = layer.align === "center" ? layer.boxWidth / 2 : layer.align === "right" ? layer.boxWidth : 0;
  // Vertically center each line's glyphs within its line box, matching CSS line-height.
  const pad = (lineHeightPx - layer.fontSize) / 2;
  lines.forEach((line, i) => {
    const top = i * lineHeightPx + pad;
    ctx.fillText(line, x, top);
    if (layer.underline) {
      // Canvas has no underline — draw one below the glyphs (textAlign doesn't
      // affect strokes, so position the start by alignment ourselves).
      const w = ctx.measureText(line).width;
      const lx = layer.align === "center" ? x - w / 2 : layer.align === "right" ? x - w : x;
      const ly = top + layer.fontSize * 0.92;
      ctx.strokeStyle = layer.color;
      ctx.lineWidth = Math.max(1, layer.fontSize / 16);
      ctx.beginPath();
      ctx.moveTo(lx, ly);
      ctx.lineTo(lx + w, ly);
      ctx.stroke();
    }
  });
}

function drawLayerLocal(ctx: CanvasRenderingContext2D, layer: Layer, cache: AssetCache) {
  switch (layer.type) {
    case "raster": {
      const bmp = cache.get(layer.assetId);
      if (bmp) ctx.drawImage(bmp, 0, 0, layer.naturalWidth, layer.naturalHeight);
      break;
    }
    case "shape":
      drawShapeLocal(ctx, layer);
      break;
    case "text":
      drawTextLocal(ctx, layer);
      break;
  }
}

export function renderDocToCanvas(doc: Doc, cache: AssetCache, scale = 1, dpr = 1): HTMLCanvasElement {
  const k = scale * dpr;
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(doc.width * k));
  canvas.height = Math.max(1, Math.round(doc.height * k));
  const ctx = canvas.getContext("2d")!;
  ctx.scale(k, k); // draw in document units; k only sets export resolution

  if (doc.background && doc.background !== "transparent") {
    ctx.fillStyle = doc.background;
    ctx.fillRect(0, 0, doc.width, doc.height);
  }

  for (const layer of doc.layers) {
    if (!layer.visible) continue;
    ctx.save();
    ctx.globalAlpha = layer.opacity;
    ctx.globalCompositeOperation = layer.blendMode === "normal" ? "source-over" : layer.blendMode;
    const t = layer.transform;
    ctx.translate(t.x, t.y);
    ctx.rotate(t.rotation);
    ctx.scale(t.scaleX, t.scaleY);
    drawLayerLocal(ctx, layer, cache);
    ctx.restore();
  }

  return canvas;
}

// Axis-aligned bounding box of a single layer in doc space.
function layerAABB(layer: Layer): { minX: number; minY: number; maxX: number; maxY: number } {
  const size = layer.type === "text" ? { w: layer.boxWidth, h: measureTextLayout(layer).height } : contentSize(layer);
  const c = cornersDoc(layer.transform, size.w, size.h);
  const xs = [c.tl.x, c.tr.x, c.br.x, c.bl.x];
  const ys = [c.tl.y, c.tr.y, c.br.y, c.bl.y];
  return { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) };
}

// Render one or more layers onto a transparent canvas cropped to their combined
// (union) bounding box, preserving relative positions. Used for per-layer and
// group PNG/JPEG export. `layers` must be in back-to-front order. Each layer's
// opacity is applied; blend modes compose between layers (the bottom layer is
// always source-over since there's nothing beneath it in an isolated export).
export function renderLayersToCanvas(layers: Layer[], cache: AssetCache, scale = 1): HTMLCanvasElement {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const l of layers) {
    const b = layerAABB(l);
    if (b.minX < minX) minX = b.minX;
    if (b.minY < minY) minY = b.minY;
    if (b.maxX > maxX) maxX = b.maxX;
    if (b.maxY > maxY) maxY = b.maxY;
  }
  if (!isFinite(minX)) {
    minX = minY = 0;
    maxX = maxY = 1;
  }
  const w = Math.max(1, maxX - minX);
  const h = Math.max(1, maxY - minY);

  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(w * scale));
  canvas.height = Math.max(1, Math.round(h * scale));
  const ctx = canvas.getContext("2d")!;
  ctx.scale(scale, scale);
  ctx.translate(-minX, -minY); // shift the union bbox corner to the canvas origin

  layers.forEach((layer, i) => {
    ctx.save();
    ctx.globalAlpha = layer.opacity;
    ctx.globalCompositeOperation = i === 0 || layer.blendMode === "normal" ? "source-over" : layer.blendMode;
    const t = layer.transform;
    ctx.translate(t.x, t.y);
    ctx.rotate(t.rotation);
    ctx.scale(t.scaleX, t.scaleY);
    drawLayerLocal(ctx, layer, cache);
    ctx.restore();
  });

  return canvas;
}

// Convenience: export a single layer (cropped to its bbox).
export function renderLayerToCanvas(layer: Layer, cache: AssetCache, scale = 1): HTMLCanvasElement {
  return renderLayersToCanvas([layer], cache, scale);
}

// True when the doc has at least one visible layer (gates AI-edit / export-of-content).
export function hasVisibleContent(doc: Doc): boolean {
  return doc.layers.some((l) => l.visible);
}
