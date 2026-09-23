import { createFileRoute } from "@tanstack/react-router";
import { Building2 } from "lucide-react";
import { PageHeader, Planned } from "@/components/page";

export const Route = createFileRoute("/teams")({ component: Page });

function Page() {
  return (
    <>
      <PageHeader
        title="Teams"
        description="Teams, what to contact them for, and their Confluence pages."
      />
      <Planned
        icon={Building2}
        title="Coming in phase 2"
        description="This page is part of the implementation plan and is not built yet."
      />
    </>
  );
}
