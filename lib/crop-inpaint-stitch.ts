export interface BBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface CropResult {
  croppedImage: HTMLCanvasElement;
  croppedMask: HTMLCanvasElement;
  bbox: BBox;
  originalWidth: number;
  originalHeight: number;
}

// Expand a box to a square centered on it, clamped within the image. Keeping the
// crop square means it maps 1:1 onto the square model canvas and back without
// distorting (squishing) the region — which otherwise skews generated content.
function squareBBox(b: BBox, imgW: number, imgH: number): BBox {
  const size = Math.min(Math.max(b.w, b.h), imgW, imgH);
  const cx = b.x + b.w / 2;
  const cy = b.y + b.h / 2;
  const x = Math.max(0, Math.min(Math.round(cx - size / 2), imgW - size));
  const y = Math.max(0, Math.min(Math.round(cy - size / 2), imgH - size));
  return { x, y, w: size, h: size };
}

export function getMaskBoundingBox(
  maskCanvas: HTMLCanvasElement,
  padding: number = 0.5,
  square: boolean = false
): BBox | null {
  const ctx = maskCanvas.getContext("2d")!;
  const { width, height } = maskCanvas;
  const data = ctx.getImageData(0, 0, width, height).data;

  let minX = width, minY = height, maxX = 0, maxY = 0;
  let found = false;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] > 10) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        found = true;
      }
    }
  }

  if (!found) return null;

  const maskW = maxX - minX;
  const maskH = maxY - minY;
  const padX = Math.round(maskW * padding);
  const padY = Math.round(maskH * padding);

  const x = Math.max(0, minX - padX);
  const y = Math.max(0, minY - padY);
  const x2 = Math.min(width, maxX + padX);
  const y2 = Math.min(height, maxY + padY);

  const box = { x, y, w: x2 - x, h: y2 - y };
  return square ? squareBBox(box, width, height) : box;
}

export function boxesOverlap(a: BBox, b: BBox): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

// Find separate (non-contiguous) mask blobs and return one padded box per blob,
// so disjoint selections aren't merged into one giant region that regenerates
// everything between them. Connected components are found on a downscaled copy
// for speed, then mapped back to native pixels.
export function getMaskRegions(
  maskCanvas: HTMLCanvasElement,
  padding: number = 0.5,
  square: boolean = false
): BBox[] {
  const { width, height } = maskCanvas;
  const scale = Math.min(1, 200 / Math.max(width, height));
  const dw = Math.max(1, Math.round(width * scale));
  const dh = Math.max(1, Math.round(height * scale));

  const off = document.createElement("canvas");
  off.width = dw;
  off.height = dh;
  const octx = off.getContext("2d")!;
  octx.drawImage(maskCanvas, 0, 0, dw, dh);
  const data = octx.getImageData(0, 0, dw, dh).data;

  const visited = new Uint8Array(dw * dh);
  const isMask = (i: number) => data[i * 4 + 3] > 10;
  const stack: number[] = [];
  let boxes: BBox[] = [];

  for (let start = 0; start < dw * dh; start++) {
    if (visited[start] || !isMask(start)) continue;
    let minX = dw, minY = dh, maxX = 0, maxY = 0;
    stack.push(start);
    visited[start] = 1;
    while (stack.length) {
      const p = stack.pop()!;
      const x = p % dw;
      const y = (p / dw) | 0;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      for (let ny = y - 1; ny <= y + 1; ny++) {
        for (let nx = x - 1; nx <= x + 1; nx++) {
          if (nx < 0 || ny < 0 || nx >= dw || ny >= dh) continue;
          const np = ny * dw + nx;
          if (!visited[np] && isMask(np)) {
            visited[np] = 1;
            stack.push(np);
          }
        }
      }
    }

    // Map blob bounds back to native px and pad.
    const nx1 = minX / scale, ny1 = minY / scale;
    const nx2 = (maxX + 1) / scale, ny2 = (maxY + 1) / scale;
    const padX = Math.round((nx2 - nx1) * padding);
    const padY = Math.round((ny2 - ny1) * padding);
    const bx = Math.max(0, Math.round(nx1) - padX);
    const by = Math.max(0, Math.round(ny1) - padY);
    const bx2 = Math.min(width, Math.round(nx2) + padX);
    const by2 = Math.min(height, Math.round(ny2) + padY);
    let box = { x: bx, y: by, w: bx2 - bx, h: by2 - by };
    if (square) box = squareBBox(box, width, height);
    boxes.push(box);
  }

  // Merge boxes whose padded regions overlap (avoids editing the same spot twice).
  let merged = true;
  while (merged && boxes.length > 1) {
    merged = false;
    outer: for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        if (boxesOverlap(boxes[i], boxes[j])) {
          const a = boxes[i], b = boxes[j];
          const ux = Math.min(a.x, b.x), uy = Math.min(a.y, b.y);
          const ux2 = Math.max(a.x + a.w, b.x + b.w), uy2 = Math.max(a.y + a.h, b.y + b.h);
          let u = { x: ux, y: uy, w: ux2 - ux, h: uy2 - uy };
          if (square) u = squareBBox(u, width, height);
          boxes = boxes.filter((_, k) => k !== i && k !== j);
          boxes.push(u);
          merged = true;
          break outer;
        }
      }
    }
  }

  return boxes;
}

export function cropToRegion(
  imageCanvas: HTMLCanvasElement,
  maskCanvas: HTMLCanvasElement,
  bbox: BBox,
  targetSize: number
): CropResult {
  // Scale the longest side to targetSize and keep the bbox's aspect ratio, so a
  // non-square region isn't squished into a square (which would skew generated
  // content). A square bbox still maps to targetSize x targetSize.
  const longest = Math.max(bbox.w, bbox.h);
  const tw = Math.max(1, Math.round((bbox.w / longest) * targetSize));
  const th = Math.max(1, Math.round((bbox.h / longest) * targetSize));

  const croppedImage = document.createElement("canvas");
  croppedImage.width = tw;
  croppedImage.height = th;
  const imgCtx = croppedImage.getContext("2d")!;
  imgCtx.drawImage(
    imageCanvas,
    bbox.x, bbox.y, bbox.w, bbox.h,
    0, 0, tw, th
  );

  const croppedMask = document.createElement("canvas");
  croppedMask.width = tw;
  croppedMask.height = th;
  const maskCtx = croppedMask.getContext("2d")!;
  maskCtx.drawImage(
    maskCanvas,
    bbox.x, bbox.y, bbox.w, bbox.h,
    0, 0, tw, th
  );

  return {
    croppedImage,
    croppedMask,
    bbox,
    originalWidth: imageCanvas.width,
    originalHeight: imageCanvas.height,
  };
}

export function stitchBack(
  originalCanvas: HTMLCanvasElement,
  inpaintedCrop: HTMLCanvasElement,
  maskCanvas: HTMLCanvasElement,
  bbox: BBox,
  blendRadius: number = 12
): HTMLCanvasElement {
  const { width, height } = originalCanvas;
  const result = document.createElement("canvas");
  result.width = width;
  result.height = height;
  const ctx = result.getContext("2d")!;

  ctx.drawImage(originalCanvas, 0, 0);

  const resizedCrop = document.createElement("canvas");
  resizedCrop.width = bbox.w;
  resizedCrop.height = bbox.h;
  resizedCrop.getContext("2d")!.drawImage(
    inpaintedCrop,
    0, 0, inpaintedCrop.width, inpaintedCrop.height,
    0, 0, bbox.w, bbox.h
  );

  const origData = originalCanvas.getContext("2d")!.getImageData(bbox.x, bbox.y, bbox.w, bbox.h);
  const cropData = resizedCrop.getContext("2d")!.getImageData(0, 0, bbox.w, bbox.h);
  const maskData = maskCanvas.getContext("2d")!.getImageData(bbox.x, bbox.y, bbox.w, bbox.h);

  const alpha = new Float32Array(bbox.w * bbox.h);
  for (let i = 0; i < alpha.length; i++) {
    alpha[i] = maskData.data[i * 4 + 3] > 10 ? 1.0 : 0.0;
  }

  const blurred = blendRadius > 0 ? boxBlur(alpha, bbox.w, bbox.h, blendRadius) : alpha;

  const blended = ctx.createImageData(bbox.w, bbox.h);
  for (let i = 0; i < alpha.length; i++) {
    const a = blurred[i];
    const pi = i * 4;
    blended.data[pi] = Math.round(origData.data[pi] * (1 - a) + cropData.data[pi] * a);
    blended.data[pi + 1] = Math.round(origData.data[pi + 1] * (1 - a) + cropData.data[pi + 1] * a);
    blended.data[pi + 2] = Math.round(origData.data[pi + 2] * (1 - a) + cropData.data[pi + 2] * a);
    blended.data[pi + 3] = 255;
  }

  ctx.putImageData(blended, bbox.x, bbox.y);
  return result;
}

function boxBlur(
  input: Float32Array,
  w: number,
  h: number,
  radius: number
): Float32Array {
  let src = new Float32Array(input);
  let dst = new Float32Array(w * h);

  for (let pass = 0; pass < 3; pass++) {
    for (let y = 0; y < h; y++) {
      let sum = 0;
      for (let x = 0; x < Math.min(radius, w); x++) {
        sum += src[y * w + x];
      }
      for (let x = 0; x < w; x++) {
        const left = x - radius - 1;
        const right = x + radius;
        if (right < w) sum += src[y * w + right];
        if (left >= 0) sum -= src[y * w + left];
        dst[y * w + x] = sum / (Math.min(x + radius, w - 1) - Math.max(x - radius, 0) + 1);
      }
    }
    [src, dst] = [dst, src];

    for (let x = 0; x < w; x++) {
      let sum = 0;
      for (let y = 0; y < Math.min(radius, h); y++) {
        sum += src[y * w + x];
      }
      for (let y = 0; y < h; y++) {
        const top = y - radius - 1;
        const bottom = y + radius;
        if (bottom < h) sum += src[bottom * w + x];
        if (top >= 0) sum -= src[top * w + x];
        dst[y * w + x] = sum / (Math.min(y + radius, h - 1) - Math.max(y - radius, 0) + 1);
      }
    }
    [src, dst] = [dst, src];
  }

  return src;
}

export async function cropInpaintStitch(
  originalCanvas: HTMLCanvasElement,
  maskCanvas: HTMLCanvasElement,
  inpaintFn: (image: HTMLCanvasElement, mask: HTMLCanvasElement) => Promise<HTMLCanvasElement>,
  options: { targetSize?: number; padding?: number; blendRadius?: number; upscale?: boolean; bbox?: BBox; square?: boolean } = {}
): Promise<HTMLCanvasElement> {
  const { targetSize = 512, padding = 0.5, blendRadius = 12, upscale: doUpscale = true, bbox: override, square = false } = options;

  // A manual crop override takes precedence; otherwise each non-contiguous mask
  // blob is processed as its own region. `square` is only needed for models that
  // require a square input — otherwise the crop keeps the mask's aspect ratio.
  const regions = override
    ? [square ? squareBBox(override, originalCanvas.width, originalCanvas.height) : override]
    : getMaskRegions(maskCanvas, padding, square);
  if (!regions.length) return originalCanvas;

  // Edit each region in turn, compounding onto the running result. The mask is
  // always read from the original mask, so only that blob is affected per region.
  let result = originalCanvas;
  for (const bbox of regions) {
    const { croppedImage, croppedMask } = cropToRegion(result, maskCanvas, bbox, targetSize);

    let inpaintedCrop = await inpaintFn(croppedImage, croppedMask);

    if (doUpscale && (inpaintedCrop.width < bbox.w || inpaintedCrop.height < bbox.h)) {
      const { upscale } = await import("./local-upscale");
      console.log(`[Upscale] ${inpaintedCrop.width}x${inpaintedCrop.height} → ${bbox.w}x${bbox.h}`);
      inpaintedCrop = await upscale(inpaintedCrop, bbox.w, bbox.h);
    }

    result = stitchBack(result, inpaintedCrop, maskCanvas, bbox, blendRadius);
  }

  return result;
}

// Build a bbox-sized RGBA patch: RGB from the (resized) inpainted crop, alpha
// from the feathered mask. Drawn on top of the composite, it blends exactly like
// stitchBack but as a standalone layer — so concurrent region edits don't occlude.
function buildPatch(
  inpaintedCrop: HTMLCanvasElement,
  maskCanvas: HTMLCanvasElement,
  bbox: BBox,
  blendRadius: number
): HTMLCanvasElement {
  const resizedCrop = document.createElement("canvas");
  resizedCrop.width = bbox.w;
  resizedCrop.height = bbox.h;
  resizedCrop.getContext("2d")!.drawImage(
    inpaintedCrop,
    0, 0, inpaintedCrop.width, inpaintedCrop.height,
    0, 0, bbox.w, bbox.h
  );

  const cropData = resizedCrop.getContext("2d")!.getImageData(0, 0, bbox.w, bbox.h);
  const maskData = maskCanvas.getContext("2d")!.getImageData(bbox.x, bbox.y, bbox.w, bbox.h);

  const alpha = new Float32Array(bbox.w * bbox.h);
  for (let i = 0; i < alpha.length; i++) {
    alpha[i] = maskData.data[i * 4 + 3] > 10 ? 1.0 : 0.0;
  }
  const blurred = blendRadius > 0 ? boxBlur(alpha, bbox.w, bbox.h, blendRadius) : alpha;

  const out = document.createElement("canvas");
  out.width = bbox.w;
  out.height = bbox.h;
  const octx = out.getContext("2d")!;
  const patch = octx.createImageData(bbox.w, bbox.h);
  for (let i = 0; i < alpha.length; i++) {
    const pi = i * 4;
    patch.data[pi] = cropData.data[pi];
    patch.data[pi + 1] = cropData.data[pi + 1];
    patch.data[pi + 2] = cropData.data[pi + 2];
    patch.data[pi + 3] = Math.round(blurred[i] * 255);
  }
  octx.putImageData(patch, 0, 0);
  return out;
}

// Expand a box by an ABSOLUTE pixel amount on each side, clamped to the image.
export function padBBox(b: BBox, px: number, imgW: number, imgH: number): BBox {
  const x = Math.max(0, b.x - px);
  const y = Math.max(0, b.y - px);
  const x2 = Math.min(imgW, b.x + b.w + px);
  const y2 = Math.min(imgH, b.y + b.h + px);
  return { x, y, w: x2 - x, h: y2 - y };
}

// Like cropInpaintStitch, but returns one feathered patch per masked region
// (positioned by bbox) instead of compounding onto a full-canvas result. Used
// for non-destructive, concurrency-safe layer patches. `padPx` is absolute.
export async function cropInpaintToPatches(
  originalCanvas: HTMLCanvasElement,
  maskCanvas: HTMLCanvasElement,
  inpaintFn: (image: HTMLCanvasElement, mask: HTMLCanvasElement) => Promise<HTMLCanvasElement>,
  options: { targetSize?: number; padPx?: number; blendRadius?: number; upscale?: boolean; bbox?: BBox; square?: boolean } = {}
): Promise<{ bbox: BBox; patch: HTMLCanvasElement }[]> {
  const { targetSize = 512, padPx = 0, blendRadius = 12, upscale: doUpscale = true, bbox: override, square = false } = options;
  const { width: W, height: H } = originalCanvas;

  // Tight regions (no fractional padding), then expand by an absolute px margin.
  const regions = (override ? [override] : getMaskRegions(maskCanvas, 0, square)).map((b) => {
    const padded = padBBox(b, padPx, W, H);
    return square ? squareBBox(padded, W, H) : padded;
  });

  const patches: { bbox: BBox; patch: HTMLCanvasElement }[] = [];
  for (const bbox of regions) {
    const { croppedImage, croppedMask } = cropToRegion(originalCanvas, maskCanvas, bbox, targetSize);
    let inpaintedCrop = await inpaintFn(croppedImage, croppedMask);
    if (doUpscale && (inpaintedCrop.width < bbox.w || inpaintedCrop.height < bbox.h)) {
      const { upscale } = await import("./local-upscale");
      inpaintedCrop = await upscale(inpaintedCrop, bbox.w, bbox.h);
    }
    patches.push({ bbox, patch: buildPatch(inpaintedCrop, maskCanvas, bbox, blendRadius) });
  }
  return patches;
}
