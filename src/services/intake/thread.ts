/**
 * Thread messages and the pure rules for replies (design.md D22): which text is
 * input and which is instruction, and which items a revision must include.
 */
import { z } from "zod";
import { NEW_REF_RE, type ProposalPayload } from "@/services/proposals/schema";
import { SOURCES } from ".";

export const MessagePartSchema = z.object({
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
});
export type UserContent = z.infer<typeof UserContentSchema>;

export const AssistantContentSchema = z.object({
  summary: z.string().nullable(),
  error: z.string().nullable().optional(),
});
export type AssistantContent = z.infer<typeof AssistantContentSchema>;

const joined = (parts: readonly MessagePart[], type: MessagePart["type"], sep: string) =>
  parts
    .filter((p) => p.type === type)
    .map((p) => p.text.trim())
    .filter(Boolean)
    .join(sep);

/**
 * Splits a message: pasted text is the input and typed text instructs it. With
 * nothing pasted, typed text is the input when `typedIsInput` (a new thread),
 * and an instruction otherwise (a reply).
 */
export function splitMessage(parts: readonly MessagePart[], typedIsInput: boolean) {
  const pasted = joined(parts, "pasted", "\n\n");
  const typed = joined(parts, "typed", "\n");
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

/** `$new` refs a payload creates or points at. */
export function refsOf(p: ProposalPayload): string[] {
  const values: (string | null)[] = [];
  switch (p.kind) {
    case "create_issue":
      values.push(p.ref, p.parent, p.epic);
      break;
    case "update_issue":
    case "add_comment":
    case "transition_issue":
    case "link_dependency":
      values.push(p.target);
      break;
    case "draft_message":
      values.push(...p.issueKeys);
      break;
    default:
      break;
  }
  return values.filter((v): v is string => !!v && NEW_REF_RE.test(v));
}

/**
 * Items to revise: the chosen ones plus every item linked to them through a `$new`
 * ref in their pending proposals, since refs are renumbered when proposals are
 * replaced.
 */
export function withLinkedItems(
  chosen: Iterable<number>,
  pendingByItem: ReadonlyMap<number, readonly ProposalPayload[]>,
): number[] {
  const refs = new Map<number, Set<string>>();
  for (const [item, payloads] of pendingByItem) refs.set(item, new Set(payloads.flatMap(refsOf)));
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
