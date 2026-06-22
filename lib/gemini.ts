export interface GeminiEditRequest {
  apiKey: string;
  model: string;
  prompt: string;
  image: string;
  mimeType: string;
  referenceImage?: string;
  referenceMimeType?: string;
  signal?: AbortSignal;
  // Context-aware region edit: `image` is the clean full scene, `contextHintImage`
  // is the same scene with the edit region outlined in magenta. The model is told
  // to change only that region; the caller composites just the masked pixels back,
  // so the rest of the image is left untouched.
  mode?: "context";
  contextHintImage?: string;
}

export interface GeminiEditResponse {
  image: string;
  mimeType: string;
  text?: string;
}

export async function editImage(req: GeminiEditRequest): Promise<GeminiEditResponse> {
  const { signal, ...payload } = req;
  const res = await fetch("/api/gemini/edit", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal,
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || `Gemini API error: ${res.status}`);
  }

  return res.json();
}

export const MODELS = [
  { id: "gemini-2.5-flash-image", name: "Nano Banana", description: "Fast & affordable" },
  { id: "gemini-3.1-flash-image", name: "Nano Banana 2", description: "4K, best balance" },
  { id: "gemini-3-pro-image", name: "Nano Banana Pro", description: "Highest quality" },
] as const;

export const DEFAULT_MODEL = MODELS[0].id;
