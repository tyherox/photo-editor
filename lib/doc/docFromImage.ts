// Build a brand-new document sized to an image file, registering the decoded
// bitmap in the shared AssetCache. Shared by the start screen, the New-document
// dialog, and the Open/projects dialog so "new canvas from image" behaves
// identically everywhere.

import { loadImageToCanvas } from "@/lib/canvas-utils";
import type { AssetCache } from "./assetCache";
import { defaultTransform, emptyDoc, makeRasterLayer, newId, type Doc } from "./types";

export async function docFromImageFile(
  file: File,
  cache: AssetCache
): Promise<{ doc: Doc; assetIds: string[] }> {
  const { img } = await loadImageToCanvas(file);
  const assetId = newId();
  cache.set(assetId, img);

  const doc = emptyDoc(img.naturalWidth, img.naturalHeight, "transparent");
  doc.name = file.name.replace(/\.[^.]+$/, "") || "Untitled";
  doc.layers.push(
    makeRasterLayer(assetId, img.naturalWidth, img.naturalHeight, defaultTransform(0, 0), file.name)
  );
  return { doc, assetIds: [assetId] };
}
