import { createFileRoute, redirect } from "@tanstack/react-router";
import { z } from "zod";

/** Old path (D50): teams are Context > Teams; `id` still opens one. */
export const Route = createFileRoute("/teams")({
  validateSearch: z.object({ id: z.string().optional().catch(undefined) }),
  beforeLoad: ({ search }) => {
    throw redirect({ to: "/context", search: { ...search, tab: "teams" }, replace: true });
  },
});
