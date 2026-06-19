let ort: typeof import("onnxruntime-web") | null = null;

const MODEL_URL =
  "https://huggingface.co/lxfater/inpaint-web/resolve/main/migan.onnx";
const MODEL_INPUT_SIZE = 512;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let session: any = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let loadingPromise: Promise<any> | null = null;

export type LoadProgress = {
  status: "downloading" | "initializing" | "ready" | "error";
  progress?: number;
};

async function getOrt() {
  if (ort) return ort;
  ort = await import("onnxruntime-web");
  ort.env.wasm.wasmPaths = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ort.env.versions.web}/dist/`;
  return ort;
}

export async function loadModel(
  onProgress?: (p: LoadProgress) => void
) {
  if (session) return session;
  if (loadingPromise) return loadingPromise;

  loadingPromise = (async () => {
    try {
      const ortModule = await getOrt();

      onProgress?.({ status: "downloading", progress: 0 });

      const response = await fetch(MODEL_URL);
      if (!response.ok) throw new Error(`Failed to download model: ${response.status}`);

      const contentLength = Number(response.headers.get("content-length") || 0);
      const reader = response.body!.getReader();
      const chunks: Uint8Array[] = [];
      let received = 0;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        received += value.length;
        if (contentLength > 0) {
          onProgress?.({ status: "downloading", progress: received / contentLength });
        }
      }

      const modelBuffer = new Uint8Array(received);
      let offset = 0;
      for (const chunk of chunks) {
        modelBuffer.set(chunk, offset);
        offset += chunk.length;
      }

      onProgress?.({ status: "initializing" });

      const opts: Parameters<typeof ortModule.InferenceSession.create>[1] = {
        executionProviders: ["wasm"],
      };

      session = await ortModule.InferenceSession.create(modelBuffer.buffer, opts);
      onProgress?.({ status: "ready" });
      return session;
    } catch (err) {
      loadingPromise = null;
      onProgress?.({ status: "error" });
      throw err;
    }
  })();

  return loadingPromise;
}

export function isModelLoaded(): boolean {
  return session !== null;
}

export async function inpaint(
  imageCanvas: HTMLCanvasElement,
  maskCanvas: HTMLCanvasElement,
  onProgress?: (p: LoadProgress) => void
): Promise<HTMLCanvasElement> {
  const ortModule = await getOrt();
  const sess = await loadModel(onProgress);
  if (!sess) throw new Error("Failed to load model");

  const inputSize = MODEL_INPUT_SIZE;

  const resizedImage = resizeCanvas(imageCanvas, inputSize, inputSize);
  const resizedMask = resizeCanvas(maskCanvas, inputSize, inputSize);

  const imageData = resizedImage
    .getContext("2d")!
    .getImageData(0, 0, inputSize, inputSize);
  const maskData = resizedMask
    .getContext("2d")!
    .getImageData(0, 0, inputSize, inputSize);

  const feeds: Record<string, InstanceType<typeof ortModule.Tensor>> = {};
  const inputNames: string[] = sess.inputNames;

  // MI-GAN exposes a SINGLE input (named "input") of shape [1, 4, H, W]: a
  // concatenation of [0.5 - mask, image * (1 - mask)] in NCHW order, with the
  // image normalized to [-1, 1]. Older exports instead take the image and mask
  // as two separate tensors — keep that as a fallback.
  const singleInput = inputNames.length < 2;

  if (singleInput) {
    const channels = inputChannelCount(sess, inputNames[0]);
    feeds[inputNames[0]] = buildMiganInput(
      ortModule,
      imageData,
      maskData,
      inputSize,
      channels
    );
  } else {
    feeds[inputNames[0]] = imageToTensor(ortModule, imageData, inputSize);
    feeds[inputNames[1]] = maskToTensor(ortModule, maskData, inputSize);
  }

  const results = await sess.run(feeds);
  const output = results[sess.outputNames[0]];

  // The single-input MI-GAN generator emits pixels in [-1, 1]; the legacy
  // two-input model emits [0, 1].
  return tensorToCanvas(output, inputSize, singleInput ? "tanh" : "unit");
}

function resizeCanvas(
  canvas: HTMLCanvasElement,
  w: number,
  h: number
): HTMLCanvasElement {
  const out = document.createElement("canvas");
  out.width = w;
  out.height = h;
  out.getContext("2d")!.drawImage(canvas, 0, 0, w, h);
  return out;
}

// Read the channel count from the model's input metadata (e.g. 4 for the
// [1, 4, H, W] MI-GAN input), falling back to 4 when the shape is unavailable
// or symbolic.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function inputChannelCount(sess: any, name: string): number {
  const meta = sess.inputMetadata?.find?.(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (m: any) => m.name === name
  );
  const shape = meta?.shape;
  if (
    Array.isArray(shape) &&
    shape.length === 4 &&
    typeof shape[1] === "number" &&
    shape[1] > 0
  ) {
    return shape[1];
  }
  return 4;
}

// Build the single 4-channel tensor MI-GAN expects:
//   channel 0      = 0.5 - mask        (-0.5 inside the hole, +0.5 outside)
//   channels 1..3  = RGB in [-1, 1], zeroed inside the hole (image * (1 - mask))
// The mask comes from the paint layer's alpha: painted pixels are the hole.
function buildMiganInput(
  ortModule: typeof import("onnxruntime-web"),
  imageData: ImageData,
  maskData: ImageData,
  size: number,
  channels: number
) {
  const img = imageData.data;
  const msk = maskData.data;
  const pixelCount = size * size;
  const c = channels >= 4 ? channels : 4;
  const floats = new Float32Array(c * pixelCount);

  for (let i = 0; i < pixelCount; i++) {
    const pi = i * 4;
    const hole = msk[pi + 3] > 10 ? 1 : 0;
    const keep = 1 - hole;
    floats[i] = 0.5 - hole;
    floats[pixelCount + i] = ((img[pi] / 255) * 2 - 1) * keep;
    floats[2 * pixelCount + i] = ((img[pi + 1] / 255) * 2 - 1) * keep;
    floats[3 * pixelCount + i] = ((img[pi + 2] / 255) * 2 - 1) * keep;
  }

  return new ortModule.Tensor("float32", floats, [1, c, size, size]);
}

function imageToTensor(
  ortModule: typeof import("onnxruntime-web"),
  imageData: ImageData,
  size: number
) {
  const { data } = imageData;
  const floats = new Float32Array(3 * size * size);
  const pixelCount = size * size;

  for (let i = 0; i < pixelCount; i++) {
    const pi = i * 4;
    floats[i] = data[pi] / 255.0;
    floats[pixelCount + i] = data[pi + 1] / 255.0;
    floats[2 * pixelCount + i] = data[pi + 2] / 255.0;
  }

  return new ortModule.Tensor("float32", floats, [1, 3, size, size]);
}

function maskToTensor(
  ortModule: typeof import("onnxruntime-web"),
  maskData: ImageData,
  size: number
) {
  const { data } = maskData;
  const floats = new Float32Array(size * size);

  for (let i = 0; i < size * size; i++) {
    floats[i] = data[i * 4 + 3] > 10 ? 1.0 : 0.0;
  }

  return new ortModule.Tensor("float32", floats, [1, 1, size, size]);
}

function tensorToCanvas(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tensor: any,
  size: number,
  range: "unit" | "tanh" = "unit"
): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const imageData = ctx.createImageData(size, size);
  const output = tensor.data as Float32Array;
  const pixelCount = size * size;
  // "unit": [0, 1] -> [0, 255]; "tanh": [-1, 1] -> [0, 255].
  const toByte =
    range === "tanh"
      ? (v: number) => clamp(v * 127.5 + 127.5)
      : (v: number) => clamp(v * 255);

  for (let i = 0; i < pixelCount; i++) {
    const pi = i * 4;
    if (output.length >= pixelCount * 3) {
      imageData.data[pi] = toByte(output[i]);
      imageData.data[pi + 1] = toByte(output[pixelCount + i]);
      imageData.data[pi + 2] = toByte(output[2 * pixelCount + i]);
    } else {
      imageData.data[pi] = clamp(output[pi]);
      imageData.data[pi + 1] = clamp(output[pi + 1]);
      imageData.data[pi + 2] = clamp(output[pi + 2]);
    }
    imageData.data[pi + 3] = 255;
  }

  ctx.putImageData(imageData, 0, 0);
  return canvas;
}

function clamp(v: number): number {
  return Math.max(0, Math.min(255, Math.round(v)));
}
