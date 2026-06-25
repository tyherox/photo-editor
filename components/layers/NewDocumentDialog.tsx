"use client";

import { useRef, useState } from "react";
import { emptyDoc, type Doc } from "@/lib/doc/types";
import { useEscapeKey } from "@/lib/useEscapeKey";

const PRESETS: { label: string; w: number; h: number }[] = [
  { label: "Square 1080", w: 1080, h: 1080 },
  { label: "Landscape 1920×1080", w: 1920, h: 1080 },
  { label: "Portrait 1080×1920", w: 1080, h: 1920 },
  { label: "A4 @150dpi", w: 1240, h: 1754 },
];

export default function NewDocumentDialog({
  onCreate,
  onCreateFromImage,
  onCancel,
}: {
  onCreate: (doc: Doc) => void;
  onCreateFromImage?: (file: File) => void;
  onCancel?: () => void;
}) {
  const [width, setWidth] = useState(1080);
  const [height, setHeight] = useState(1080);
  const [transparent, setTransparent] = useState(false);
  const [bg, setBg] = useState("#ffffff");
  const fileRef = useRef<HTMLInputElement>(null);
  useEscapeKey(() => onCancel?.());

  const create = () => {
    const w = Math.max(1, Math.round(width));
    const h = Math.max(1, Math.round(height));
    onCreate(emptyDoc(w, h, transparent ? "transparent" : bg));
  };

  return (
    <div className="animate-overlay fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm" onClick={onCancel}>
      <div
        className="animate-dialog w-[26rem] max-w-full rounded-xl border border-zinc-700 bg-zinc-900 p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="mb-4 text-sm font-semibold text-white">New document</h2>

        <div className="mb-4 grid grid-cols-2 gap-2">
          {PRESETS.map((p) => (
            <button
              key={p.label}
              onClick={() => {
                setWidth(p.w);
                setHeight(p.h);
              }}
              className={`rounded-lg border px-3 py-2 text-left text-xs transition-colors ${
                width === p.w && height === p.h
                  ? "border-blue-500 bg-blue-500/10 text-white"
                  : "border-zinc-700 text-zinc-300 hover:border-zinc-600"
              }`}
            >
              <div className="font-medium">{p.label}</div>
              <div className="text-zinc-500">
                {p.w} × {p.h}
              </div>
            </button>
          ))}
        </div>

        <div className="mb-4 flex items-center gap-2 text-xs text-zinc-400">
          <label className="flex items-center gap-1">
            W
            <input
              type="number"
              min={1}
              value={width}
              onChange={(e) => setWidth(Number(e.target.value))}
              className="w-20 rounded bg-zinc-800 px-2 py-1 text-white"
            />
          </label>
          <label className="flex items-center gap-1">
            H
            <input
              type="number"
              min={1}
              value={height}
              onChange={(e) => setHeight(Number(e.target.value))}
              className="w-20 rounded bg-zinc-800 px-2 py-1 text-white"
            />
          </label>
        </div>

        <div className="mb-5 flex items-center gap-3 text-xs text-zinc-400">
          <label className="flex items-center gap-1">
            <input type="checkbox" checked={transparent} onChange={(e) => setTransparent(e.target.checked)} />
            Transparent
          </label>
          {!transparent && (
            <label className="flex items-center gap-1">
              Background
              <input type="color" value={bg} onChange={(e) => setBg(e.target.value)} className="h-7 w-7 rounded bg-transparent" />
            </label>
          )}
        </div>

        <div className="flex items-center justify-end gap-2">
          {onCreateFromImage && (
            <>
              <input
                ref={fileRef}
                type="file"
                accept="image/png,image/jpeg,image/webp"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) onCreateFromImage(f);
                  e.target.value = "";
                }}
              />
              <button
                onClick={() => fileRef.current?.click()}
                className="mr-auto rounded-lg border border-zinc-700 px-3 py-1.5 text-sm text-zinc-200 hover:border-zinc-600"
              >
                From image…
              </button>
            </>
          )}
          {onCancel && (
            <button onClick={onCancel} className="rounded-lg px-3 py-1.5 text-sm text-zinc-400 hover:text-white">
              Cancel
            </button>
          )}
          <button onClick={create} className="rounded-lg bg-blue-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-blue-500">
            Create
          </button>
        </div>
      </div>
    </div>
  );
}
