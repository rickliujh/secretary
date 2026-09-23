import { createFileRoute } from "@tanstack/react-router";
import { Inbox } from "lucide-react";
import { PageHeader, Planned } from "@/components/page";

export const Route = createFileRoute("/inbox")({ component: Page });

function Page() {
  return (
    <>
      <PageHeader
        title="Inbox"
        description="Paste messages or notes and approve the proposed Jira actions."
      />
      <Planned
        icon={Inbox}
        title="Coming in phase 3"
        description="This page is part of the implementation plan and is not built yet."
      />
    </>
  );
}
