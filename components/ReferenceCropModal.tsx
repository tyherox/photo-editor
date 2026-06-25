"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { upscale } from "@/lib/local-upscale";
import { useEscapeKey } from "@/lib/useEscapeKey";

interface Props {
  imageDataUrl: string;
  onConfirm: (croppedBase64: string) => void;
  onCancel: () => void;
}

export default function ReferenceCropModal({ imageDataUrl, onConfirm, onCancel }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const [drawing, setDrawing] = useState(false);
  const [start, setStart] = useState<{ x: number; y: number } | null>(null);
  const [rect, setRect] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [scale, setScale] = useState(1);
  useEscapeKey(onCancel);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const img = imgRef.current;
    if (!canvas || !img) return;
    const ctx = canvas.getContext("2d")!;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

    if (rect) {
      ctx.fillStyle = "rgba(0, 0, 0, 0.5)";
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      ctx.clearRect(rect.x, rect.y, rect.w, rect.h);
      ctx.drawImage(
        img,
        rect.x / scale, rect.y / scale, rect.w / scale, rect.h / scale,
        rect.x, rect.y, rect.w, rect.h
      );

      ctx.strokeStyle = "#a855f7";
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 3]);
      ctx.strokeRect(rect.x, rect.y, rect.w, rect.h);
      ctx.setLineDash([]);
    }
  }, [rect, scale]);

  useEffect(() => {
    const img = new Image();
    img.onload = () => {
      imgRef.current = img;
      const maxW = Math.min(window.innerWidth - 96, 800);
      const maxH = Math.min(window.innerHeight - 200, 600);
      const s = Math.min(1, maxW / img.naturalWidth, maxH / img.naturalHeight);
      setScale(s);
      const canvas = canvasRef.current;
      if (canvas) {
        canvas.width = Math.round(img.naturalWidth * s);
        canvas.height = Math.round(img.naturalHeight * s);
      }
    };
    img.src = imageDataUrl;
  }, [imageDataUrl]);

  useEffect(() => {
    draw();
  }, [draw]);

  function getPos(e: React.MouseEvent) {
    const canvas = canvasRef.current!;
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  function handleMouseDown(e: React.MouseEvent) {
    const pos = getPos(e);
    setStart(pos);
    setRect(null);
    setDrawing(true);
  }

  function handleMouseMove(e: React.MouseEvent) {
    if (!drawing || !start) return;
    const pos = getPos(e);
    const x = Math.min(start.x, pos.x);
    const y = Math.min(start.y, pos.y);
    const w = Math.abs(pos.x - start.x);
    const h = Math.abs(pos.y - start.y);
    setRect({ x, y, w, h });
  }

  function handleMouseUp() {
    setDrawing(false);
  }

  async function handleConfirm() {
    const img = imgRef.current;
    if (!img || !rect || rect.w < 5 || rect.h < 5) {
      onConfirm(imageDataUrl.split(",")[1]);
      return;
    }

    const srcX = rect.x / scale;
    const srcY = rect.y / scale;
    const srcW = rect.w / scale;
    const srcH = rect.h / scale;

    const cropped = document.createElement("canvas");
    cropped.width = Math.round(srcW);
    cropped.height = Math.round(srcH);
    cropped.getContext("2d")!.drawImage(img, srcX, srcY, srcW, srcH, 0, 0, cropped.width, cropped.height);

    const minSize = 1024;
    const longest = Math.max(cropped.width, cropped.height);
    let result = cropped;
    if (longest < minSize) {
      const ratio = minSize / longest;
      result = await upscale(cropped, Math.round(cropped.width * ratio), Math.round(cropped.height * ratio));
    }

    const dataUrl = result.toDataURL("image/png");
    onConfirm(dataUrl.split(",")[1]);
  }

  return (
    <div
      className="animate-overlay fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
      onClick={onCancel}
    >
      <div
        className="animate-dialog bg-zinc-900 rounded-xl border border-zinc-700 p-4 flex flex-col gap-3 max-w-[90vw] max-h-[90vh]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium text-white">Crop reference image</h3>
          <span className="text-xs text-zinc-500">Drag to select a region, or confirm to use the full image</span>
        </div>

        <canvas
          ref={canvasRef}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseUp}
          className="rounded-lg cursor-crosshair"
        />

        <div className="flex justify-end gap-2">
          <button
            onClick={onCancel}
            className="px-4 py-2 text-sm text-zinc-400 hover:text-white transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={() => { setRect(null); }}
            disabled={!rect}
            className="px-4 py-2 text-sm text-zinc-400 hover:text-white transition-colors disabled:opacity-30"
          >
            Reset
          </button>
          <button
            onClick={handleConfirm}
            className="px-4 py-2 text-sm font-medium bg-purple-600 text-white rounded-lg hover:bg-purple-500 transition-colors"
          >
            {rect && rect.w > 5 ? "Use Selection" : "Use Full Image"}
          </button>
        </div>
      </div>
    </div>
  );
}
