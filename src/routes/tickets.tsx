import { createFileRoute } from "@tanstack/react-router";
import { ListTree } from "lucide-react";
import { PageHeader, Planned } from "@/components/page";

export const Route = createFileRoute("/tickets")({ component: Page });

function Page() {
  return (
    <>
      <PageHeader
        title="Tickets"
        description="Synced Jira issues as an Epic, Story and Sub-task tree."
      />
      <Planned
        icon={ListTree}
        title="Coming in phase 1"
        description="This page is part of the implementation plan and is not built yet."
      />
    </>
  );
}
