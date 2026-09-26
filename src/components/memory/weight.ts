import { WEIGHTS } from "@/services/memory/schema";

export type WeightName = keyof typeof WEIGHTS;

export const WEIGHT_NAMES = ["low", "normal", "high"] as const satisfies readonly WeightName[];

export const WEIGHT_OPTIONS: readonly { value: WeightName; label: string }[] = [
  { value: "low", label: "Low" },
  { value: "normal", label: "Normal" },
  { value: "high", label: "High" },
];

/**
 * The preset a stored weight reads as. Imported or older memories can hold
 * any number, so anything at or below Low reads Low and at or above High reads High.
 */
export const weightName = (weight: number): WeightName =>
  weight <= WEIGHTS.low ? "low" : weight >= WEIGHTS.high ? "high" : "normal";
