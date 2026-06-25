"use client";

import { useState, useEffect } from "react";
import { MODELS, DEFAULT_MODEL, IMAGE_SIZES, modelSupportsImageSize, type ImageSize } from "@/lib/gemini";
import { useEscapeKey } from "@/lib/useEscapeKey";

export type InpaintBackend = "gemini" | "local";

interface Props {
  open: boolean;
  onClose: () => void;
}

export default function SettingsDialog({ open, onClose }: Props) {
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState<string>(DEFAULT_MODEL);
  const [imageSize, setImageSize] = useState<ImageSize>("1K");
  const [backend, setBackend] = useState<InpaintBackend>("gemini");
  const [keyError, setKeyError] = useState<string | null>(null);

  useEffect(() => {
    setApiKey(localStorage.getItem("gemini-api-key") || "");
    setModel(localStorage.getItem("gemini-model") || DEFAULT_MODEL);
    setImageSize((localStorage.getItem("gemini-image-size") as ImageSize) || "1K");
    setBackend(
      (localStorage.getItem("inpaint-backend") as InpaintBackend) || "gemini"
    );
    setKeyError(null);
  }, [open]);

  useEscapeKey(onClose);

  function save() {
    if (backend === "gemini") {
      const key = apiKey.trim();
      if (!key) {
        setKeyError("An API key is required to use the Gemini backend.");
        return;
      }
      if (key.length < 20 || /\s/.test(key)) {
        setKeyError("That doesn't look like a valid API key. Check for typos or extra spaces.");
        return;
      }
    }
    localStorage.setItem("gemini-api-key", apiKey.trim());
    localStorage.setItem("gemini-model", model);
    localStorage.setItem("gemini-image-size", imageSize);
    localStorage.setItem("inpaint-backend", backend);
    onClose();
  }

  if (!open) return null;

  return (
    <div className="animate-overlay fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm" onClick={onClose}>
      <div
        className="animate-dialog bg-zinc-900 border border-zinc-700 rounded-xl p-6 w-full max-w-md shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-lg font-semibold text-white mb-4">Settings</h2>

        <label className="block text-sm text-zinc-400 mb-1">Inpainting Backend</label>
        <div className="flex gap-2 mb-4">
          <button
            onClick={() => setBackend("gemini")}
            className={`flex-1 px-3 py-2 text-sm rounded-lg border transition-colors ${
              backend === "gemini"
                ? "bg-blue-600/20 border-blue-500 text-blue-400"
                : "bg-zinc-800 border-zinc-600 text-zinc-400 hover:border-zinc-500"
            }`}
          >
            <div className="font-medium">Gemini (Cloud)</div>
            <div className="text-xs mt-0.5 opacity-70">Generative fill, prompt-guided</div>
          </button>
          <button
            onClick={() => setBackend("local")}
            className={`flex-1 px-3 py-2 text-sm rounded-lg border transition-colors ${
              backend === "local"
                ? "bg-green-600/20 border-green-500 text-green-400"
                : "bg-zinc-800 border-zinc-600 text-zinc-400 hover:border-zinc-500"
            }`}
          >
            <div className="font-medium">Local (Browser)</div>
            <div className="text-xs mt-0.5 opacity-70">Object removal, no API key</div>
          </button>
        </div>

        {backend === "gemini" && (
          <>
            <label className="block text-sm text-zinc-400 mb-1">Gemini API Key</label>
            <input
              type="password"
              value={apiKey}
              onChange={(e) => {
                setApiKey(e.target.value);
                if (keyError) setKeyError(null);
              }}
              placeholder="Enter your Gemini API key"
              className={`w-full px-3 py-2 bg-zinc-800 border rounded-lg text-white text-sm focus:outline-none ${
                keyError ? "border-red-500 mb-1" : "border-zinc-600 mb-4 focus:border-blue-500"
              }`}
            />
            {keyError && <p className="text-xs text-red-400 mb-4">{keyError}</p>}

            <label className="block text-sm text-zinc-400 mb-1">Model</label>
            <select
              value={model}
              onChange={(e) => setModel(e.target.value)}
              className="w-full px-3 py-2 bg-zinc-800 border border-zinc-600 rounded-lg text-white text-sm mb-4 focus:outline-none focus:border-blue-500"
            >
              {MODELS.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name} — {m.description}
                </option>
              ))}
            </select>

            <label className="block text-sm text-zinc-400 mb-1">Output resolution</label>
            <select
              value={imageSize}
              onChange={(e) => setImageSize(e.target.value as ImageSize)}
              disabled={!modelSupportsImageSize(model)}
              className="w-full px-3 py-2 bg-zinc-800 border border-zinc-600 rounded-lg text-white text-sm mb-1 focus:outline-none focus:border-blue-500 disabled:opacity-50"
            >
              {IMAGE_SIZES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
            <p className="text-xs text-zinc-500 mb-6">
              {modelSupportsImageSize(model)
                ? "Higher resolutions are sharper but slower and cost more per image."
                : "Only Gemini 3.x models support resolution selection; this model always outputs ~1K."}
            </p>
          </>
        )}

        {backend === "local" && (
          <div className="mb-6 px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg">
            <p className="text-sm text-zinc-300">MI-GAN model runs entirely in your browser via WebGPU/WASM.</p>
            <p className="text-xs text-zinc-500 mt-1">~80MB download on first use. Best for object removal (no prompt needed).</p>
          </div>
        )}

        <div className="flex gap-3 justify-end">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm text-zinc-400 hover:text-white transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={save}
            className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-500 transition-colors"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
