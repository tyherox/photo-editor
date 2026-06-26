// Estimate which of two SIMILAR images has more *actual* visual resolution —
// i.e. real captured/rendered detail, not just pixel dimensions. A 4000px image
// that was upscaled from 800px has lots of pixels but little real detail; this
// measures the detail, so it isn't fooled by the metadata size.
//
// Method: resample BOTH images to a common pixel grid (the larger of the two), then
// measure high-frequency energy and edge sharpness there. At the same grid, a truly
// high-res image keeps crisp fine detail (high HF energy, narrow edges), while an
// upscaled/soft one is smooth (low HF energy, wide edges). Comparing on one grid
// makes it a fair, size-independent test.

export interface ImageStats {
  width: number; // native pixel dimensions (metadata size)
  height: number;
  hfRatio: number; // high-frequency energy ÷ total variance (sharpness, ↑ = more detail)
  acutance: number; // mean edge gradient ÷ contrast (↑ = crisper)
  edgeWidth: number; // avg edge transition width in px at the common grid (↓ = sharper)
  effectivePx: number; // estimated real-detail "long side" in px (see effectiveLongSide)
  noise: number; // grain level: high-frequency energy in FLAT areas ÷ variance (↓ = cleaner)
}

// Three independent axes, no single "winner": real detail, cleanliness, and raw
// pixel size pull in different directions (e.g. a clean AI upscale has more pixels
// and less grain but slightly less real detail than a grainier original). The UI
// shows all three side by side so the user judges which version they want.
export interface CompareResult {
  a: ImageStats;
  b: ImageStats;
  commonW: number;
  commonH: number;
  diff: HTMLCanvasElement; // |A−B| heatmap at common grid
  normA: HTMLCanvasElement; // both resampled to the common grid (for aligned pixel zoom)
  normB: HTMLCanvasElement;
}

const MAX_ANALYSIS_LONG = 1400; // cap the common grid for speed

function lumaArray(canvas: HTMLCanvasElement): { lum: Float32Array; w: number; h: number } {
  const { width: w, height: h } = canvas;
  const d = canvas.getContext("2d")!.getImageData(0, 0, w, h).data;
  const lum = new Float32Array(w * h);
  for (let i = 0; i < lum.length; i++) {
    const p = i * 4;
    lum[i] = 0.2126 * d[p] + 0.7152 * d[p + 1] + 0.0722 * d[p + 2];
  }
  return { lum, w, h };
}

function boxBlur1(src: Float32Array, w: number, h: number, r: number): Float32Array {
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  const norm = 1 / (2 * r + 1);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let sum = 0;
    for (let k = -r; k <= r; k++) sum += src[row + Math.min(w - 1, Math.max(0, k))];
    for (let x = 0; x < w; x++) {
      tmp[row + x] = sum * norm;
      sum += src[row + Math.min(w - 1, x + r + 1)] - src[row + Math.max(0, x - r)];
    }
  }
  for (let x = 0; x < w; x++) {
    let sum = 0;
    for (let k = -r; k <= r; k++) sum += tmp[Math.min(h - 1, Math.max(0, k)) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = sum * norm;
      sum += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x];
    }
  }
  return out;
}

// Sharpness/detail stats on a luminance buffer (already at the common grid).
function analyze(lum: Float32Array, w: number, h: number, nativeW: number, nativeH: number): Omit<ImageStats, "effectivePx" | "noise"> {
  const n = w * h;

  // Contrast (mean) and variance.
  let mean = 0;
  for (let i = 0; i < n; i++) mean += lum[i];
  mean /= n;
  let variance = 0;
  for (let i = 0; i < n; i++) {
    const d = lum[i] - mean;
    variance += d * d;
  }
  variance /= n;

  // High-frequency energy = how much the image differs from a slightly blurred copy.
  const blurred = boxBlur1(lum, w, h, 2);
  let hf = 0;
  for (let i = 0; i < n; i++) {
    const d = lum[i] - blurred[i];
    hf += d * d;
  }
  hf /= n;
  const hfRatio = hf / (variance + 1);

  // Edge stats via gradient. Robust contrast from a luminance histogram (2–98%).
  const hist = new Float32Array(256);
  for (let i = 0; i < n; i++) hist[Math.max(0, Math.min(255, Math.round(lum[i])))]++;
  let cum = 0, gLo = 0, gHi = 255, set = false;
  for (let b = 0; b < 256; b++) {
    cum += hist[b];
    if (!set && cum >= 0.02 * n) { gLo = b; set = true; }
    if (cum >= 0.98 * n) { gHi = b; break; }
  }
  const contrast = Math.max(1, gHi - gLo);

  let maxG = 0;
  const grad = new Float32Array(n);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const g = Math.max(Math.abs(lum[i + 1] - lum[i - 1]), Math.abs(lum[i + w] - lum[i - w])) / 2;
      grad[i] = g;
      if (g > maxG) maxG = g;
    }
  }
  const strong = 0.25 * maxG;
  let gsum = 0, gcnt = 0;
  for (let i = 0; i < n; i++) if (grad[i] > strong) { gsum += grad[i]; gcnt++; }
  const meanStrongGrad = gcnt ? gsum / gcnt : 0;
  const acutance = meanStrongGrad / contrast;
  const edgeWidth = meanStrongGrad > 0 ? contrast / meanStrongGrad : Infinity;

  return { width: nativeW, height: nativeH, hfRatio, acutance, edgeWidth };
}

function drawTo(img: HTMLImageElement | HTMLCanvasElement | ImageBitmap, w: number, h: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d")!;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, 0, 0, w, h);
  return c;
}

// --- Effective resolution -------------------------------------------------
// The headline measure. Rather than resampling both images to one shared grid
// and comparing per-pixel sharpness there — which unfairly favours the LESS
// downsampled (smaller) image and is fooled by sharpening — we estimate each
// image's effective resolution independently: the finest scale at which it
// still holds genuine detail. "Genuine" is probed by a 2× down→up roundtrip:
// real detail is destroyed by it (large residual), whereas soft/upscaled pixels
// or sharpening halos survive (small residual at the native scale only). This
// correctly ranks a big-but-soft 5929px image below/near a crisp 1825px one,
// and a true 4000px image above an oversharpened 800px one.

const EFFRES_CAP = 3200; // finest long-side we probe (bounds getImageData cost)
const REALNESS_T = 0.06; // roundtrip residual ÷ variance that marks "real detail"

// Clean area-averaged downscale to w×h via successive halving (a single large
// reduction aliases / under-filters; halving keeps it faithful).
function downscaleClean(src: CompareSource, w: number, h: number): HTMLCanvasElement {
  let cur: HTMLCanvasElement = document.createElement("canvas");
  const sw = (src as HTMLImageElement).naturalWidth || src.width;
  const sh = (src as HTMLImageElement).naturalHeight || src.height;
  cur.width = sw;
  cur.height = sh;
  cur.getContext("2d")!.drawImage(src, 0, 0);
  while (cur.width > w * 2 && cur.height > h * 2) {
    const nw = Math.max(w, cur.width >> 1);
    const nh = Math.max(h, cur.height >> 1);
    const next = document.createElement("canvas");
    next.width = nw;
    next.height = nh;
    const cx = next.getContext("2d")!;
    cx.imageSmoothingEnabled = true;
    cx.imageSmoothingQuality = "high";
    cx.drawImage(cur, 0, 0, nw, nh);
    cur = next;
  }
  if (cur.width === w && cur.height === h) return cur;
  const out = document.createElement("canvas");
  out.width = w;
  out.height = h;
  const ox = out.getContext("2d")!;
  ox.imageSmoothingEnabled = true;
  ox.imageSmoothingQuality = "high";
  ox.drawImage(cur, 0, 0, w, h);
  return out;
}

// Top-octave "realness": fraction of variance lost when the image is halved and
// re-enlarged. High → genuine detail at this pixel scale; low → already smooth.
function roundtripRealness(cv: HTMLCanvasElement): number {
  const W = cv.width, H = cv.height;
  const half = downscaleClean(cv, Math.max(2, W >> 1), Math.max(2, H >> 1));
  const back = document.createElement("canvas");
  back.width = W;
  back.height = H;
  const bx = back.getContext("2d")!;
  bx.imageSmoothingEnabled = true;
  bx.imageSmoothingQuality = "high";
  bx.drawImage(half, 0, 0, W, H);
  const a = lumaArray(cv).lum;
  const b = lumaArray(back).lum;
  const n = W * H;
  let mean = 0;
  for (let i = 0; i < n; i++) mean += a[i];
  mean /= n;
  let res = 0, variance = 0;
  for (let i = 0; i < n; i++) {
    const d = a[i] - b[i];
    res += d * d;
    const dv = a[i] - mean;
    variance += dv * dv;
  }
  return res / n / (variance / n + 1);
}

// Per-patch: mean gradient (how flat the patch is) and RMS high-frequency
// amplitude over its flattest pixels (its grain, unnormalised).
function patchGrain(lum: Float32Array, w: number, h: number): { meanGrad: number; grainRms: number } {
  const n = w * h;
  const grad = new Float32Array(n);
  let gSum = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const g = Math.max(Math.abs(lum[i + 1] - lum[i - 1]), Math.abs(lum[i + w] - lum[i - w])) / 2;
      grad[i] = g;
      gSum += g;
    }
  }
  const samp: number[] = [];
  for (let i = 0; i < n; i += 5) samp.push(grad[i]);
  samp.sort((p, q) => p - q);
  const thr = samp[Math.floor(samp.length * 0.4)] ?? 0;
  const blur = boxBlur1(lum, w, h, 1);
  let hf = 0, cnt = 0;
  for (let i = 0; i < n; i++) {
    if (grad[i] <= thr) {
      const d = lum[i] - blur[i];
      hf += d * d;
      cnt++;
    }
  }
  return { meanGrad: gSum / n, grainRms: cnt ? Math.sqrt(hf / cnt) : 0 };
}

// Grain level as a percent: RMS high-frequency amplitude in the image's FLATTEST
// areas ÷ robust contrast × 100. ↓ = cleaner. Real detail lives at edges/texture;
// grain is everywhere, including flat areas — so HF where there's no structure
// isolates it. Sampled from native 1:1 patches across the frame (grain lives at the
// native pixel scale), measured on the flattest patches (smooth sky/skin) so a busy
// centre doesn't hide it. Contrast-normalised → exposure-independent.
function measureNoise(src: CompareSource): number {
  const nw = (src as HTMLImageElement).naturalWidth || src.width;
  const nh = (src as HTMLImageElement).naturalHeight || src.height;
  const P = Math.min(360, nw, nh);
  const fr = [0.12, 0.34, 0.5, 0.66, 0.88];
  const patches: { meanGrad: number; grainRms: number }[] = [];
  const lumSamples: number[] = [];
  for (const fy of fr) {
    for (const fx of fr) {
      const cx = Math.max(0, Math.min(nw - P, Math.round(fx * nw - P / 2)));
      const cy = Math.max(0, Math.min(nh - P, Math.round(fy * nh - P / 2)));
      const c = document.createElement("canvas");
      c.width = P;
      c.height = P;
      c.getContext("2d")!.drawImage(src, cx, cy, P, P, 0, 0, P, P);
      const { lum } = lumaArray(c);
      patches.push(patchGrain(lum, P, P));
      for (let i = 0; i < lum.length; i += 11) lumSamples.push(lum[i]);
    }
  }
  // Grain from the flattest third of patches (smooth regions where grain shows).
  patches.sort((a, b) => a.meanGrad - b.meanGrad);
  const flat = patches.slice(0, Math.max(1, Math.round(patches.length / 3)));
  const grainRms = flat.reduce((s, p) => s + p.grainRms, 0) / flat.length;
  // Robust global contrast (2–98% of sampled luminance).
  lumSamples.sort((a, b) => a - b);
  const lo = lumSamples[Math.floor(lumSamples.length * 0.02)] ?? 0;
  const hi = lumSamples[Math.floor(lumSamples.length * 0.98)] ?? 255;
  const contrast = Math.max(1, hi - lo);
  return (grainRms / contrast) * 100;
}

// Estimate an image's effective resolution (real-detail long side in px) by
// probing realness from the native scale downward and finding where it crosses
// into "genuine detail" territory, and measure its grain on the same top grid.
function analyzeDetail(src: CompareSource): { effectiveLong: number; noise: number } {
  const nw = (src as HTMLImageElement).naturalWidth || src.width;
  const nh = (src as HTMLImageElement).naturalHeight || src.height;
  const nativeLong = Math.max(nw, nh);
  const ar = nh / nw;
  const startL = Math.min(nativeLong, EFFRES_CAP);
  const top = downscaleClean(src, Math.round(startL), Math.max(2, Math.round(startL * ar)));
  const noise = measureNoise(src);

  const scales: number[] = [];
  for (let s = startL; s >= 64; s /= 1.5) scales.push(Math.round(s));
  if (scales.length === 0) scales.push(Math.round(startL)); // tiny image: probe at least native

  let prevL: number | null = null;
  let prevR = 0;
  let effectiveLong = scales[scales.length - 1]; // never crisp → very low effective resolution
  for (const sL of scales) {
    const w = sL;
    const h = Math.max(2, Math.round(sL * ar));
    const g = w === top.width ? top : downscaleClean(top, w, h);
    const r = roundtripRealness(g);
    if (r >= REALNESS_T) {
      // Crisp already at the largest probed scale: if we capped below the native
      // size, trust the native pixels as real; otherwise this scale is the answer.
      if (prevL === null) effectiveLong = nativeLong > startL ? nativeLong : sL;
      else {
        // Crossed the threshold between prevL (soft) and sL (crisp) — interpolate.
        const t = (REALNESS_T - prevR) / (r - prevR);
        effectiveLong = Math.round(prevL + (sL - prevL) * t);
      }
      break;
    }
    prevL = sL;
    prevR = r;
  }
  return { effectiveLong, noise };
}

export type CompareSource = HTMLImageElement | HTMLCanvasElement | ImageBitmap;

export function compareResolution(imgA: CompareSource, imgB: CompareSource): CompareResult {
  const aw = (imgA as HTMLImageElement).naturalWidth || imgA.width;
  const ah = (imgA as HTMLImageElement).naturalHeight || imgA.height;
  const bw = (imgB as HTMLImageElement).naturalWidth || imgB.width;
  const bh = (imgB as HTMLImageElement).naturalHeight || imgB.height;

  // Common grid = the larger image's shape, capped for speed. Both are resampled
  // to it, so the comparison is on identical pixels.
  const larger = aw * ah >= bw * bh ? { w: aw, h: ah } : { w: bw, h: bh };
  const longest = Math.max(larger.w, larger.h);
  const s = Math.min(1, MAX_ANALYSIS_LONG / longest);
  const commonW = Math.max(2, Math.round(larger.w * s));
  const commonH = Math.max(2, Math.round(larger.h * s));

  const normA = drawTo(imgA, commonW, commonH);
  const normB = drawTo(imgB, commonW, commonH);

  const la = lumaArray(normA);
  const lb = lumaArray(normB);
  const sa = analyze(la.lum, commonW, commonH, aw, ah);
  const sb = analyze(lb.lum, commonW, commonH, bw, bh);

  // Per-image axes: real-detail long side + grain. No single winner — the UI
  // reports detail, cleanliness and pixel size separately (see CompareResult).
  const da = analyzeDetail(imgA);
  const db = analyzeDetail(imgB);

  // |A−B| luminance heatmap at the common grid.
  const diff = document.createElement("canvas");
  diff.width = commonW;
  diff.height = commonH;
  const dctx = diff.getContext("2d")!;
  const out = dctx.createImageData(commonW, commonH);
  for (let i = 0; i < la.lum.length; i++) {
    const v = Math.min(255, Math.abs(la.lum[i] - lb.lum[i]) * 3);
    const pi = i * 4;
    out.data[pi] = v;          // red-ish heat
    out.data[pi + 1] = Math.round(v * 0.4);
    out.data[pi + 2] = Math.round(v * 0.15);
    out.data[pi + 3] = 255;
  }
  dctx.putImageData(out, 0, 0);

  return {
    a: { ...sa, effectivePx: da.effectiveLong, noise: da.noise },
    b: { ...sb, effectivePx: db.effectiveLong, noise: db.noise },
    commonW, commonH,
    diff, normA, normB,
  };
}

// Decode a File into an HTMLImageElement. Uses a data URL (not an object URL) so
// `img.src` stays valid for reuse as a preview <img> — an object URL revoked after
// decode would leave the preview broken.
export function loadImageFile(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = reader.result as string;
    };
    reader.readAsDataURL(file);
  });
}
