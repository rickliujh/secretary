/**
 * The note's images, read (FR-20.10, D71). A block that goes to a model has
 * each image link loaded through `NoteFile.loadImage` (never starting
 * Obsidian), hashed, and transcribed once by the `read_image` call; the
 * transcript is kept in `image_reads` by the file's sha-256, so the same file
 * is never sent twice. The block is then read as `blockForModel` gives it:
 * the user's words with each image as quoted, untrusted lines.
 *
 * An image that cannot be loaded now (Obsidian closed, the file missing) or
 * transcribed (a model error) makes its block wait: the block is not
 * recorded, so a later reading tries again. A failed transcription is kept by
 * the file's hash and sent again only by Read now, Ask, or six hours later,
 * so a work pass or a typing pause does not pay for it again. At most
 * `IMAGES_PER_BLOCK` images of a block are read (the others stay links) and
 * at most `IMAGES_PER_READING` new transcriptions are made per reading; a
 * block over that waits for the next.
 */
import { eq, sql } from "drizzle-orm";
import { Effect, Either } from "effect";
import { imageReads } from "@/db/schema";
import { base64ToBytes } from "@/lib/base64";
import { nowIso } from "@/lib/ids";
import { sha256Hex } from "@/lib/sha256";
import {
  buildImageReadPrompt,
  IMAGE_READ_PROMPT_VERSION,
  type ImageReadOutput,
  ImageReadSchema,
  validateImageRead,
} from "@/prompts/read-image";
import { query } from "@/services/db";
import { Llm, type LlmError } from "@/services/llm";
import { prepareImage } from "@/services/llm/images";
import { NoteFile } from ".";
import { blockForModel, blockImageLinks, type ImageLink, type ImageTranscript } from "./images";
import { noteVault } from "./sync";

/** Most images of one block that are read; the others stay links. */
export const IMAGES_PER_BLOCK = 4;
/** Most new transcriptions in one reading; blocks over it wait for the next. */
export const IMAGES_PER_READING = 8;

export type WaitReason =
  | "not_running"
  | "not_found"
  | "unavailable"
  | "too_large"
  | "unsupported"
  | "model"
  | "cap";

export type ImageOutcome =
  | {
      status: "read";
      link: ImageLink;
      transcript: ImageTranscript & { kind: string };
      /** Taken from `image_reads`, no model call. */
      cached: boolean;
    }
  | { status: "wait"; link: ImageLink; reason: WaitReason; message: string };

/**
 * One reading's (or one Ask's) allowance: new transcriptions left, and
 * whether a file whose transcription failed earlier may be sent again now
 * (Read now and Ask; otherwise only after `RETRY_FAILED_MS`).
 */
export type ImageBudget = { calls: number; retryFailed: boolean };
export const readingBudget = (retryFailed = false): ImageBudget => ({
  calls: IMAGES_PER_READING,
  retryFailed,
});

/** A failed transcription is sent again by a reading of its own after this long. */
export const RETRY_FAILED_MS = 6 * 60 * 60 * 1000;

/** The page's words for "1 waits: <reason>" when Obsidian is closed. */
export const NOT_RUNNING = "Obsidian is not running";
/** A provider that refuses images (D71); `read_image` may be routed to any model. */
export const NO_VISION =
  "the model for Read an image (Settings > Models) cannot read images; choose one that can";
export const OVER_CAP = "more images than one reading reads";

/**
 * A provider's refusal of image input, by its capability wording (D71). A
 * 400 that only mentions an image (a bad file) is not a model without vision.
 */
const refusesImages = (e: LlmError) =>
  e.kind === "provider" &&
  /does(?: not|n't) support (?:the )?images?|vision|modalit|image input|image_url/i.test(e.message);

/** The vault the note's images are in: the synced vault's name, or null (the app's folder). */
export const imageVault = Effect.map(noteVault, (s) => s?.vault ?? null);

const wait = (link: ImageLink, reason: WaitReason, message: string): ImageOutcome => ({
  status: "wait",
  link,
  reason,
  message,
});

/** Records a failed transcription by the file's hash, so readings do not send it again (D71). */
const recordFailure = (hash: string, name: string, message: string, model: string) =>
  query((d) =>
    d
      .insert(imageReads)
      .values({
        hash,
        name,
        kind: "",
        text: "",
        description: "",
        promptVersion: IMAGE_READ_PROMPT_VERSION,
        model,
        createdAt: nowIso(),
        error: message,
        attempts: 1,
        lastTriedAt: nowIso(),
      })
      .onConflictDoUpdate({
        target: imageReads.hash,
        set: {
          error: message,
          attempts: sql`${imageReads.attempts} + 1`,
          lastTriedAt: nowIso(),
        },
      }),
  );

/**
 * Each link's transcript, in order, from `image_reads` or a new `read_image`
 * call; stops at the first link that must wait (the rest are not tried). A
 * load that fails (Obsidian closed, the file missing) makes no call and is
 * tried at every reading; a transcription that failed is recorded and sent
 * again only when `budget.retryFailed` or six hours later.
 */
export const readImages = (
  vault: string | null,
  links: readonly ImageLink[],
  budget: ImageBudget,
  now: Date = new Date(),
) =>
  Effect.gen(function* () {
    const file = yield* NoteFile;
    const llm = yield* Llm;
    const out: ImageOutcome[] = [];
    for (const link of links) {
      const loaded = yield* Effect.either(file.loadImage(vault, link.target));
      if (Either.isLeft(loaded)) {
        const e = loaded.left;
        out.push(
          e.kind === "not_running"
            ? wait(link, "not_running", NOT_RUNNING)
            : wait(link, "unavailable", e.message),
        );
        break;
      }
      if (!loaded.right) {
        out.push(wait(link, "not_found", `image not found: ${link.name}`));
        break;
      }
      const bytes = base64ToBytes(loaded.right.data);
      const hash = yield* Effect.promise(() => sha256Hex(bytes));
      // Once per file: an older prompt version's transcript is kept (D71).
      const row = yield* query((d) =>
        d.select().from(imageReads).where(eq(imageReads.hash, hash)).get(),
      );
      if (row && row.error === null) {
        out.push({
          status: "read",
          link,
          transcript: { kind: row.kind, text: row.text, description: row.description },
          cached: true,
        });
        continue;
      }
      if (row?.error) {
        const tried = Date.parse(row.lastTriedAt ?? row.createdAt);
        if (!budget.retryFailed && now.getTime() - tried < RETRY_FAILED_MS) {
          out.push(wait(link, "model", row.error));
          break;
        }
      }
      if (budget.calls <= 0) {
        out.push(wait(link, "cap", OVER_CAP));
        break;
      }
      const prepared = yield* Effect.promise(() =>
        prepareImage({ mediaType: loaded.right?.mime ?? "image/png", data: bytes }),
      );
      if (!("image" in prepared)) {
        out.push(
          prepared.reason === "too_large"
            ? wait(link, "too_large", `${link.name} is too large to send`)
            : wait(link, "unsupported", `${link.name}: unsupported image type`),
        );
        break;
      }
      budget.calls--;
      const call = yield* Effect.either(
        llm.object<ImageReadOutput>("read_image", {
          schema: ImageReadSchema,
          ...buildImageReadPrompt({ name: link.name }),
          images: [prepared.image],
          validate: validateImageRead,
        }),
      );
      if (Either.isLeft(call)) {
        const e = call.left;
        const message = refusesImages(e)
          ? NO_VISION
          : `${link.name} could not be read (${e.message})`;
        // No model configured, or the call cancelled: nothing was paid for; try again next time.
        if (e.kind !== "config" && e.kind !== "cancelled")
          yield* recordFailure(
            hash,
            link.name,
            message,
            yield* llm.route("read_image").pipe(
              Effect.map((r) => r.resolved?.binding.model ?? ""),
              Effect.orElseSucceed(() => ""),
            ),
          );
        out.push(wait(link, "model", message));
        break;
      }
      const value = call.right.value;
      const transcript = {
        kind: value.kind,
        text: value.text.trim(),
        description: value.description.trim(),
      };
      const done = {
        ...transcript,
        name: link.name,
        promptVersion: IMAGE_READ_PROMPT_VERSION,
        model: call.right.model,
        error: null,
        lastTriedAt: nowIso(),
      };
      yield* query((d) =>
        d
          .insert(imageReads)
          .values({ hash, createdAt: nowIso(), ...done })
          .onConflictDoUpdate({ target: imageReads.hash, set: done }),
      );
      out.push({ status: "read", link, transcript, cached: false });
    }
    return out;
  });

/** Most characters of the triage's quote of one image; the classify call gets it whole. */
export const TRIAGE_IMAGE_CHARS = 1500;
/** Most characters of all of a block's quoted images in the triage. */
const TRIAGE_IMAGES_CHARS = 3000;

export type PreparedBlock =
  | {
      status: "ready";
      /** The block with its images quoted in full, for the conversation. */
      text: string;
      /** The same with each image's transcript clipped, for the triage. */
      triageText: string;
      images: number;
    }
  | { status: "wait"; reason: WaitReason; message: string };

/**
 * A block's text for the model (D71): unchanged without image links (nothing
 * is loaded); else its first `IMAGES_PER_BLOCK` distinct images read and put
 * in as quotes, or the reason the block waits.
 */
export const prepareBlock = (vault: string | null, text: string, budget: ImageBudget) =>
  Effect.gen(function* () {
    const seen = new Set<string>();
    const links = blockImageLinks(text).filter((l) => {
      if (seen.has(l.target)) return false;
      seen.add(l.target);
      return true;
    });
    if (!links.length)
      return { status: "ready", text, triageText: text, images: 0 } satisfies PreparedBlock;
    const outcomes = yield* readImages(vault, links.slice(0, IMAGES_PER_BLOCK), budget);
    const waiting = outcomes.find((o) => o.status === "wait");
    if (waiting?.status === "wait")
      return {
        status: "wait",
        reason: waiting.reason,
        message: waiting.message,
      } satisfies PreparedBlock;
    const reads = new Map<string, ImageTranscript>();
    for (const o of outcomes) if (o.status === "read") reads.set(o.link.target, o.transcript);
    // The triage's 4 000 characters stay mostly the user's words (`clipBlock`).
    const perImage = Math.min(TRIAGE_IMAGE_CHARS, Math.floor(TRIAGE_IMAGES_CHARS / reads.size));
    return {
      status: "ready",
      text: blockForModel(text, reads),
      triageText: blockForModel(text, reads, { quoteChars: perImage }),
      images: reads.size,
    } satisfies PreparedBlock;
  });
