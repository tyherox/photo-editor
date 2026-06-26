// Save an image to disk, remembering where the user last saved.
//
// When the File System Access API is available (Chromium), we use a native save
// dialog with a stable picker `id`: the browser persists the last-used directory
// for that id across sessions and reopens there, so repeated downloads land in
// the same place the user chose. Other browsers fall back to a normal anchor
// download into the browser's own download folder.
//
// The picker is opened BEFORE the (async) blob is produced so the call still
// runs inside the click/keydown's transient user activation — awaiting a
// toBlob() first can expire the activation and make showSaveFilePicker throw.

const PICKER_ID = "photo-editor-export";

type SaveFilePicker = (opts: {
  suggestedName?: string;
  id?: string;
  startIn?: string | FileSystemHandle;
  types?: { description?: string; accept: Record<string, string[]> }[];
}) => Promise<FileSystemFileHandle>;

function getPicker(): SaveFilePicker | null {
  const p = (window as unknown as { showSaveFilePicker?: SaveFilePicker }).showSaveFilePicker;
  return typeof p === "function" ? p : null;
}

export function canvasToBlob(canvas: HTMLCanvasElement, mimeType: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Canvas export failed"))), mimeType, quality)
  );
}

// Save with location memory. `makeBlob` is deferred so it only runs once we know
// the user didn't cancel, and so the picker opens while the gesture is still live.
export async function saveImage(
  filename: string,
  mimeType: string,
  extension: string,
  makeBlob: () => Promise<Blob>
): Promise<void> {
  const picker = getPicker();
  if (picker) {
    try {
      const handle = await picker({
        suggestedName: filename,
        id: PICKER_ID,
        startIn: "downloads",
        types: [{ description: `${extension.toUpperCase()} image`, accept: { [mimeType]: [`.${extension}`] } }],
      });
      const blob = await makeBlob();
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      return;
    } catch (err) {
      // User dismissed the dialog — respect that, don't force a download.
      if (err instanceof DOMException && err.name === "AbortError") return;
      // Anything else (permission/security/unsupported in a sandbox) → fall back.
    }
  }
  const blob = await makeBlob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.download = filename;
  a.href = url;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
