// Shared rules for importing image files (drag-drop or file picker), so the
// start screen, the upload box, and the editor-wide drop target all agree on
// what's accepted and how big is too big.

export const MAX_IMAGE_MB = 250;
export const ACCEPTED_IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp"];

// Returns an error message if the file can't be imported, or null if it's fine.
export function validateImageFile(file: File): string | null {
  if (!ACCEPTED_IMAGE_TYPES.includes(file.type)) {
    return "Unsupported file type. Please use PNG, JPG, or WebP.";
  }
  if (file.size > MAX_IMAGE_MB * 1024 * 1024) {
    const mb = (file.size / (1024 * 1024)).toFixed(1);
    return `Image is ${mb} MB — the limit is ${MAX_IMAGE_MB} MB. Try a smaller file.`;
  }
  return null;
}

// Whether a drag carries OS files (vs. an internal drag like a layer reorder).
export function dragHasFiles(dt: DataTransfer | null): boolean {
  return Boolean(dt && Array.from(dt.types).includes("Files"));
}

// Pull image files out of a drop, ignoring anything that isn't an image so a
// stray text/URL drag doesn't try to open a tab.
export function imageFilesFromDataTransfer(dt: DataTransfer): File[] {
  return Array.from(dt.files).filter((f) => f.type.startsWith("image/"));
}
