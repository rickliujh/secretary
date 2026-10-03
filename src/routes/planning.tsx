import { createFileRoute, redirect } from "@tanstack/react-router";

/** Old path (D50): the planner is Sprint > Plan. */
export const Route = createFileRoute("/planning")({
  beforeLoad: ({ search }) => {
    throw redirect({ to: "/sprint", search: { ...search, tab: "plan" }, replace: true });
  },
});
