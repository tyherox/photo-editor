"use client";

import { useCallback, useRef, useState } from "react";

interface Props {
  onImageLoad: (file: File) => void;
  onError?: (message: string) => void;
}

const MAX_SIZE_MB = 250;
const ACCEPTED = ["image/png", "image/jpeg", "image/webp"];

export default function ImageUpload({ onImageLoad, onError }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);

  const validateAndLoad = useCallback(
    (file: File | undefined) => {
      if (!file) return;
      if (!ACCEPTED.includes(file.type)) {
        onError?.("Unsupported file type. Please use PNG, JPG, or WebP.");
        return;
      }
      if (file.size > MAX_SIZE_MB * 1024 * 1024) {
        const mb = (file.size / (1024 * 1024)).toFixed(1);
        onError?.(`Image is ${mb} MB — the limit is ${MAX_SIZE_MB} MB. Try a smaller file.`);
        return;
      }
      onImageLoad(file);
    },
    [onImageLoad, onError]
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      validateAndLoad(e.dataTransfer.files[0]);
    },
    [validateAndLoad]
  );

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      validateAndLoad(e.target.files?.[0]);
      e.target.value = "";
    },
    [validateAndLoad]
  );

  return (
    <div
      onDrop={handleDrop}
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onClick={() => inputRef.current?.click()}
      className={`flex flex-col items-center justify-center w-full h-full border-2 border-dashed rounded-xl cursor-pointer transition-colors ${
        dragOver
          ? "border-blue-500 bg-zinc-800/50"
          : "border-zinc-600 hover:border-blue-500 hover:bg-zinc-800/50"
      }`}
    >
      <svg className="w-12 h-12 text-zinc-500 mb-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 16V4m0 0l-4 4m4-4l4 4M4 20h16" />
      </svg>
      <p className="text-zinc-400 text-sm">Drop an image here or click to upload</p>
      <p className="text-zinc-600 text-xs mt-1">PNG, JPG, WebP · up to {MAX_SIZE_MB} MB</p>
      <input
        ref={inputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        onChange={handleChange}
        className="hidden"
      />
    </div>
  );
}
