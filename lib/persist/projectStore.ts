// High-level project persistence: bridges the in-memory editor state
// (a JSON-serializable Doc + the AssetCache of decoded bitmaps) to IndexedDB.
//
// A Doc holds no bitmaps — only `assetId` references — so saving a project means
// (1) writing referenced asset bitmaps as Blobs (deduped, encoded once) and
// (2) writing the Doc JSON. Loading rehydrates the AssetCache from those Blobs,
// then hands back the Doc for the reducer to boot from.

import type { Doc } from "@/lib/doc/types";
import type { AssetCache } from "@/lib/doc/assetCache";
import { renderDocToCanvas } from "@/lib/doc/render";
import { idbDelete, idbGet, idbGetAll, idbPut } from "./db";

const LAST_PROJECT_KEY = "lastProjectId";
const WORKSPACE_KEY = "workspace";
const THUMB_MAX = 256; // longest-edge px for the stored project thumbnail

interface ProjectRecord {
  id: string;
  doc: Doc;
  assetIds: string[];
  updatedAt: number;
  thumbnail?: Blob;
}

// Lightweight metadata for the Open/projects picker (no heavy Doc payload).
export interface ProjectSummary {
  id: string;
  name: string;
  updatedAt: number;
  thumbnail?: Blob;
}

export interface WorkspaceMeta {
  openIds: string[];
  activeId: string;
}

// assetIds referenced by the present doc (only raster layers carry bitmaps).
export function referencedAssetIds(doc: Doc): string[] {
  const ids = new Set<string>();
  for (const layer of doc.layers) {
    if (layer.type === "raster") ids.add(layer.assetId);
  }
  return [...ids];
}

function canvasToBlob(canvas: HTMLCanvasElement, type = "image/png"): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("canvas.toBlob returned null"));
    }, type);
  });
}

// Rasterize a cached bitmap (HTMLImageElement | ImageBitmap) to a PNG Blob at its
// natural size. PNG preserves alpha (transparent backgrounds are common here).
function bitmapToBlob(cache: AssetCache, id: string): Promise<Blob> {
  const bmp = cache.get(id);
  if (!bmp) return Promise.reject(new Error(`asset ${id} not in cache`));
  const size = cache.naturalSizeOf(id);
  if (!size) return Promise.reject(new Error(`asset ${id} has no size`));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, size.w);
  canvas.height = Math.max(1, size.h);
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(bmp, 0, 0);
  return canvasToBlob(canvas);
}

function makeThumbnail(doc: Doc, cache: AssetCache): Blob | Promise<Blob> | undefined {
  if (doc.width <= 0 || doc.height <= 0) return undefined;
  const scale = Math.min(1, THUMB_MAX / Math.max(doc.width, doc.height));
  try {
    return canvasToBlob(renderDocToCanvas(doc, cache, scale), "image/png");
  } catch {
    return undefined; // thumbnail is best-effort; never fail a save over it
  }
}

// Persist the project. `persistedAssetIds` is a caller-owned set of assetIds
// already written this session — assets in it are NOT re-encoded, so repeated
// saves during editing only rewrite the (small) Doc JSON. `updatedAt` is passed
// in by the caller (app code supplies Date.now()).
export async function saveProject(
  doc: Doc,
  cache: AssetCache,
  persistedAssetIds: Set<string>,
  updatedAt: number
): Promise<void> {
  const assetIds = referencedAssetIds(doc);

  for (const id of assetIds) {
    if (persistedAssetIds.has(id)) continue;
    if (!cache.has(id)) continue; // missing bitmap — skip rather than crash the save
    const blob = await bitmapToBlob(cache, id);
    await idbPut("assets", { id, blob });
    persistedAssetIds.add(id);
  }

  const thumbnail = await makeThumbnail(doc, cache);
  const record: ProjectRecord = { id: doc.id, doc, assetIds, updatedAt, thumbnail };
  await idbPut("projects", record);
  await idbPut("meta", { key: LAST_PROJECT_KEY, value: doc.id });
}

// Load a project by id, rehydrating its bitmaps into `cache`. Returns null when
// the project is missing or an asset blob is gone (treat as "skip" rather than
// booting a broken doc). Returns the assetIds so the caller can seed its
// persisted-set and avoid re-encoding on the next save.
export async function loadProject(
  id: string,
  cache: AssetCache
): Promise<{ doc: Doc; assetIds: string[] } | null> {
  const record = await idbGet<ProjectRecord>("projects", id);
  if (!record) return null;

  for (const assetId of record.assetIds) {
    if (cache.has(assetId)) continue;
    const asset = await idbGet<{ id: string; blob: Blob }>("assets", assetId);
    if (!asset?.blob) return null; // referenced bitmap gone — don't boot a broken doc
    const url = URL.createObjectURL(asset.blob);
    const img = await loadImageFromUrl(url);
    cache.set(assetId, img, url);
  }

  return { doc: record.doc, assetIds: record.assetIds };
}

// The most recently active project (back-compat / fallback when no workspace
// meta exists). Thin wrapper over loadProject via meta.lastProjectId.
export async function loadLastProject(
  cache: AssetCache
): Promise<{ doc: Doc; assetIds: string[] } | null> {
  const meta = await idbGet<{ key: string; value: string }>("meta", LAST_PROJECT_KEY);
  if (!meta?.value) return null;
  return loadProject(meta.value, cache);
}

// Metadata for every stored project, newest first — for the Open/projects picker.
export async function listProjects(): Promise<ProjectSummary[]> {
  const records = await idbGetAll<ProjectRecord>("projects");
  return records
    .map((r) => ({ id: r.id, name: r.doc.name, updatedAt: r.updatedAt, thumbnail: r.thumbnail }))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

// Delete a project and its (exclusively-owned) asset blobs.
export async function deleteProject(id: string): Promise<void> {
  const record = await idbGet<ProjectRecord>("projects", id);
  await idbDelete("projects", id);
  if (record) {
    for (const assetId of record.assetIds) await idbDelete("assets", assetId);
  }
}

// Which tabs are open + which is active, so the workspace restores on reload.
export async function saveWorkspace(openIds: string[], activeId: string): Promise<void> {
  await idbPut("meta", { key: WORKSPACE_KEY, value: { openIds, activeId } satisfies WorkspaceMeta });
}

export async function loadWorkspace(): Promise<WorkspaceMeta | null> {
  const meta = await idbGet<{ key: string; value: WorkspaceMeta }>("meta", WORKSPACE_KEY);
  return meta?.value ?? null;
}

function loadImageFromUrl(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("failed to decode persisted asset"));
    img.src = url;
  });
}
