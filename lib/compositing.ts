export function compositeWithMask(
  originalCanvas: HTMLCanvasElement,
  aiResultCanvas: HTMLCanvasElement,
  maskCanvas: HTMLCanvasElement,
  featherRadius = 3
): HTMLCanvasElement {
  const w = originalCanvas.width;
  const h = originalCanvas.height;

  const out = document.createElement("canvas");
  out.width = w;
  out.height = h;
  const outCtx = out.getContext("2d")!;

  const origData = originalCanvas.getContext("2d")!.getImageData(0, 0, w, h);
  const aiData = aiResultCanvas.getContext("2d")!.getImageData(0, 0, w, h);
  const maskData = maskCanvas.getContext("2d")!.getImageData(0, 0, w, h);

  const alpha = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    alpha[i] = maskData.data[i * 4 + 3] / 255;
  }

  const blurred = featherRadius > 0 ? gaussianBlur(alpha, w, h, featherRadius) : alpha;

  const result = outCtx.createImageData(w, h);
  for (let i = 0; i < w * h; i++) {
    const a = blurred[i];
    const pi = i * 4;
    result.data[pi] = Math.round(origData.data[pi] * (1 - a) + aiData.data[pi] * a);
    result.data[pi + 1] = Math.round(origData.data[pi + 1] * (1 - a) + aiData.data[pi + 1] * a);
    result.data[pi + 2] = Math.round(origData.data[pi + 2] * (1 - a) + aiData.data[pi + 2] * a);
    result.data[pi + 3] = 255;
  }

  outCtx.putImageData(result, 0, 0);
  return out;
}

function gaussianBlur(
  input: Float32Array,
  w: number,
  h: number,
  radius: number
): Float32Array {
  const size = radius * 2 + 1;
  const kernel = new Float32Array(size);
  const sigma = radius / 2;
  let sum = 0;
  for (let i = 0; i < size; i++) {
    const x = i - radius;
    kernel[i] = Math.exp(-(x * x) / (2 * sigma * sigma));
    sum += kernel[i];
  }
  for (let i = 0; i < size; i++) kernel[i] /= sum;

  const temp = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let val = 0;
      for (let k = 0; k < size; k++) {
        const sx = Math.min(w - 1, Math.max(0, x + k - radius));
        val += input[y * w + sx] * kernel[k];
      }
      temp[y * w + x] = val;
    }
  }

  const output = new Float32Array(w * h);
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      let val = 0;
      for (let k = 0; k < size; k++) {
        const sy = Math.min(h - 1, Math.max(0, y + k - radius));
        val += temp[sy * w + x] * kernel[k];
      }
      output[y * w + x] = val;
    }
  }

  return output;
}
