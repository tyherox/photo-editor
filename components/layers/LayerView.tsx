"use client";

import type { CSSProperties, PointerEvent as ReactPointerEvent } from "react";
import type { Layer } from "@/lib/doc/types";
import type { AssetCache } from "@/lib/doc/assetCache";
import { cssTransformFor } from "@/lib/doc/geometry";

// Renders ONE layer as a DOM node positioned by the layer's CSS transform.
// transform-origin is 0,0 so the on-screen affine matches renderDocToCanvas
// exactly. Selection happens on pointerdown; move/scale/rotate is the
// TransformBox's job (shown only for the selected layer).
export default function LayerView({
  layer,
  cache,
  onSelect,
}: {
  layer: Layer;
  cache: AssetCache;
  onSelect: (id: string, additive?: boolean) => void;
}) {
  if (!layer.visible) return null;

  const base: CSSProperties = {
    position: "absolute",
    left: 0,
    top: 0,
    transformOrigin: "0 0",
    transform: cssTransformFor(layer.transform),
    opacity: layer.opacity,
    mixBlendMode: layer.blendMode as CSSProperties["mixBlendMode"],
    pointerEvents: layer.locked ? "none" : "auto",
    cursor: "pointer",
    userSelect: "none",
  };

  const onPointerDown = (e: ReactPointerEvent) => {
    if (layer.locked) return;
    e.stopPropagation(); // don't let the Stage treat this as a deselect/pan
    onSelect(layer.id, e.shiftKey || e.metaKey || e.ctrlKey);
  };

  switch (layer.type) {
    case "raster": {
      const url = cache.url(layer.assetId);
      return (
        // A raster layer is a transformed data-URL bitmap on a canvas-style
        // stage; next/image cannot represent it. Raw <img> is intentional.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={url}
          alt={layer.name}
          draggable={false}
          onPointerDown={onPointerDown}
          // maxWidth/maxHeight "none" overrides Tailwind preflight's
          // `img { max-width: 100% }`, which would otherwise clamp a layer whose
          // natural size exceeds the doc box (e.g. a hi-res 2×/4× sharpen patch:
          // naturalWidth = bbox.w × scale) — clamping width but not height skews it.
          style={{ ...base, width: layer.naturalWidth, height: layer.naturalHeight, maxWidth: "none", maxHeight: "none", display: "block" }}
        />
      );
    }

    case "shape": {
      const { width, height, fill, stroke, strokeWidth, shape, radius } = layer;
      return (
        <svg
          width={width}
          height={height}
          viewBox={`0 0 ${width} ${height}`}
          onPointerDown={onPointerDown}
          style={{ ...base, overflow: "visible" }}
        >
          {shape === "rect" && (
            <rect
              x={0}
              y={0}
              width={width}
              height={height}
              rx={radius}
              ry={radius}
              fill={fill}
              stroke={stroke}
              strokeWidth={strokeWidth}
            />
          )}
          {shape === "ellipse" && (
            <ellipse
              cx={width / 2}
              cy={height / 2}
              rx={width / 2}
              ry={height / 2}
              fill={fill}
              stroke={stroke}
              strokeWidth={strokeWidth}
            />
          )}
          {shape === "line" && (
            <line x1={0} y1={0} x2={width} y2={height} stroke={stroke} strokeWidth={strokeWidth} strokeLinecap="round" />
          )}
        </svg>
      );
    }

    case "text":
      return (
        <div
          onPointerDown={onPointerDown}
          style={{
            ...base,
            width: layer.boxWidth,
            color: layer.color,
            fontFamily: layer.fontFamily,
            fontSize: layer.fontSize,
            fontWeight: layer.fontWeight,
            fontStyle: layer.italic ? "italic" : "normal",
            textDecoration: layer.underline ? "underline" : "none",
            lineHeight: layer.lineHeight,
            textAlign: layer.align,
            whiteSpace: "pre-wrap",
            wordBreak: "normal",
          }}
        >
          {layer.text}
        </div>
      );
  }
}
