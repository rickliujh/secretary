import { Context, Data, type Effect } from "effect";
import type { DbError } from "@/services/db";
import type { LlmError } from "@/services/llm";

export * from "./schema";

export class CommsError extends Data.TaggedError("CommsError")<{
  readonly kind: "not_found" | "sent";
  readonly message: string;
}> {}

export interface CommsShape {
  /**
   * Writes the short and standard variants for a draft (FR-6.1 to 6.3), from the
   * context code assembles. `instruction` asks for a change and is kept with the
   * draft so later regenerations remember it.
   */
  readonly generate: (
    id: string,
    opts?: { instruction?: string | null; today?: string },
  ) => Effect.Effect<void, CommsError | LlmError | DbError>;
}

export class Comms extends Context.Tag("Comms")<Comms, CommsShape>() {}
