import { createFileRoute } from "@tanstack/react-router";
import { LayoutDashboard } from "lucide-react";
import { PageHeader, Planned } from "@/components/page";

export const Route = createFileRoute("/")({ component: Page });

function Page() {
  return (
    <>
      <PageHeader
        title="Dashboard"
        description="What matters right now: focus, waiting, at risk and due soon."
      />
      <Planned
        icon={LayoutDashboard}
        title="Coming in phase 5"
        description="This page is part of the implementation plan and is not built yet."
      />
    </>
  );
}
