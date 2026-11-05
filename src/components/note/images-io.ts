/**
 * The note editor's images through the app's services (D70): saved and loaded
 * with `NoteFile`, in the vault the daily note syncs with (`noteVault`), or in
 * the app's data folder without one. Kept apart from `images-extension.ts`
 * so the extension's tests need no runtime.
 */
import { Effect } from "effect";
import { toast } from "sonner";
import { describeError } from "@/app/errors";
import { run } from "@/app/runtime";
import { NoteFile } from "@/services/note";
import { imageLinks } from "@/services/note/images";
import { noteVault } from "@/services/note/sync";
import type { NoteImagesIO } from "./images-extension";

const vaultName = Effect.map(noteVault, (source) => source?.vault ?? null);

export const noteImagesIO: NoteImagesIO = {
  save: (data, ext) =>
    run(
      Effect.gen(function* () {
        const file = yield* NoteFile;
        const saved = yield* file.saveImage(yield* vaultName, data, ext);
        return saved.link;
      }),
    ),
  load: (target) =>
    run(
      Effect.gen(function* () {
        const file = yield* NoteFile;
        const image = yield* file.loadImage(yield* vaultName, target);
        return image ? `data:${image.mime};base64,${image.data}` : null;
      }),
    ),
  failed: (error) =>
    void toast.error("The image was not saved", { description: describeError(error).description }),
  notLinked: (link) =>
    void toast.warning(`Image saved as ${imageLinks(link)[0]?.name ?? link} but not linked`, {
      description: `The note changed before the link could be added. Paste this line to show it: ${link}`,
    }),
};
