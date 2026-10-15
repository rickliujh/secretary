/**
 * The days-per-point field of Settings > General (D57): empty, or a number in
 * the setting's bounds, typed with a decimal point or comma ("0,5").
 */
import { z } from "zod";
import { MAX_DAYS_PER_POINT, MIN_DAYS_PER_POINT } from "@/services/settings/schema";

/** A decimal typed with a comma ("0,5") or a point. */
export const decimal = (v: string) => Number(v.trim().replace(",", "."));

/** Empty, or working days per story point within the setting's bounds (D57). */
export const DaysPerPoint = z
  .string()
  .trim()
  .refine(
    (v) =>
      v === "" ||
      (/^\d*[.,]?\d+$/.test(v) &&
        decimal(v) >= MIN_DAYS_PER_POINT &&
        decimal(v) <= MAX_DAYS_PER_POINT),
    `Enter a number from ${MIN_DAYS_PER_POINT} to ${MAX_DAYS_PER_POINT}, or leave it empty`,
  );
