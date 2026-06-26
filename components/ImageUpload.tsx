"use client";

import { useCallback, useRef, useState } from "react";
import {
  MAX_IMAGE_MB,
  imageFilesFromDataTransfer,
  validateImageFile,
} from "@/lib/image-import";

interface Props {
  // Called once per dropped/selected batch with every valid image file. Single
  // and multi behave the same — single is just a batch of one.
  onImagesLoad: (files: File[]) => void;
  onError?: (message: string) => void;
}

export default function ImageUpload({ onImagesLoad, onError }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);

  const validateAndLoad = useCallback(
    (files: File[]) => {
      if (!files.length) return;
      const valid: File[] = [];
      for (const file of files) {
        const err = validateImageFile(file);
        if (err) onError?.(err);
        else valid.push(file);
      }
      if (valid.length) onImagesLoad(valid);
    },
    [onImagesLoad, onError]
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      validateAndLoad(imageFilesFromDataTransfer(e.dataTransfer));
    },
    [validateAndLoad]
  );

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      validateAndLoad(Array.from(e.target.files ?? []));
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
      <p className="text-zinc-400 text-sm">Drop images here or click to upload</p>
      <p className="text-zinc-600 text-xs mt-1">PNG, JPG, WebP · up to {MAX_IMAGE_MB} MB · multiple open in tabs</p>
      <input
        ref={inputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        multiple
        onChange={handleChange}
        className="hidden"
      />
    </div>
  );
}
