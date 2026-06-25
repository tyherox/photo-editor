"use client";

import { useState } from "react";
import { useEscapeKey } from "@/lib/useEscapeKey";

interface Props {
  // The fully-assembled instruction the model would receive.
  initialPrompt: string;
  // Confirm sends the (possibly edited) text verbatim; cancel aborts the edit.
  onConfirm: (finalPrompt: string) => void;
  onCancel: () => void;
}

// Advanced "review before send": shows the exact instruction text the model will
// receive — including seam/region guidance and the reference-image disambiguation
// wording — and lets the user edit it. Nothing is sent without passing through
// here when Advanced is on.
export default function PromptPreviewModal({ initialPrompt, onConfirm, onCancel }: Props) {
  const [text, setText] = useState(initialPrompt);
  useEscapeKey(onCancel);

  const dirty = text !== initialPrompt;

  return (
    <div
      className="animate-overlay fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onCancel}
    >
      <div
        className="animate-dialog flex w-full max-w-xl flex-col gap-3 rounded-xl border border-zinc-700 bg-zinc-900 p-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium text-white">Final prompt</h3>
          <span className="text-xs text-zinc-500">
            Exactly what the model receives{dirty ? " · edited" : ""}
          </span>
        </div>
        <p className="text-xs text-zinc-400">
          This is the full instruction the app assembled, including blending and
          reference-image guidance. Edit it if you want — your text is sent verbatim.
        </p>
        <textarea
          autoFocus
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            // ⌘/Ctrl+Enter sends; plain Enter stays a newline (it's a textarea).
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && text.trim()) {
              e.preventDefault();
              onConfirm(text);
            }
          }}
          rows={7}
          className="w-full resize-y rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm leading-relaxed text-white focus:border-blue-500 focus:outline-none"
        />
        <div className="flex items-center justify-end gap-2">
          {dirty && (
            <button
              onClick={() => setText(initialPrompt)}
              className="mr-auto rounded-lg px-3 py-2 text-xs text-zinc-400 transition-colors hover:text-white"
            >
              Reset to default
            </button>
          )}
          <button
            onClick={onCancel}
            className="rounded-lg px-4 py-2 text-sm text-zinc-400 transition-colors hover:text-white"
          >
            Cancel
          </button>
          <button
            onClick={() => onConfirm(text)}
            disabled={!text.trim()}
            className="rounded-lg bg-purple-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-purple-500 disabled:opacity-40"
          >
            Send
          </button>
        </div>
      </div>
    </div>
  );
}
