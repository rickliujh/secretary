import { describe, expect, test } from "bun:test";
import { MAX_DOWNLOAD_BYTES, pickImages, prepareImage } from "./images";

const img = (filename: string, p: Record<string, unknown> = {}) => ({
  filename,
  mimeType: "image/png",
  size: 1000,
  content: `https://jira.test/${filename}`,
  created: "2026-09-01T00:00:00Z",
  ...p,
});

describe("choosing ticket pictures", () => {
  test("embedded images first, then newest; never non-images or huge files; at most four", () => {
    const picked = pickImages(
      [
        img("old.png", { created: "2026-08-01T00:00:00Z" }),
        img("new.png", { created: "2026-09-20T00:00:00Z" }),
        img("in-comment.png", { created: "2026-07-01T00:00:00Z" }),
        img("sheet.xlsx", { mimeType: "application/vnd.ms-excel" }),
        img("huge.png", { size: MAX_DOWNLOAD_BYTES + 1 }),
        img("a.png"),
        img("b.png"),
      ],
      ["See !in-comment.png|thumbnail! for the totals."],
    );
    expect(picked.map((p) => p.filename)).toEqual(["in-comment.png", "new.png", "a.png", "b.png"]);
  });

  test("named files only, when asked", () => {
    expect(pickImages([img("x.png"), img("Y.PNG")], [], ["y.png"]).map((p) => p.filename)).toEqual([
      "Y.PNG",
    ]);
  });

  test("without the webview's image decoder, small images pass and large ones are skipped", async () => {
    const small = { filename: "s.png", mediaType: "image/png", data: new Uint8Array(10) };
    const large = {
      filename: "l.png",
      mediaType: "image/png",
      data: new Uint8Array(4 * 1024 * 1024),
    };
    expect(await prepareImage(small)).toBe(small);
    expect(await prepareImage(large)).toBeNull();
  });
});
