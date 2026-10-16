/**
 * Thread messages and the pure rules for replies (design.md D22): which text is
 * input and which is instruction, and which items a revision must include.
 */
import { z } from "zod";
import { type ProposalPayload, placeholderRefs } from "@/services/proposals/schema";
import { SOURCES } from ".";

const MessagePartSchema = z.object({
  /** typed: the user's own words (trusted). pasted: someone else's text (untrusted). */
  type: z.enum(["typed", "pasted"]),
  text: z.string(),
});
export type MessagePart = z.infer<typeof MessagePartSchema>;

export const UserContentSchema = z.object({
  parts: z.array(MessagePartSchema),
  /** Where pasted text came from. */
  source: z.enum(SOURCES).optional(),
  /** The question proposal this message answers. */
  answers: z.string().nullable().optional(),
  /**
   * Set when a feature, not pasted input, started the thread (sprint planner,
   * rule suggestions). Such threads are reviewed and approved but not revised by
   * replying, because they have no input to classify again.
   */
  origin: z.enum(["planner", "rules"]).optional(),
  /**
   * Parts are laid out in order as written in the message box, so a paste can sit
   * inside a typed line (D56). Without it, parts are separate blocks: messages
   * stored before D56 and messages made by code.
   */
  inline: z.boolean().optional(),
  /**
   * Set when the chat wrote this message for the user (propose_actions). Its text
   * is the chat model's words and may carry numbers from Jira or Confluence, so it
   * is not the user's own words (D55): its numbers need a points cue.
   */
  author: z.enum(["chat"]).optional(),
});
export type UserContent = z.infer<typeof UserContentSchema>;

export const AssistantContentSchema = z.object({
  summary: z.string().nullable(),
});

const joined = (parts: readonly MessagePart[], type: MessagePart["type"], sep: string) =>
  parts
    .filter((p) => p.type === type)
    .map((p) => p.text.trim())
    .filter(Boolean)
    .join(sep);

/** Adjacent parts of the same type joined into one; empty parts dropped. */
export function mergeParts(parts: readonly MessagePart[]): MessagePart[] {
  const out: MessagePart[] = [];
  for (const p of parts) {
    if (!p.text) continue;
    const last = out.at(-1);
    if (last?.type === p.type) last.text += p.text;
    else out.push({ type: p.type, text: p.text });
  }
  return out;
}

/** « and » mark pasted values in an instruction (D56), so the user's own become plain quotes. */
export const plainQuotes = (text: string) => text.replace(/[«»]/g, '"');

/** Line breaks of every kind, including ones a browser does not show as "\n". */
const BREAKS = /\r\n|[\n\r\v\f\u0085\u2028\u2029]/;

/**
 * Whether typed text shares a line with the pasted part at `k`: before it on its
 * line (`dir` -1) or after it (`dir` 1). The line can run through other
 * single-line pastes; only typed text counts.
 */
function typedOnLine(parts: readonly MessagePart[], k: number, dir: -1 | 1): boolean {
  let text = "";
  for (let i = k + dir; i >= 0 && i < parts.length; i += dir) {
    const part = parts[i];
    if (!part) break;
    const lines = part.text.split(BREAKS);
    if (part.type === "typed") text += (dir < 0 ? lines.at(-1) : lines[0]) ?? "";
    if (lines.length > 1) break;
  }
  return text.trim() !== "";
}

/**
 * An inline message (D56) split into its input and its instruction. A paste is
 * a value for the instruction only when it is one line and typed text shares
 * that line; it is written into the instruction in place as «...», its outer
 * spaces kept outside the markers, after the user's own « and » become plain
 * quotes so a marker cannot be forged. Every other paste is input: one on its
 * own line, and any paste of several lines, wherever it stands.
 */
export function splitInline(parts: readonly MessagePart[]) {
  const merged = mergeParts(parts);
  const inputs: string[] = [];
  const pieces: string[] = [""];
  const append = (text: string) => {
    pieces[pieces.length - 1] += text;
  };
  for (const [k, p] of merged.entries()) {
    const core = p.text.trim();
    if (p.type === "typed" || !core) append(plainQuotes(p.text));
    else if (!BREAKS.test(p.text) && (typedOnLine(merged, k, -1) || typedOnLine(merged, k, 1))) {
      const lead = p.text.slice(0, p.text.indexOf(core));
      const trail = p.text.slice(lead.length + core.length);
      append(`${lead}«${plainQuotes(core)}»${trail}`);
    } else {
      inputs.push(core);
      pieces.push("");
    }
  }
  return {
    input: inputs.join("\n\n"),
    instruction: pieces
      .map((x) => x.trim())
      .filter(Boolean)
      .join("\n"),
  };
}

/** Whether a message holds input to work on: pasted text, not a value inside a line when inline. */
export function hasInput(parts: readonly MessagePart[], inline = false): boolean {
  return inline ? splitInline(parts).input !== "" : joined(parts, "pasted", "") !== "";
}

/**
 * Splits a message: pasted text is the input and typed text instructs it. With
 * nothing pasted, typed text is the input when `typedIsInput` (a new thread),
 * and an instruction otherwise (a reply). In an `inline` message (D56) a
 * one-line paste inside a typed line stays in the instruction as «...». The
 * user's own « and » become plain quotes in either layout, so a marker in an
 * instruction is always code's.
 */
export function splitMessage(parts: readonly MessagePart[], typedIsInput: boolean, inline = false) {
  if (inline) {
    const { input, instruction } = splitInline(parts);
    if (input) return { input, instruction: instruction || null };
    return typedIsInput
      ? { input: instruction, instruction: null }
      : { input: "", instruction: instruction || null };
  }
  const pasted = joined(parts, "pasted", "\n\n");
  const typed = plainQuotes(joined(parts, "typed", "\n"));
  if (pasted) return { input: pasted, instruction: typed || null };
  return typedIsInput
    ? { input: typed, instruction: null }
    : { input: "", instruction: typed || null };
}

/** Parts for a message made from plain input and an optional instruction. */
export function partsOf(input: string, instruction: string | null, inputIsTyped: boolean) {
  const parts: MessagePart[] = [];
  if (input.trim()) parts.push({ type: inputIsTyped ? "typed" : "pasted", text: input });
  if (instruction?.trim()) parts.push({ type: "typed", text: instruction });
  return parts;
}

/**
 * Items to revise: the chosen ones plus every item linked to them through a `$new`,
 * `$person` or `$team` ref in their pending proposals, since refs are renumbered
 * when proposals are replaced.
 */
export function withLinkedItems(
  chosen: Iterable<number>,
  pendingByItem: ReadonlyMap<number, readonly ProposalPayload[]>,
): number[] {
  const refs = new Map<number, Set<string>>();
  for (const [item, payloads] of pendingByItem)
    refs.set(item, new Set(payloads.flatMap((p) => placeholderRefs(p, { includeOwn: true }))));
  const out = new Set(chosen);
  let grew = true;
  while (grew) {
    grew = false;
    for (const [item, own] of refs) {
      if (out.has(item)) continue;
      const linked = [...out].some((o) => [...(refs.get(o) ?? [])].some((r) => own.has(r)));
      if (linked) {
        out.add(item);
        grew = true;
      }
    }
  }
  return [...out].sort((a, b) => a - b);
}
