import type { Doc } from "./types";
import type { AssetCache } from "./assetCache";
import { renderDocToCanvas } from "./render";
import { editImage, DEFAULT_MODEL } from "@/lib/gemini";
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

  const flat = renderDocToCanvas(doc, cache);
  const result = await editImage({
    apiKey,
    model,
    prompt,
    image: imageToBase64(flat),
    mimeType: "image/png",
    referenceImage,
    referenceMimeType: referenceImage ? "image/png" : undefined,
    signal,
  });
  return base64ToImage(result.image, result.mimeType);
}
