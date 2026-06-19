import type { AssetBitmap } from "./types";

// Holds the heavy decoded bitmaps that the serializable Doc only references by
// `assetId`. Lives outside React (and outside undo history) so the Doc stays
// small + JSON-serializable. A raster layer is rendered from the SAME cached
// bitmap both on-screen (<img>) and at export (drawImage) — decoded once.
//
// Object URLs are tracked so they can be revoked, but we deliberately do NOT
// evict on layer delete this phase: undo must be able to restore a deleted
// raster layer that still references a live asset. GC is a later phase.
export class AssetCache {
  private bitmaps = new Map<string, AssetBitmap>();
  private urls = new Map<string, string>();

  set(id: string, bitmap: AssetBitmap, objectUrl?: string): void {
    this.bitmaps.set(id, bitmap);
    if (objectUrl) this.urls.set(id, objectUrl);
  }

  get(id: string): AssetBitmap | undefined {
    return this.bitmaps.get(id);
  }

  has(id: string): boolean {
    return this.bitmaps.has(id);
  }

  // A URL usable as an <img src>. Prefers a stored object URL; falls back to the
  // element's own `src` when the bitmap is an HTMLImageElement.
  url(id: string): string | undefined {
    const stored = this.urls.get(id);
    if (stored) return stored;
    const bmp = this.bitmaps.get(id);
    if (bmp && bmp instanceof HTMLImageElement) return bmp.src;
    return undefined;
  }

  naturalSizeOf(id: string): { w: number; h: number } | undefined {
    const bmp = this.bitmaps.get(id);
    if (!bmp) return undefined;
    if (bmp instanceof HTMLImageElement) return { w: bmp.naturalWidth, h: bmp.naturalHeight };
    return { w: bmp.width, h: bmp.height };
  }
}
