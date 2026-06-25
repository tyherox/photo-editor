import type { Doc } from "./types";
import type { AssetCache } from "./assetCache";
import { renderDocToCanvas } from "./render";
import { editImage, DEFAULT_MODEL } from "@/lib/gemini";
import { imageToBase64, base64ToImage } from "@/lib/canvas-utils";
import { getMaskRegions, padBBox, patchFromFullResult, type BBox } from "@/lib/crop-inpaint-stitch";

// Context-aware ("in context") region editing. Unlike the crop-based path in
// maskEdit.ts — which sends only the masked crop + a 24px border, so the model is
// blind to the rest of the scene — here the model sees the WHOLE flattened
// document (with the masked region outlined) and edits only that region. The
// result therefore matches the surrounding lighting, color, perspective, and
// style. We then composite back ONLY the feathered mask pixels, so everything
// outside the mask stays pixel-for-pixel identical (and any drift the model
// introduced elsewhere, including the magenta hint, is discarded).

const EDIT_PAD_PX = 24; // doc px around each region for the feathered patch
const BLEND_RADIUS = 16; // feather ramp; keep ≤ EDIT_PAD_PX so it stays in the pad
const OUTLINE_PX = 4; // magenta locator-outline thickness (doc px)
const OUTLINE_COLOR = "#ff2bd6";

export interface ContextEditOptions {
  // Fully-assembled instruction (assemblePrompt, context flow) — already includes
  // the magenta-outline framing, sent verbatim.
  finalPrompt: string;
  referenceImage?: string;
  signal?: AbortSignal;
}

// A copy of `flat` with the mask shape ringed in magenta — a locator hint for the
// model. Built as an offset-silhouette ring (the mask alpha drawn at a circle of
// offsets, minus the mask itself) so the exact shape is outlined WITHOUT tinting
// the content the model has to regenerate.
function buildHintImage(flat: HTMLCanvasElement, maskCanvas: HTMLCanvasElement): string {
  const { width, height } = flat;

  // Solid magenta silhouette of the mask (its alpha, filled).
  const sil = document.createElement("canvas");
  sil.width = width;
  sil.height = height;
  const sctx = sil.getContext("2d")!;
  sctx.drawImage(maskCanvas, 0, 0);
  sctx.globalCompositeOperation = "source-in";
  sctx.fillStyle = OUTLINE_COLOR;
  sctx.fillRect(0, 0, width, height);

  // Ring = silhouette stamped around a circle of offsets, then the center punched
  // out — leaving only an outline of thickness ~OUTLINE_PX.
  const ring = document.createElement("canvas");
  ring.width = width;
  ring.height = height;
  const rctx = ring.getContext("2d")!;
  for (let a = 0; a < 16; a++) {
    const ang = (a / 16) * Math.PI * 2;
    rctx.drawImage(sil, Math.round(Math.cos(ang) * OUTLINE_PX), Math.round(Math.sin(ang) * OUTLINE_PX));
  }
  rctx.globalCompositeOperation = "destination-out";
  rctx.drawImage(sil, 0, 0);

  const hint = document.createElement("canvas");
  hint.width = width;
  hint.height = height;
  const ctx = hint.getContext("2d")!;
  ctx.drawImage(flat, 0, 0);
  ctx.drawImage(ring, 0, 0);
  return imageToBase64(hint);
}

// Edit the masked region(s) with full-scene context and return one feathered
// patch per region for placement as standalone layers — same shape as
// editMaskedRegionPatches so the job scheduler / onPatches are unchanged.
export async function editRegionWithContextPatches(
  doc: Doc,
  cache: AssetCache,
  maskCanvas: HTMLCanvasElement,
  opts: ContextEditOptions
): Promise<{ bbox: BBox; patch: HTMLCanvasElement }[]> {
  const apiKey = localStorage.getItem("gemini-api-key");
  if (!apiKey) throw new Error("API key is required — set it in Settings.");
  const model = localStorage.getItem("gemini-model") || DEFAULT_MODEL;

  const flat = renderDocToCanvas(doc, cache);
  const hint = buildHintImage(flat, maskCanvas);

  const result = await editImage({
    apiKey,
    model,
    mode: "context",
    prompt: opts.finalPrompt,
    rawPrompt: true,
    image: imageToBase64(flat),
    mimeType: "image/png",
    contextHintImage: hint,
    referenceImage: opts.referenceImage,
    referenceMimeType: opts.referenceImage ? "image/png" : undefined,
    signal: opts.signal,
  });

  // The model returns a full-scene image, possibly at a different resolution.
  // Normalize to doc dimensions so the masked region lines up with the original,
  // then feather-patch each masked blob back over its padded bbox.
  const aiImg = await base64ToImage(result.image, result.mimeType);
  const full = document.createElement("canvas");
  full.width = flat.width;
  full.height = flat.height;
  full.getContext("2d")!.drawImage(aiImg, 0, 0, full.width, full.height);

  const regions = getMaskRegions(maskCanvas, 0, false).map((b) =>
    padBBox(b, EDIT_PAD_PX, maskCanvas.width, maskCanvas.height)
  );
  return regions.map((bbox) => ({
    bbox,
    patch: patchFromFullResult(full, maskCanvas, bbox, BLEND_RADIUS),
  }));
}
