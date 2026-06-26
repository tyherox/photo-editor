// Algorithmic text sharpener — local-contrast edge remap.
//
// Built for TEXT, which is locally two-tone: a foreground (ink) and a background,
// with anti-aliased pixels blending between them. For each pixel we find the local
// dark/light tones (windowed min/max), see where the pixel sits between them, and
// push it toward whichever end it's closer to via a SMOOTH sigmoid. That makes the
// transition steep (crisp) yet continuous (no stair-step), and because the result
// is bounded by the REAL neighbouring tones it can never overshoot into a bright/
// dark ring (halo) or crush a colored font to black.
//
// Color is preserved by changing BRIGHTNESS only: RGB is scaled by a luma ratio,
// so the R:G:B proportions — hue and saturation — are untouched. The model is
// LOCAL, so it adapts to color/lighting changes and never assumes one global font
// color. Pair with supersampling (sharpen at N×, average down) for smooth edges.
// Purely on-device; no model/LLM.

import type { BBox } from "./crop-inpaint-stitch";

export interface SharpenOptions {
  // Edge contrast strength (sigmoid gain). 1 = no change; ~3 default; higher =
  // crisper/harder. Mapped from the UI slider (slider value − 1).
  amount?: number;
  // Neighbourhood radius (px) for estimating the local dark/light tones — i.e. the
  // edge scale. ~2 suits typical text; raise for very blurry/large source.
  radius?: number;
  // Min local tone spread (0–255) to act on. Where the neighbourhood is nearly
  // flat (a glyph fill or open background) the pixel is left EXACTLY as is, so
  // solid areas never shift color and only true edges are touched.
  threshold?: number;
}

// Rec. 709 luma.
function luma(r: number, g: number, b: number): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

// Separable windowed min or max (erosion/dilation) over a (2r+1)² window, edges
// clamped — the local dark/light tone at each pixel.
function localExtreme(src: Float32Array, w: number, h: number, r: number, max: boolean): Float32Array {
  const pick = max ? Math.max : Math.min;
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let acc = src[row + x];
      for (let k = -r; k <= r; k++) acc = pick(acc, src[row + Math.min(w - 1, Math.max(0, x + k))]);
      tmp[row + x] = acc;
    }
  }
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      let acc = tmp[y * w + x];
      for (let k = -r; k <= r; k++) acc = pick(acc, tmp[Math.min(h - 1, Math.max(0, y + k)) * w + x]);
      out[y * w + x] = acc;
    }
  }
  return out;
}

// Sharpen the pixels of `canvas` inside `rect`, in place — brightness only (RGB
// scaled by a luma ratio, so hue/saturation are untouched), via a local-contrast
// sigmoid bounded by each pixel's real neighbouring tones (halo-free, crush-free,
// smooth). Reads/writes only that rect.
export function sharpenRegion(canvas: HTMLCanvasElement, rect: BBox, opts: SharpenOptions = {}): void {
  const gain = Math.max(1, opts.amount ?? 3);
  if (gain <= 1) return; // identity
  const threshold = opts.threshold ?? 3;

  const x = Math.max(0, Math.round(rect.x));
  const y = Math.max(0, Math.round(rect.y));
  const w = Math.min(canvas.width - x, Math.round(rect.w));
  const h = Math.min(canvas.height - y, Math.round(rect.h));
  if (w <= 0 || h <= 0) return;

  const ctx = canvas.getContext("2d")!;
  const img = ctx.getImageData(x, y, w, h);
  const data = img.data;
  const n = w * h;

  const lum = new Float32Array(n);
  const hist = new Float32Array(256);
  for (let i = 0; i < n; i++) {
    const p = i * 4;
    const L = luma(data[p], data[p + 1], data[p + 2]);
    lum[i] = L;
    hist[Math.max(0, Math.min(255, Math.round(L)))]++;
  }

  // Global tone span of the region (2nd–98th percentile = the ink↔paper contrast).
  // Used to tell a REAL glyph edge from background texture: paper grain, gradients
  // and JPEG noise have a local spread that's a small fraction of this, whereas an
  // ink edge spans most of it. Sharpening only the latter stops the texture from
  // being amplified into blotches/halos on real (scanned/photographed) backgrounds.
  let cum = 0;
  let gLo = 0;
  let gHi = 255;
  let gLoSet = false;
  for (let b = 0; b < 256; b++) {
    cum += hist[b];
    if (!gLoSet && cum >= 0.02 * n) {
      gLo = b;
      gLoSet = true;
    }
    if (cum >= 0.98 * n) {
      gHi = b;
      break;
    }
  }
  const contrast = gHi - gLo;
  // Only act where the local contrast is a meaningful fraction of the full ink↔paper
  // contrast — i.e. an actual edge, not grain.
  const edgeMin = Math.max(threshold, 0.33 * contrast);

  // Adaptive radius: size the neighbourhood to the actual edge softness so we reach
  // the real ink/paper tones whatever the text size or blur. Estimate the typical
  // edge width = contrast ÷ (mean gradient along strong edges); the window is half
  // of that. Crisp text → small window (≈2); large/soft text → wider. A caller may
  // pin `radius` to override. (Runs at the supersampled resolution, so the estimate
  // already accounts for oversampling.)
  let radius = opts.radius != null ? Math.max(1, Math.round(opts.radius)) : 2;
  if (opts.radius == null && contrast > 8) {
    let maxG = 0;
    const grad = new Float32Array(n);
    for (let yy = 1; yy < h - 1; yy++) {
      for (let xx = 1; xx < w - 1; xx++) {
        const i = yy * w + xx;
        const g = Math.max(Math.abs(lum[i + 1] - lum[i - 1]), Math.abs(lum[i + w] - lum[i - w])) / 2;
        grad[i] = g;
        if (g > maxG) maxG = g;
      }
    }
    const strong = 0.25 * maxG;
    let sum = 0;
    let cnt = 0;
    for (let i = 0; i < n; i++) {
      if (grad[i] > strong) {
        sum += grad[i];
        cnt++;
      }
    }
    if (cnt > 0 && sum > 0) {
      const edgeWidth = contrast / (sum / cnt);
      radius = Math.max(2, Math.min(24, Math.round(0.5 * edgeWidth)));
    }
  }

  const lmin = localExtreme(lum, w, h, radius, false);
  const lmax = localExtreme(lum, w, h, radius, true);

  for (let i = 0; i < n; i++) {
    const lo = lmin[i];
    const range = lmax[i] - lo;
    if (range < edgeMin) continue; // flat fill OR background texture → leave untouched

    // Where this pixel sits between the local dark and light tones…
    let t = (lum[i] - lo) / range;
    if (t < 0) t = 0;
    else if (t > 1) t = 1;
    // …steepened by a smooth symmetric sigmoid (gain>1). Maps 0→0, 1→1, 0.5→0.5
    // and is continuous everywhere, so edges sharpen without stair-stepping.
    const a = Math.pow(t, gain);
    const tp = a / (a + Math.pow(1 - t, gain));

    const targetL = lo + tp * range; // bounded to [lo, lmax] → never rings/crushes
    const L = lum[i];
    const p = i * 4;
    if (L > 1) {
      const scale = targetL / L; // brightness ratio → hue + saturation preserved
      const r = data[p] * scale;
      const g = data[p + 1] * scale;
      const b = data[p + 2] * scale;
      data[p] = r > 255 ? 255 : r;
      data[p + 1] = g > 255 ? 255 : g;
      data[p + 2] = b > 255 ? 255 : b;
    } else {
      // Near-black pixel: ratio undefined and the pixel is effectively hueless.
      const d = targetL - L;
      const r = data[p] + d;
      const g = data[p + 1] + d;
      const b = data[p + 2] + d;
      data[p] = r > 255 ? 255 : r < 0 ? 0 : r;
      data[p + 1] = g > 255 ? 255 : g < 0 ? 0 : g;
      data[p + 2] = b > 255 ? 255 : b < 0 ? 0 : b;
    }
  }

  ctx.putImageData(img, x, y);
}
