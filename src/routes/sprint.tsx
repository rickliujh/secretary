import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { SPRINT_TABS, SprintSearch, type SprintTab } from "@/app/tabs";
import { PlanningPage } from "@/components/planning/planning-page";
import { ReportPage } from "@/components/report/report-page";
import { EpicsPage } from "@/components/sprint/epic-health";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

export const Route = createFileRoute("/sprint")({
  validateSearch: SprintSearch,
  component: SprintPage,
});

/** Sprint (D50): Plan (D30), Report (D37) and Epics (epic health) as tabs. */
function SprintPage() {
  const { tab } = Route.useSearch();
  const navigate = useNavigate({ from: "/sprint" });
  // An unsent plan lives in the Plan tab's own state (a model call and the user's
  // edits), so once opened the tab stays mounted and is only hidden. Report and
  // Epics still mount, and load, when opened.
  const [planOpened, setPlanOpened] = useState(tab === "plan");
  if (tab === "plan" && !planOpened) setPlanOpened(true);
  return (
    <Tabs
      value={tab}
      onValueChange={(t) => navigate({ search: { tab: t as SprintTab } })}
      className="mx-auto flex max-w-6xl flex-col gap-4"
    >
      <TabsList>
        {SPRINT_TABS.map((t) => (
          <TabsTrigger key={t.value} value={t.value}>
            {t.label}
          </TabsTrigger>
        ))}
      </TabsList>
      <TabsContent
        value="plan"
        forceMount={planOpened || undefined}
        className="data-[state=inactive]:hidden"
      >
        <PlanningPage />
      </TabsContent>
      <TabsContent value="report">
        <ReportPage />
      </TabsContent>
      <TabsContent value="epics">
        <EpicsPage />
      </TabsContent>
    </Tabs>
  );
}
