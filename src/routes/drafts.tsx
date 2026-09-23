import { createFileRoute } from "@tanstack/react-router";
import { PenLine } from "lucide-react";
import { PageHeader, Planned } from "@/components/page";

export const Route = createFileRoute("/drafts")({ component: Page });

function Page() {
  return (
    <>
      <PageHeader
        title="Drafts"
        description="Teams messages and emails in the right tone for each recipient."
      />
      <Planned
        icon={PenLine}
        title="Coming in phase 6"
        description="This page is part of the implementation plan and is not built yet."
      />
    </>
  );
}
