import { createFileRoute, redirect } from "@tanstack/react-router";
import { z } from "zod";

/** Old path (D50): contacts are Context > People; `id` still opens one. */
export const Route = createFileRoute("/people")({
  validateSearch: z.object({ id: z.string().optional().catch(undefined) }),
  beforeLoad: ({ search }) => {
    throw redirect({ to: "/context", search: { ...search, tab: "people" }, replace: true });
  },
});
