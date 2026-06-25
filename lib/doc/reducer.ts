import type { AiEditRecipe, Annotation, BlendMode, Doc, Layer, ShapeLayer, TextLayer, Transform } from "./types";

// Pure present-state transitions. No history, no DOM, no bitmaps — `LAYER_ADD`
// assumes the caller already put any referenced bitmap in the AssetCache, so the
// Doc stays JSON-serializable.
export type DocAction =
  | { type: "DOC_NEW"; doc: Doc }
  | { type: "DOC_RENAME"; name: string }
  | { type: "DOC_SET_BACKGROUND"; background: string }
  | { type: "LAYER_ADD"; layer: Layer; at?: number } // default: top (push)
  | { type: "LAYER_DELETE"; id: string }
  | { type: "LAYER_REORDER"; id: string; toIndex: number }
  | { type: "LAYER_RENAME"; id: string; name: string }
  | { type: "LAYER_SET_VISIBLE"; id: string; visible: boolean }
  | { type: "LAYER_SET_LOCKED"; id: string; locked: boolean }
  | { type: "LAYER_SET_OPACITY"; id: string; opacity: number }
  | { type: "LAYER_SET_BLEND"; id: string; blendMode: BlendMode }
  | { type: "LAYER_SET_TRANSFORM"; id: string; transform: Transform }
  | { type: "LAYER_PATCH_TEXT"; id: string; patch: Partial<TextLayer> }
  | { type: "LAYER_PATCH_SHAPE"; id: string; patch: Partial<ShapeLayer> }
  | { type: "LAYER_SPLIT"; id: string; newLayers: Layer[] } // replace one layer with its slices
  // Swap a raster layer's bitmap in place (keeps id/name/transform/opacity/order)
  // — used when a reprompt of an AI-edit layer is accepted.
  | { type: "LAYER_REPLACE_RASTER"; id: string; assetId: string; naturalWidth: number; naturalHeight: number; aiEdit?: AiEditRecipe }
  // Swap a raster layer's bitmap for a higher-resolution version while keeping its
  // on-canvas size: transform scale is divided by the resolution growth factor, so
  // the layer looks identical but has more pixels (sharper on zoom/export).
  | { type: "LAYER_UPSCALE_RASTER"; id: string; assetId: string; naturalWidth: number; naturalHeight: number }
  | { type: "LAYER_GROUP"; ids: string[]; groupId: string }
  | { type: "LAYER_UNGROUP"; groupId: string }
  | { type: "ANNOTATION_ADD"; annotation: Annotation }
  | { type: "ANNOTATION_UPDATE"; id: string; patch: Partial<Annotation> }
  | { type: "ANNOTATION_DELETE"; id: string }
  | { type: "ANNOTATION_CLEAR" };

function mapLayer(doc: Doc, id: string, fn: (l: Layer) => Layer): Doc {
  return { ...doc, layers: doc.layers.map((l) => (l.id === id ? fn(l) : l)) };
}

function moveItem<T>(arr: T[], from: number, to: number): T[] {
  const next = arr.slice();
  const [item] = next.splice(from, 1);
  next.splice(Math.max(0, Math.min(to, next.length)), 0, item);
  return next;
}

export function findLayer(doc: Doc, id: string): Layer | undefined {
  return doc.layers.find((l) => l.id === id);
}

export function docReducer(doc: Doc, action: DocAction): Doc {
  switch (action.type) {
    case "DOC_NEW":
      return action.doc;

    case "DOC_RENAME":
      return { ...doc, name: action.name };

    case "DOC_SET_BACKGROUND":
      return { ...doc, background: action.background };

    case "LAYER_ADD": {
      const at = action.at ?? doc.layers.length;
      const layers = doc.layers.slice();
      layers.splice(Math.max(0, Math.min(at, layers.length)), 0, action.layer);
      return { ...doc, layers };
    }

    case "LAYER_DELETE":
      return { ...doc, layers: doc.layers.filter((l) => l.id !== action.id) };

    case "LAYER_REORDER": {
      const from = doc.layers.findIndex((l) => l.id === action.id);
      if (from < 0) return doc;
      return { ...doc, layers: moveItem(doc.layers, from, action.toIndex) };
    }

    case "LAYER_RENAME":
      return mapLayer(doc, action.id, (l) => ({ ...l, name: action.name }));

    case "LAYER_SET_VISIBLE":
      return mapLayer(doc, action.id, (l) => ({ ...l, visible: action.visible }));

    case "LAYER_SET_LOCKED":
      return mapLayer(doc, action.id, (l) => ({ ...l, locked: action.locked }));

    case "LAYER_SET_OPACITY":
      return mapLayer(doc, action.id, (l) => ({ ...l, opacity: action.opacity }));

    case "LAYER_SET_BLEND":
      return mapLayer(doc, action.id, (l) => ({ ...l, blendMode: action.blendMode }));

    case "LAYER_SET_TRANSFORM":
      return mapLayer(doc, action.id, (l) => ({ ...l, transform: action.transform }));

    case "LAYER_PATCH_TEXT":
      return mapLayer(doc, action.id, (l) => (l.type === "text" ? { ...l, ...action.patch } : l));

    case "LAYER_PATCH_SHAPE":
      return mapLayer(doc, action.id, (l) => (l.type === "shape" ? { ...l, ...action.patch } : l));

    case "LAYER_SPLIT": {
      const idx = doc.layers.findIndex((l) => l.id === action.id);
      if (idx < 0) return doc;
      return { ...doc, layers: [...doc.layers.slice(0, idx), ...action.newLayers, ...doc.layers.slice(idx + 1)] };
    }

    case "LAYER_REPLACE_RASTER":
      return mapLayer(doc, action.id, (l) =>
        l.type === "raster"
          ? { ...l, assetId: action.assetId, naturalWidth: action.naturalWidth, naturalHeight: action.naturalHeight, aiEdit: action.aiEdit }
          : l
      );

    case "LAYER_UPSCALE_RASTER":
      return mapLayer(doc, action.id, (l) => {
        if (l.type !== "raster") return l;
        // Divide scale by the resolution growth so displayed size = natural*scale
        // stays constant (more pixels, same footprint).
        const fx = action.naturalWidth / l.naturalWidth;
        const fy = action.naturalHeight / l.naturalHeight;
        return {
          ...l,
          assetId: action.assetId,
          naturalWidth: action.naturalWidth,
          naturalHeight: action.naturalHeight,
          transform: { ...l.transform, scaleX: l.transform.scaleX / fx, scaleY: l.transform.scaleY / fy },
        };
      });

    case "LAYER_GROUP": {
      const ids = new Set(action.ids);
      return { ...doc, layers: doc.layers.map((l) => (ids.has(l.id) ? { ...l, groupId: action.groupId } : l)) };
    }

    case "LAYER_UNGROUP":
      return {
        ...doc,
        layers: doc.layers.map((l) => (l.groupId === action.groupId ? { ...l, groupId: undefined } : l)),
      };

    case "ANNOTATION_ADD":
      return { ...doc, annotations: [...doc.annotations, action.annotation] };

    case "ANNOTATION_UPDATE":
      return {
        ...doc,
        // patch only ever carries fields of the matching annotation variant.
        annotations: doc.annotations.map((a) => (a.id === action.id ? ({ ...a, ...action.patch } as Annotation) : a)),
      };

    case "ANNOTATION_DELETE":
      return { ...doc, annotations: doc.annotations.filter((a) => a.id !== action.id) };

    case "ANNOTATION_CLEAR":
      return { ...doc, annotations: [] };

    default:
      return doc;
  }
}
