/** Badge colours by meaning, so a status reads the same on every page. */
export const TONE = {
  warning: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  success: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  info: "bg-blue-500/15 text-blue-700 dark:text-blue-300",
  danger: "bg-destructive/15 text-destructive",
  neutral: "bg-muted text-muted-foreground",
} as const;

export type Tone = keyof typeof TONE;
