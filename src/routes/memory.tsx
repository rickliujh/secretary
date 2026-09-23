import { createFileRoute } from "@tanstack/react-router";
import { Brain } from "lucide-react";
import { PageHeader, Planned } from "@/components/page";

export const Route = createFileRoute("/memory")({ component: Page });

function Page() {
  return (
    <>
      <PageHeader title="Memory" description="Rules, facts, preferences and correction examples." />
      <Planned
        icon={Brain}
        title="Coming in phase 7"
        description="This page is part of the implementation plan and is not built yet."
      />
    </>
  );
}
