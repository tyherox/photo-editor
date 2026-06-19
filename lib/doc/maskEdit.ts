import type { Doc } from "./types";
import type { AssetCache } from "./assetCache";
import { renderDocToCanvas } from "./render";
import { editImage, DEFAULT_MODEL } from "@/lib/gemini";
import { imageToBase64, base64ToImage } from "@/lib/canvas-utils";
import { cropInpaintToPatches, getMaskRegions, padBBox, type BBox } from "@/lib/crop-inpaint-stitch";
import { inpaint as localInpaint, type LoadProgress } from "@/lib/local-inpaint";

// Targeted ("area") editing on the layer model: flatten the document, run the
// existing crop-inpaint-stitch pipeline over the masked region, and return a
// doc-sized result. The caller adds it as a new raster layer (non-destructive).
// Pipeline constants + the style-preserve prompt are ported from the legacy
// Editor so behavior matches the old "Edit Area" / local removal exactly.

// Very minimal context around the selection: the model sees a small ABSOLUTE
// pixel border for better blending, but the feathered patch only writes back the
// selection itself. `square: false` keeps the crop at the selection's aspect
// ratio. blendRadius stays ≤ padPx so the feather fully ramps within the border.
const EDIT_PAD_PX = 24; // doc px added on each side of the selection
const GEMINI_CROP = { targetSize: 1024, padPx: EDIT_PAD_PX, blendRadius: 16, square: false };
const LOCAL_CROP = { targetSize: 512, padPx: EDIT_PAD_PX, blendRadius: 12, square: false };

// Seam-blending guidance only. Deliberately domain-agnostic and non-overriding:
// it must NOT tell the model to keep colors/lighting/style/texture fixed, since
// that would countermand legitimate edits (recolor, relight, restyle) and fight
// reference-image edits. The single guardrail — "only what the instruction
// describes" — keeps the model from rewriting the whole region unprompted.
const STYLE_PRESERVE =
  "Apply only the change described in the instruction, and blend it seamlessly " +
  "into the surrounding image so the edited region's edges have no visible seams.";

async function geminiInpaintCrop(
  prompt: string,
  croppedImage: HTMLCanvasElement,
  referenceImage?: string,
  signal?: AbortSignal
): Promise<HTMLCanvasElement> {
  const apiKey = localStorage.getItem("gemini-api-key");
  if (!apiKey) throw new Error("API key is required — set it in Settings.");
  const model = localStorage.getItem("gemini-model") || DEFAULT_MODEL;

  const result = await editImage({
    apiKey,
    model,
    prompt: `${prompt}. ${STYLE_PRESERVE}`,
    image: imageToBase64(croppedImage),
    mimeType: "image/png",
    referenceImage,
    referenceMimeType: referenceImage ? "image/png" : undefined,
    signal,
  });

  const aiImg = await base64ToImage(result.image, result.mimeType);
  const out = document.createElement("canvas");
  out.width = croppedImage.width;
  out.height = croppedImage.height;
  out.getContext("2d")!.drawImage(aiImg, 0, 0, out.width, out.height);
  return out;
}

export type AreaBackend = "gemini" | "local";

export interface AreaEditOptions {
  backend: AreaBackend;
  prompt?: string;
  referenceImage?: string;
  onProgress?: (p: LoadProgress) => void;
  signal?: AbortSignal;
}

// The exact per-region boxes that will be cropped and sent to the model — tight
// selection blobs expanded by the same absolute padding. Drives the on-canvas
// "impact area" overlay so it matches what the pipeline actually does.
export function cropRegions(maskCanvas: HTMLCanvasElement): BBox[] {
  return getMaskRegions(maskCanvas, 0, false).map((b) =>
    padBBox(b, EDIT_PAD_PX, maskCanvas.width, maskCanvas.height)
  );
}

// Union bounding box of the painted mask, expanded by the same absolute padding
// the crop uses — the area a job reserves while in flight. Null if nothing painted.
export function reservedBBox(maskCanvas: HTMLCanvasElement): BBox | null {
  const regions = getMaskRegions(maskCanvas, 0, false);
  if (!regions.length) return null;
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (const r of regions) {
    x1 = Math.min(x1, r.x);
    y1 = Math.min(y1, r.y);
    x2 = Math.max(x2, r.x + r.w);
    y2 = Math.max(y2, r.y + r.h);
  }
  return padBBox({ x: x1, y: y1, w: x2 - x1, h: y2 - y1 }, EDIT_PAD_PX, maskCanvas.width, maskCanvas.height);
}

// Edit the masked region(s) and return one feathered patch per region for
// placement as standalone layers (concurrency-safe; non-occluding).
export async function editMaskedRegionPatches(
  doc: Doc,
  cache: AssetCache,
  maskCanvas: HTMLCanvasElement,
  opts: AreaEditOptions
): Promise<{ bbox: BBox; patch: HTMLCanvasElement }[]> {
  const flat = renderDocToCanvas(doc, cache);
  if (opts.backend === "local") {
    return cropInpaintToPatches(
      flat,
      maskCanvas,
      async (img, msk) => localInpaint(img, msk, opts.onProgress),
      LOCAL_CROP
    );
  }
  return cropInpaintToPatches(
    flat,
    maskCanvas,
    async (img) => geminiInpaintCrop(opts.prompt ?? "", img, opts.referenceImage, opts.signal),
    GEMINI_CROP
  );
}
