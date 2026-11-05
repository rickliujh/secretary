/**
 * Images for a model call (D33, D71): how large an image may be, which types
 * a provider takes, and how an image is made fit to send. The chat's ticket
 * pictures and the note's images both go through `prepareImage`.
 */

/** Images above this are shrunk (when the webview can) or skipped. */
export const MAX_SEND_BYTES = 3.5 * 1024 * 1024;
/** The long side a sent image is shrunk to; the model would not use more detail. */
export const MAX_SIDE = 1568;

/** An image as a model call takes it (`ObjectRequest.images`). */
export type ModelImage = { mediaType: string; data: Uint8Array };

/** What `prepareImage` gives: the image to send, or why it cannot be sent. */
export type PreparedImage<T> = { image: T } | { reason: "too_large" | "unsupported" };

/** The types every provider takes. */
const SENDABLE = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;

/** The image type the bytes say, from their first bytes; null when none of the sendable ones. */
export function sniffImageType(data: Uint8Array): (typeof SENDABLE)[number] | null {
  const at = (i: number, bytes: number[]) => bytes.every((b, j) => data[i + j] === b);
  if (at(0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (at(0, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (at(0, [0x47, 0x49, 0x46, 0x38])) return "image/gif";
  if (at(0, [0x52, 0x49, 0x46, 0x46]) && at(8, [0x57, 0x45, 0x42, 0x50])) return "image/webp";
  return null;
}

type Drawable = { width: number; height: number; source: CanvasImageSource; close?: () => void };

/** Decodes with `createImageBitmap`, else an `<img>` over an object URL; null when neither exists. */
function decoder(): ((blob: Blob) => Promise<Drawable>) | null {
  if (typeof createImageBitmap === "function")
    return async (blob) => {
      const b = await createImageBitmap(blob);
      return { width: b.width, height: b.height, source: b, close: () => b.close?.() };
    };
  if (typeof Image === "function" && typeof URL?.createObjectURL === "function")
    return (blob) =>
      new Promise((resolve, reject) => {
        const url = URL.createObjectURL(blob);
        const img = new Image();
        img.onload = () =>
          resolve({
            width: img.naturalWidth,
            height: img.naturalHeight,
            source: img,
            close: () => URL.revokeObjectURL(url),
          });
        img.onerror = () => {
          URL.revokeObjectURL(url);
          reject(new Error("The image could not be decoded"));
        };
        img.src = url;
      });
  return null;
}

/** Draws to JPEG on an `OffscreenCanvas`, else a DOM `<canvas>`; null when neither exists. */
function encoder(): ((d: Drawable, w: number, h: number) => Promise<Blob>) | null {
  if (typeof OffscreenCanvas === "function")
    return async (d, w, h) => {
      const canvas = new OffscreenCanvas(w, h);
      canvas.getContext("2d")?.drawImage(d.source, 0, 0, w, h);
      return canvas.convertToBlob({ type: "image/jpeg", quality: 0.85 });
    };
  if (typeof document !== "undefined" && typeof document.createElement === "function")
    return (d, w, h) =>
      new Promise((resolve, reject) => {
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        canvas.getContext("2d")?.drawImage(d.source, 0, 0, w, h);
        canvas.toBlob(
          (blob) => (blob ? resolve(blob) : reject(new Error("The canvas gave no image"))),
          "image/jpeg",
          0.85,
        );
      });
  return null;
}

/**
 * Makes an image fit to send. Its type is taken from its bytes: a sendable
 * image labelled with another type (a JPEG named .png) is relabelled; any
 * other type (bmp) is re-encoded to JPEG. A large image is shrunk to JPEG
 * with the long side at most 1568 pixels. Decoding uses the webview
 * (`createImageBitmap` or `<img>`; `OffscreenCanvas` or `<canvas>`). Without
 * a decoder (tests) a sendable image under the size cap passes as it is; the
 * rest cannot be sent: `unsupported` or `too_large`.
 */
export async function prepareImage<T extends ModelImage>(img: T): Promise<PreparedImage<T>> {
  const sniffed = sniffImageType(img.data);
  const labelled = sniffed && sniffed !== img.mediaType ? { ...img, mediaType: sniffed } : img;
  const fits = labelled.data.byteLength <= MAX_SEND_BYTES;
  const asIs = (): PreparedImage<T> =>
    !sniffed ? { reason: "unsupported" } : fits ? { image: labelled } : { reason: "too_large" };
  const decode = decoder();
  const encode = encoder();
  if (!decode || !encode) return asIs();
  try {
    const d = await decode(new Blob([img.data as BlobPart], { type: labelled.mediaType }));
    try {
      const scale = Math.min(1, MAX_SIDE / Math.max(d.width, d.height));
      if (sniffed && scale === 1 && fits) return { image: labelled };
      const blob = await encode(d, Math.round(d.width * scale), Math.round(d.height * scale));
      const data = new Uint8Array(await blob.arrayBuffer());
      if (data.byteLength > MAX_SEND_BYTES) return { reason: "too_large" };
      return { image: { ...img, mediaType: "image/jpeg", data } };
    } finally {
      d.close?.();
    }
  } catch {
    return asIs();
  }
}
