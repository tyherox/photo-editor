export async function upscale(
  canvas: HTMLCanvasElement,
  targetWidth: number,
  targetHeight: number
): Promise<HTMLCanvasElement> {
  if (canvas.width >= targetWidth && canvas.height >= targetHeight) {
    return canvas;
  }

  // Two-pass upscale for better quality: first to 2x, then resize to target
  // This avoids the quality loss from a single large jump
  const needsTwoPass =
    targetWidth > canvas.width * 1.5 || targetHeight > canvas.height * 1.5;

  let src = canvas;

  if (needsTwoPass) {
    const midW = Math.min(targetWidth, canvas.width * 2);
    const midH = Math.min(targetHeight, canvas.height * 2);
    const mid = document.createElement("canvas");
    mid.width = midW;
    mid.height = midH;
    const midCtx = mid.getContext("2d")!;
    midCtx.imageSmoothingEnabled = true;
    midCtx.imageSmoothingQuality = "high";
    midCtx.drawImage(src, 0, 0, midW, midH);
    src = mid;
  }

  const out = document.createElement("canvas");
  out.width = targetWidth;
  out.height = targetHeight;
  const ctx = out.getContext("2d")!;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(src, 0, 0, targetWidth, targetHeight);

  // Sharpen lightly to counteract upscale softness
  sharpen(ctx, targetWidth, targetHeight, 0.3);

  return out;
}

function sharpen(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  amount: number
): void {
  const imageData = ctx.getImageData(0, 0, w, h);
  const { data } = imageData;
  const copy = new Uint8ClampedArray(data);

  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = (y * w + x) * 4;
      for (let c = 0; c < 3; c++) {
        const center = copy[i + c];
        const neighbors =
          copy[((y - 1) * w + x) * 4 + c] +
          copy[((y + 1) * w + x) * 4 + c] +
          copy[(y * w + x - 1) * 4 + c] +
          copy[(y * w + x + 1) * 4 + c];
        const laplacian = center * 4 - neighbors;
        data[i + c] = Math.max(0, Math.min(255, Math.round(center + laplacian * amount)));
      }
    }
  }

  ctx.putImageData(imageData, 0, 0);
}
