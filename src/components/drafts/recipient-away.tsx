import { localDate } from "@/lib/dates";
import { awayLabel } from "@/services/directory/away";

/** A warning that the recipient is away (D47); nothing when they are not. */
export function RecipientAway({
  name,
  awayUntil,
}: {
  name: string | null | undefined;
  awayUntil: string | null | undefined;
}) {
  const label = awayLabel(awayUntil, localDate());
  if (!label || !name) return null;
  return (
    <p className="text-sm text-amber-700 dark:text-amber-300">
      {name} is {label.charAt(0).toLowerCase()}
      {label.slice(1)}. They will read this when they are back.
    </p>
  );
}
