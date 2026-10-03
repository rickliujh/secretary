import { createFileRoute, useNavigate } from "@tanstack/react-router";
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
      <TabsContent value="plan">
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
