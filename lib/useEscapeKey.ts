import { useEffect } from "react";

/**
 * Calls `onEscape` when the user presses Escape. Used by modal dialogs so they
 * dismiss with the keyboard the same way clicking the backdrop does.
 */
export function useEscapeKey(onEscape: () => void) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onEscape();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onEscape]);
}
