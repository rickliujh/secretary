import { createFileRoute } from "@tanstack/react-router";
import { MessagesSquare } from "lucide-react";
import { PageHeader, Planned } from "@/components/page";

export const Route = createFileRoute("/chat")({ component: Page });

function Page() {
  return (
    <>
      <PageHeader
        title="Chat"
        description="Ask the secretary about your tickets, dependencies and people."
      />
      <Planned
        icon={MessagesSquare}
        title="Coming in phase 7"
        description="This page is part of the implementation plan and is not built yet."
      />
    </>
  );
}
