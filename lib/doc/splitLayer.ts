import { makeRasterLayer, newId, type RasterLayer } from "./types";
import type { AssetCache } from "./assetCache";
import { affinePoint } from "./geometry";
import { imageToBase64, base64ToImage } from "@/lib/canvas-utils";

// Cut a raster layer at explicit boundary positions (in the layer's NATURAL px
// along the axis; x = vertical cuts → columns, y = horizontal cuts → rows). Each
// resulting segment becomes its own raster layer, positioned to sit exactly where
// it was — via affinePoint, so a scaled/rotated source still lines up.
export async function splitRasterLayer(
  layer: RasterLayer,
  cache: AssetCache,
  axis: "x" | "y",
  boundaries: number[]
): Promise<RasterLayer[]> {
  const bmp = cache.get(layer.assetId);
  if (!bmp) return [];

  const { naturalWidth: W, naturalHeight: H, transform } = layer;
  const dim = axis === "x" ? W : H;
  // De-dupe + sort the interior cut positions, then bracket with 0 and dim.
  const cuts = [...new Set(boundaries.map((b) => Math.round(b)).filter((b) => b > 0 && b < dim))].sort((a, b) => a - b);
  if (!cuts.length) return [];
  const edges = [0, ...cuts, dim];

  const out: RasterLayer[] = [];
  for (let i = 0; i < edges.length - 1; i++) {
    const lo = edges[i];
    const hi = edges[i + 1];
    const sx = axis === "x" ? lo : 0;
    const sy = axis === "y" ? lo : 0;
    const sw = axis === "x" ? hi - lo : W;
    const sh = axis === "y" ? hi - lo : H;
    if (sw <= 0 || sh <= 0) continue;

    const c = document.createElement("canvas");
    c.width = sw;
    c.height = sh;
    c.getContext("2d")!.drawImage(bmp, sx, sy, sw, sh, 0, 0, sw, sh);
    const img = await base64ToImage(imageToBase64(c));
    const assetId = newId();
    cache.set(assetId, img);

    const o = affinePoint(transform, sx, sy);
    out.push(
      makeRasterLayer(
        assetId,
        sw,
        sh,
        { x: o.x, y: o.y, scaleX: transform.scaleX, scaleY: transform.scaleY, rotation: transform.rotation },
        `${layer.name} ${i + 1}`
      )
    );
  }
  return out;
}
