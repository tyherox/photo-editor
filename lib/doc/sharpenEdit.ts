import type { Doc } from "./types";
import type { AssetCache } from "./assetCache";
import { renderDocToCanvas } from "./render";
import { boxBlur, getMaskRegions, padBBox, type BBox } from "@/lib/crop-inpaint-stitch";
import { sharpenRegion, type SharpenOptions } from "@/lib/text-sharpen";

// Algorithmic "sharpen the masked area" — same shape as editRegionWithContextPatches
// (one feathered patch per masked blob) so the job scheduler / onPatches / review
// overlay are unchanged. Purely local: no model, no network. Sharpens brightness
// edges within the mask while preserving font color and style (see text-sharpen.ts).
//
// Edges come out CRISP BUT SMOOTH via supersampling: the document is rendered and
// sharpened at SUPERSAMPLE× the output resolution, then the patch is downsampled
// with area-averaging. Sharpening at 1:1 drives edge pixels to extremes and leaves
// hard stair-steps (aliasing); doing it at higher resolution and averaging down
// re-introduces smooth anti-aliasing while keeping the steepened transition.

const EDIT_PAD_PX = 24; // doc px around each region for the feathered patch
const BLEND_RADIUS = 16; // feather ramp; keep ≤ EDIT_PAD_PX so it stays in the pad
const SUPERSAMPLE = 4; // internal oversampling for anti-aliased edges (≈N² AA levels)
// Cap the (whole-doc) render so doc × render-scale can't blow up memory.
const MAX_RENDER_DIM = 6144;

export interface SharpenPatchOptions extends SharpenOptions {
  // Output resolution multiplier. >1 keeps the masked region at that resolution
  // (text/shapes redrawn crisply, not interpolated) so it stays detailed when
  // zoomed or exported. Independent of the internal supersampling.
  scale?: number;
  // Anti-alias edges via internal supersampling (default true). Off = sharpen at
  // 1:1 — faster and harder, but edges can stair-step.
  supersample?: boolean;
}

// Build the final patch at `outW×outH`: RGB downsampled from the sharpened hi-res
// render (area-averaged → smooth edges); alpha = the 1× mask, nearest-sampled up
// to the output resolution and feathered. Mirrors patchFromFullResult but bridges
// the 1× mask ↔ the supersampled image and anti-aliases on the way down.
function buildSmoothPatch(
  flatHi: HTMLCanvasElement,
  maskCanvas: HTMLCanvasElement,
  bbox: BBox,
  renderScale: number,
  outScale: number
): HTMLCanvasElement {
  const outW = Math.max(1, Math.round(bbox.w * outScale));
  const outH = Math.max(1, Math.round(bbox.h * outScale));

  // Downsample the sharpened region straight from the hi-res render to output res.
  const rgbCanvas = document.createElement("canvas");
  rgbCanvas.width = outW;
  rgbCanvas.height = outH;
  const rctx = rgbCanvas.getContext("2d")!;
  rctx.imageSmoothingEnabled = true;
  rctx.imageSmoothingQuality = "high";
  rctx.drawImage(
    flatHi,
    Math.round(bbox.x * renderScale),
    Math.round(bbox.y * renderScale),
    Math.round(bbox.w * renderScale),
    Math.round(bbox.h * renderScale),
    0, 0, outW, outH
  );
  const rgb = rctx.getImageData(0, 0, outW, outH);

  // Feathered alpha at output resolution from the 1× mask.
  const mask = maskCanvas.getContext("2d")!.getImageData(bbox.x, bbox.y, bbox.w, bbox.h);
  const alpha = new Float32Array(outW * outH);
  for (let y = 0; y < outH; y++) {
    const sy = Math.min(bbox.h - 1, Math.floor(y / outScale));
    for (let x = 0; x < outW; x++) {
      const sx = Math.min(bbox.w - 1, Math.floor(x / outScale));
      alpha[y * outW + x] = mask.data[(sy * bbox.w + sx) * 4 + 3] > 10 ? 1 : 0;
    }
  }
  const blurred = boxBlur(alpha, outW, outH, BLEND_RADIUS * outScale);

  const out = document.createElement("canvas");
  out.width = outW;
  out.height = outH;
  const octx = out.getContext("2d")!;
  const patch = octx.createImageData(outW, outH);
  for (let i = 0; i < alpha.length; i++) {
    const pi = i * 4;
    patch.data[pi] = rgb.data[pi];
    patch.data[pi + 1] = rgb.data[pi + 1];
    patch.data[pi + 2] = rgb.data[pi + 2];
    patch.data[pi + 3] = Math.round(blurred[i] * 255);
  }
  octx.putImageData(patch, 0, 0);
  return out;
}

// Flatten the document at the supersampled resolution, sharpen each masked region
// in place, then emit one anti-aliased feathered patch per region (downsampled to
// the chosen output scale). Everything outside the mask is discarded by the alpha.
export async function sharpenMaskedRegionPatches(
  doc: Doc,
  cache: AssetCache,
  maskCanvas: HTMLCanvasElement,
  opts: SharpenPatchOptions = {}
): Promise<{ bbox: BBox; patch: HTMLCanvasElement }[]> {
  const maxDocDim = Math.max(doc.width, doc.height) || 1;
  const maxScale = Math.max(1, Math.floor(MAX_RENDER_DIM / maxDocDim) || 1);
  // Requested output scale, clamped to the render budget.
  const outScale = Math.max(1, Math.min(Math.round(opts.scale ?? 1), maxScale));
  // Supersample on top of that when enabled: pick the LARGEST factor (up to
  // SUPERSAMPLE) that still fits the render budget, so smoothing degrades
  // gracefully on big docs instead of snapping off. Off → 1:1.
  const wantSS = opts.supersample !== false;
  const ss = wantSS ? Math.max(1, Math.min(SUPERSAMPLE, Math.floor(maxScale / outScale))) : 1;
  const renderScale = outScale * ss;

  const flat = renderDocToCanvas(doc, cache, renderScale);
  const regions = getMaskRegions(maskCanvas, 0, false).map((b) =>
    padBBox(b, EDIT_PAD_PX, maskCanvas.width, maskCanvas.height)
  );

  return regions.map((bbox) => {
    const hb = {
      x: Math.round(bbox.x * renderScale),
      y: Math.round(bbox.y * renderScale),
      w: Math.round(bbox.w * renderScale),
      h: Math.round(bbox.h * renderScale),
    };
    // radius left unset → sharpenRegion sizes it to the edge softness it measures
    // at this (supersampled) resolution.
    sharpenRegion(flat, hb, { amount: opts.amount, threshold: opts.threshold });
    return { bbox, patch: buildSmoothPatch(flat, maskCanvas, bbox, renderScale, outScale) };
  });
}
