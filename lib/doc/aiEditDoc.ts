import type { Doc } from "./types";
import type { AssetCache } from "./assetCache";
import { renderDocToCanvas } from "./render";
import { editImage, DEFAULT_MODEL, type ImageSize } from "@/lib/gemini";
import { imageToBase64, base64ToImage } from "@/lib/canvas-utils";

// Headline AI feature, kept alive non-destructively: flatten the whole document
// to a bitmap, send it through the existing Gemini edit endpoint, and return the
// result image. The caller adds it as a NEW raster layer on top — originals
// untouched. Reads the same localStorage keys the legacy Editor used.
export async function aiEditFullDocument(
  doc: Doc,
  cache: AssetCache,
  prompt: string,
  signal?: AbortSignal,
  referenceImage?: string
): Promise<HTMLImageElement> {
  const apiKey = localStorage.getItem("gemini-api-key");
  if (!apiKey) throw new Error("API key is required — set it in Settings.");
  const model = localStorage.getItem("gemini-model") || DEFAULT_MODEL;
  const imageSize = (localStorage.getItem("gemini-image-size") as ImageSize) || undefined;

  const flat = renderDocToCanvas(doc, cache);
  const result = await editImage({
    apiKey,
    model,
    prompt,
    image: imageToBase64(flat),
    mimeType: "image/png",
    imageSize,
    referenceImage,
    referenceMimeType: referenceImage ? "image/png" : undefined,
    signal,
  });
  return base64ToImage(result.image, result.mimeType);
}

// Simple image→image Gemini edit on a single canvas — no doc, flatten, mask, or
// context machinery. Used to reprompt an already-generated result ("edit the
// generated image"): the model sees only `src` and applies `prompt`. Returns a
// canvas of the SAME pixel dimensions so the result drops straight back into the
// layer it replaces (or the review patch it came from).
// `rawPrompt` marks `prompt` as a fully-assembled instruction to send verbatim
// (full-image generate, where the user may have edited it via the Advanced
// preview). Reprompt callers omit it — their raw instruction has no augmentation.
export async function aiEditCanvas(
  src: HTMLCanvasElement,
  prompt: string,
  signal?: AbortSignal,
  referenceImage?: string,
  rawPrompt?: boolean
): Promise<HTMLCanvasElement> {
  const apiKey = localStorage.getItem("gemini-api-key");
  if (!apiKey) throw new Error("API key is required — set it in Settings.");
  const model = localStorage.getItem("gemini-model") || DEFAULT_MODEL;
  const imageSize = (localStorage.getItem("gemini-image-size") as ImageSize) || undefined;

  const result = await editImage({
    apiKey,
    model,
    prompt,
    rawPrompt,
    image: imageToBase64(src),
    mimeType: "image/png",
    imageSize,
    referenceImage,
    referenceMimeType: referenceImage ? "image/png" : undefined,
    signal,
  });

  const img = await base64ToImage(result.image, result.mimeType);
  const out = document.createElement("canvas");
  out.width = src.width;
  out.height = src.height;
  out.getContext("2d")!.drawImage(img, 0, 0, out.width, out.height);
  return out;
}
