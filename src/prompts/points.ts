/**
 * Story points in `classify_item` (D55): the model's `storyPoints` text and
 * `pointsSource`, parsed and checked in code. A number stated in the input is
 * used as stated; an estimate is only for a new ticket and only a value on the
 * scale code computed from the cache; an existing ticket is never re-estimated.
 */
import { MAX_STORY_POINTS } from "@/services/proposals/schema";

/** Where proposed points come from; "(none)" is the portable schema's empty choice (D21). */
export const POINT_SOURCES = ["stated", "estimated"] as const;
export type PointSource = (typeof POINT_SOURCES)[number];

/** The sources the model may pick: an estimate only with a scale to pick from. */
export const pointSources = (scale: readonly number[]): readonly PointSource[] =>
  scale.length ? POINT_SOURCES : ["stated"];

/**
 * The model's `storyPoints` text as a number: "3", "0.5", "5 points". Null when
 * empty; "invalid" when it is not a number of points.
 */
export function parsePoints(v: unknown): number | null | "invalid" {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : "invalid";
  if (typeof v !== "string") return "invalid";
  const t = v.trim();
  if (!t) return null;
  const m = /^(\d+(?:[.,]\d+)?)\s*(?:story\s*)?(?:points?|pts?|sp)?$/i.exec(t);
  return m?.[1] ? Number(m[1].replace(",", ".")) : "invalid";
}

const WORDS: Record<string, number> = {
  zero: 0,
  half: 0.5,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
  twenty: 20,
};

const NUM = String.raw`(?:\d+(?:\.\d+)?|${Object.keys(WORDS).join("|")})`;
/** "3", "3, 5 or 8", "5-8", "3/5": a comma between digits separates, it is no decimal point. */
const LIST = String.raw`${NUM}(?:\s*(?:,|/|-|–|\bor\b|\bto\b)\s*${NUM})*`;
/** A number before a points cue: "3 points", "a 3-pointer", "a three point story", "8 SP". */
const BEFORE_CUE = new RegExp(
  String.raw`\b(${LIST})(?:\s*-\s*|\s+)?(?:story\s+)?(?:points?|pointers?|pts?|sp)\b`,
  "gi",
);
/** A number after a cue: "estimate of 5", "points to 3", "SP: 5", "more like a 5", "like 5". */
const AFTER_CUE = new RegExp(
  String.raw`\b(?:estimated?\s*(?:at|of|is|as|to be|:|=)?|estimates?\s*(?:of|is|are|:|=)?|(?:story\s+)?points?\s*(?:to|=|:|of|is|are|at)|sp\s*(?:to|=|:|of|is)?|sized?\s+(?:at|as)|like\s+an?|like(?=\s+\d))\s*(${LIST})\b`,
  "gi",
);

/**
 * The numbers the texts give as story points: digits or English number words
 * next to a points cue ("a 3-pointer", "5 points", "estimate of 8", "more like a
 * 5"), every number of a list ("3, 5 or 8 points"). Numbers without a cue ("send
 * me two reports"), issue keys (any case), ISO dates and times do not count, so
 * stated points can be told from a model's invention.
 */
export function statedNumbers(texts: readonly string[]): Set<number> {
  const out = new Set<number>();
  for (const raw of texts) {
    const text = raw
      .replace(/\b[A-Za-z][A-Za-z0-9_]*-\d+\b/g, " ")
      .replace(/\b\d{4}-\d{2}-\d{2}\b/g, " ")
      .replace(/\b\d{1,2}:\d{2}\b/g, " ");
    for (const re of [BEFORE_CUE, AFTER_CUE])
      for (const m of text.matchAll(re))
        for (const n of (m[1] ?? "").matchAll(new RegExp(NUM, "gi"))) {
          const v = n[0].toLowerCase();
          out.add(WORDS[v] ?? Number(v));
        }
  }
  return out;
}

/** Points a pending proposal of the item carries, as the user left them (D55). */
export type KeptPoints = {
  /** Points that were stated or set by the user (or a small-ask default); never an estimate. */
  points: number | null;
  /** The user cleared the points: no estimate or default replaces that. */
  cleared: boolean;
};

/** Which pending proposal a proposal revises: a create by its ref, an update by its target. */
export function pointsKey(p: Record<string, unknown>): string | null {
  if (p.kind === "create_issue" && typeof p.ref === "string") return `create:${p.ref}`;
  if (p.kind === "update_issue" && typeof p.target === "string") return `update:${p.target}`;
  return null;
}

/** The pending proposals' points in the output shape, by `pointsKey`, for a revision. */
export function keptPoints(
  pending: readonly Record<string, unknown>[] | undefined,
): Map<string, KeptPoints> {
  const out = new Map<string, KeptPoints>();
  for (const p of pending ?? []) {
    const key = pointsKey(p);
    if (!key) continue;
    const n = parsePoints(p.storyPoints);
    out.set(key, {
      points: typeof n === "number" && p.pointsSource !== "estimated" ? n : null,
      cleared: p.pointsCleared === true,
    });
  }
  return out;
}

/** What the checks need to know about one proposal and its item. */
export type PointsContext = {
  kind: string;
  storyPoints: unknown;
  pointsSource: unknown;
  /** The ticket is (or would be) an Epic, which never gets points. */
  epic: boolean;
  /** The ticket's points now, for an update; undefined when not known. */
  current?: number | null;
  scale: readonly number[];
  /** Numbers the input and the user's instructions give as points (`statedNumbers`). */
  stated: ReadonlySet<number>;
  /** Of those, the ones in the user's own instructions. */
  instructed: ReadonlySet<number>;
  /** What the pending proposal this one revises carries, if any. */
  kept?: KeptPoints;
};

const isSource = (v: unknown): v is PointSource =>
  typeof v === "string" && (POINT_SOURCES as readonly string[]).includes(v);

/** The problems with one proposal's points, for the repair prompt; empty when fine. */
export function pointsProblems(c: PointsContext): string[] {
  const points = parsePoints(c.storyPoints);
  const source = isSource(c.pointsSource) ? c.pointsSource : null;
  if (points === null) {
    return source
      ? [
          `pointsSource is ${source} but storyPoints is empty; give the number, or leave both empty.`,
        ]
      : [];
  }
  if (points === "invalid")
    return [`storyPoints must be a number such as 3 or 0.5, not "${String(c.storyPoints)}".`];
  if (points < 0 || points > MAX_STORY_POINTS)
    return [`storyPoints ${points} is out of range (0 to ${MAX_STORY_POINTS}).`];
  if (!source) return ["storyPoints needs pointsSource stated or estimated."];
  if (c.epic) return ["an Epic does not get story points; leave storyPoints empty."];
  if (c.kept?.cleared && !(source === "stated" && c.instructed.has(points)))
    return [
      "the user cleared this ticket's story points; leave storyPoints empty unless their instructions give a number.",
    ];
  const kept = c.kept?.points === points;
  if (c.kind === "update_issue") {
    if (source !== "stated")
      return [
        "never estimate an existing ticket: set its storyPoints only to a number the input gives as its points, with pointsSource stated, or leave them out.",
      ];
    if (c.current === points) return [`the ticket already has ${points} points; leave them out.`];
  }
  if (source === "stated" && !c.stated.has(points) && !kept)
    return [
      `storyPoints ${points} is not given as story points in the input; use pointsSource estimated with a value from the story point scale, or leave it empty.`,
    ];
  if (source === "estimated") {
    if (!c.scale.length)
      return ["there is no story point scale, so do not estimate; leave storyPoints empty."];
    if (!c.scale.includes(points))
      return [
        `an estimate must be one of the scale's values (${c.scale.join(", ")}), not ${points}.`,
      ];
  }
  return [];
}

/**
 * The points a create_issue payload gets (D55): an Epic none; points the user
 * cleared stay cleared unless stated again; a small ask without stated points
 * the default when one is set; else what the model gave, marked estimated when
 * it suggested them.
 */
export function createPoints(
  storyPoints: unknown,
  pointsSource: unknown,
  opts: { epic: boolean; smallAsk: boolean; defaultPoints?: number | null; cleared?: boolean },
): { storyPoints: number | null; storyPointsEstimated: boolean; storyPointsCleared: boolean } {
  const none = { storyPoints: null, storyPointsEstimated: false, storyPointsCleared: false };
  if (opts.epic) return none;
  const parsed = parsePoints(storyPoints);
  const points = typeof parsed === "number" ? parsed : null;
  const stated = pointsSource === "stated" && points !== null;
  if (opts.cleared && !stated) return { ...none, storyPointsCleared: true };
  if (opts.smallAsk && !stated && typeof opts.defaultPoints === "number")
    return { ...none, storyPoints: opts.defaultPoints };
  if (points === null || !isSource(pointsSource)) return none;
  return { ...none, storyPoints: points, storyPointsEstimated: pointsSource === "estimated" };
}
