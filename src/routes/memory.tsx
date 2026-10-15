import { createFileRoute, redirect } from "@tanstack/react-router";
import { z } from "zod";
import { MEMORY_LISTS } from "@/app/tabs";

/** Old path (D50): memory is Context > Memory; its old `tab` is now `list`. */
export const Route = createFileRoute("/memory")({
  validateSearch: z.object({ tab: z.enum(MEMORY_LISTS).optional().catch(undefined) }),
  beforeLoad: ({ search: { tab, ...rest } }) => {
    throw redirect({
      to: "/context",
      search: { ...rest, tab: "memory", list: tab },
      replace: true,
    });
  },
});
