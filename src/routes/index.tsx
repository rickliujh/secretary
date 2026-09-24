import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { LayoutDashboard } from "lucide-react";
import { IntakeBox } from "@/components/inbox/intake-box";
import { PageHeader, Planned } from "@/components/page";

export const Route = createFileRoute("/")({ component: Dashboard });

function Dashboard() {
  const navigate = useNavigate();
  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6">
      <PageHeader
        title="Dashboard"
        description="What matters right now: focus, waiting, at risk and due soon."
      />
      <IntakeBox compact onTriaged={(id) => navigate({ to: "/inbox", search: { item: id } })} />
      <Planned
        icon={LayoutDashboard}
        title="Coming in phase 5"
        description="Ranked focus, dependencies you are waiting on, at-risk and due-soon work, and a daily brief."
      />
    </div>
  );
}
