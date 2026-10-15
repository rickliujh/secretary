import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { CONTEXT_TABS, ContextSearch, type ContextTab } from "@/app/tabs";
import { PeoplePage } from "@/components/directory/people-page";
import { TeamsPage } from "@/components/directory/teams-page";
import { MemoryPage } from "@/components/memory/memory-page";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

export const Route = createFileRoute("/context")({
  validateSearch: ContextSearch,
  component: ContextPage,
});

/** Context (D50): People, Teams and Memory as tabs. */
function ContextPage() {
  const { tab, id, list } = Route.useSearch();
  const navigate = useNavigate({ from: "/context" });
  const select = (next: string | undefined) =>
    navigate({ search: (prev) => ({ ...prev, id: next }) });
  return (
    <Tabs
      value={tab}
      // `id` belongs to the tab it was opened on, so another tab starts without one.
      onValueChange={(t) => navigate({ search: { tab: t as ContextTab } })}
      className="mx-auto flex max-w-5xl flex-col gap-4"
    >
      <TabsList>
        {CONTEXT_TABS.map((t) => (
          <TabsTrigger key={t.value} value={t.value}>
            {t.label}
          </TabsTrigger>
        ))}
      </TabsList>
      <TabsContent value="people">
        <PeoplePage selectedId={id} onSelect={select} />
      </TabsContent>
      <TabsContent value="teams">
        <TeamsPage selectedId={id} onSelect={select} />
      </TabsContent>
      <TabsContent value="memory">
        <MemoryPage
          list={list}
          onListChange={(next) => navigate({ search: (prev) => ({ ...prev, list: next }) })}
        />
      </TabsContent>
    </Tabs>
  );
}
