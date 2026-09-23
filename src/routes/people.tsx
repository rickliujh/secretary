import { createFileRoute } from "@tanstack/react-router";
import { Users } from "lucide-react";
import { PageHeader, Planned } from "@/components/page";

export const Route = createFileRoute("/people")({ component: Page });

function Page() {
  return (
    <>
      <PageHeader
        title="People"
        description="Contacts with titles, teams and communication profiles."
      />
      <Planned
        icon={Users}
        title="Coming in phase 2"
        description="This page is part of the implementation plan and is not built yet."
      />
    </>
  );
}
