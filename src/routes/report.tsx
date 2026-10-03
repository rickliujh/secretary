import { createFileRoute, redirect } from "@tanstack/react-router";

/** Old path (D50): the recap is Sprint > Report. */
export const Route = createFileRoute("/report")({
  beforeLoad: ({ search }) => {
    throw redirect({ to: "/sprint", search: { ...search, tab: "report" }, replace: true });
  },
});
