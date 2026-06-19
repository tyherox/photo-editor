export function imageToBase64(canvas: HTMLCanvasElement, mimeType = "image/png"): string {
  const dataUrl = canvas.toDataURL(mimeType);
  return dataUrl.split(",")[1];
}

export function maskCanvasToBlackWhite(maskCanvas: HTMLCanvasElement): HTMLCanvasElement {
  const w = maskCanvas.width;
  const h = maskCanvas.height;
  const out = document.createElement("canvas");
  out.width = w;
  out.height = h;
  const ctx = out.getContext("2d")!;
  const maskCtx = maskCanvas.getContext("2d")!;
  const maskData = maskCtx.getImageData(0, 0, w, h);
  const outData = ctx.createImageData(w, h);

  for (let i = 0; i < maskData.data.length; i += 4) {
    const alpha = maskData.data[i + 3];
    const val = alpha > 10 ? 255 : 0;
    outData.data[i] = val;
    outData.data[i + 1] = val;
    outData.data[i + 2] = val;
    outData.data[i + 3] = 255;
  }

  ctx.putImageData(outData, 0, 0);
  return out;
}

export function hasMaskContent(maskCanvas: HTMLCanvasElement): boolean {
  const ctx = maskCanvas.getContext("2d")!;
  const data = ctx.getImageData(0, 0, maskCanvas.width, maskCanvas.height).data;
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] > 10) return true;
  }
  return false;
}

export function loadImageToCanvas(
  file: File
): Promise<{ img: HTMLImageElement; width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => resolve({ img, width: img.width, height: img.height });
      img.onerror = reject;
      img.src = e.target!.result as string;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

export function base64ToImage(base64: string, mimeType = "image/png"): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = `data:${mimeType};base64,${base64}`;
  });
}

export function resizeIfNeeded(
  width: number,
  height: number,
  maxDim: number
): { width: number; height: number; scale: number } {
  if (width <= maxDim && height <= maxDim) return { width, height, scale: 1 };
  const scale = maxDim / Math.max(width, height);
  return {
    width: Math.round(width * scale),
    height: Math.round(height * scale),
    scale,
  };
}
