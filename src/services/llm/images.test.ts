import { afterEach, describe, expect, test } from "bun:test";
import { MAX_SEND_BYTES, prepareImage, sniffImageType } from "./images";

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG = [0xff, 0xd8, 0xff, 0xe0];
const BMP = [0x42, 0x4d, 0x36, 0x00];
const bytes = (head: number[], size = 16) => {
  const b = new Uint8Array(size);
  b.set(head);
  return b;
};

const g = globalThis as Record<string, unknown>;
const saved = {
  createImageBitmap: g.createImageBitmap,
  OffscreenCanvas: g.OffscreenCanvas,
  document: g.document,
};
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete g[k];
    else g[k] = v;
  }
});

/** A webview with `createImageBitmap` and only a DOM `<canvas>` (no OffscreenCanvas). */
function domCanvas(size: { width: number; height: number }) {
  const drawn: number[][] = [];
  delete g.OffscreenCanvas;
  g.createImageBitmap = async () => ({ ...size, close: () => undefined });
  g.document = {
    createElement: () => {
      const canvas = {
        width: 0,
        height: 0,
        getContext: () => ({
          drawImage: (_: unknown, _x: number, _y: number, w: number, h: number) =>
            drawn.push([w, h]),
        }),
        toBlob: (cb: (b: Blob) => void, type: string) =>
          cb(new Blob([new Uint8Array([...JPEG, 1, 2, 3])], { type })),
      };
      return canvas;
    },
  };
  return drawn;
}

describe("sniffImageType", () => {
  test("png, jpeg, gif, webp by their first bytes; anything else is none", () => {
    expect(sniffImageType(bytes(PNG))).toBe("image/png");
    expect(sniffImageType(bytes(JPEG))).toBe("image/jpeg");
    expect(sniffImageType(bytes([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]))).toBe("image/gif");
    expect(
      sniffImageType(bytes([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50])),
    ).toBe("image/webp");
    expect(sniffImageType(bytes(BMP))).toBeNull();
    expect(sniffImageType(new Uint8Array(10))).toBeNull();
  });
});

describe("prepareImage without a decoder (tests, D71)", () => {
  test("a small sendable image passes as it is; a large one is too large", async () => {
    const small = { filename: "s.png", mediaType: "image/png", data: bytes(PNG) };
    expect(await prepareImage(small)).toEqual({ image: small });
    const large = { mediaType: "image/png", data: bytes(PNG, 4 * 1024 * 1024) };
    expect(await prepareImage(large)).toEqual({ reason: "too_large" });
  });

  test("a JPEG named .png is sent as image/jpeg; a bmp is an unsupported type", async () => {
    const r = await prepareImage({ mediaType: "image/png", data: bytes(JPEG) });
    expect("image" in r && r.image.mediaType).toBe("image/jpeg");
    expect(await prepareImage({ mediaType: "image/bmp", data: bytes(BMP) })).toEqual({
      reason: "unsupported",
    });
  });
});

describe("prepareImage in a webview without OffscreenCanvas", () => {
  test("a bmp is re-encoded to JPEG on a DOM canvas", async () => {
    const drawn = domCanvas({ width: 800, height: 600 });
    const r = await prepareImage({ mediaType: "image/bmp", data: bytes(BMP) });
    expect("image" in r && r.image.mediaType).toBe("image/jpeg");
    expect(drawn).toEqual([[800, 600]]);
  });

  test("a 4 MB Retina screenshot is shrunk to 1568 px on the long side", async () => {
    const drawn = domCanvas({ width: 3136, height: 1960 });
    const big = { mediaType: "image/png", data: bytes(PNG, MAX_SEND_BYTES + 1) };
    const r = await prepareImage(big);
    expect("image" in r && r.image.mediaType).toBe("image/jpeg");
    expect(drawn).toEqual([[1568, 980]]);
  });

  test("a small sendable image is not re-encoded", async () => {
    const drawn = domCanvas({ width: 400, height: 300 });
    const small = { mediaType: "image/png", data: bytes(PNG) };
    expect(await prepareImage(small)).toEqual({ image: small });
    expect(drawn).toEqual([]);
  });
});
