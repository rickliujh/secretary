import { createFileRoute } from "@tanstack/react-router";
import { Hourglass } from "lucide-react";
import { PageHeader, Planned } from "@/components/page";

export const Route = createFileRoute("/waiting")({ component: Page });

function Page() {
  return (
    <>
      <PageHeader
        title="Waiting on"
        description="Open dependencies grouped by owner, overdue first."
      />
      <Planned
        icon={Hourglass}
        title="Coming in phase 4"
        description="This page is part of the implementation plan and is not built yet."
      />
    </>
  );
}
