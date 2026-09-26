import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { z } from "zod";
import { SETTINGS_TABS, type SettingsTab } from "@/app/settings-tabs";
import { PageHeader } from "@/components/page";
import { AtlassianSection } from "@/components/settings/atlassian-section";
import { DataSection } from "@/components/settings/data-section";
import { GeneralSection } from "@/components/settings/general-section";
import { JiraSyncSection } from "@/components/settings/jira-sync-section";
import { ModelsSection } from "@/components/settings/models-section";
import { NetworkSection } from "@/components/settings/network-section";
import { ProvidersSection } from "@/components/settings/providers-section";
import { RankingSection } from "@/components/settings/ranking-section";
import { SourcesSection } from "@/components/settings/sources-section";
import { UsageSection } from "@/components/settings/usage-section";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

const Search = z.object({
  tab: z
    .enum(SETTINGS_TABS.map((t) => t.value) as [SettingsTab, ...SettingsTab[]])
    .catch("general"),
});

export const Route = createFileRoute("/settings")({
  validateSearch: Search,
  component: SettingsPage,
});

function SettingsPage() {
  const { tab } = Route.useSearch();
  const navigate = useNavigate({ from: "/settings" });
  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader
        title="Settings"
        description="Model providers, Jira and Confluence connections, note folders and local data. Keys and tokens are kept in the OS keychain."
      />
      <Tabs
        value={tab}
        onValueChange={(value) => navigate({ search: { tab: value as SettingsTab } })}
      >
        <TabsList className="mb-4 flex-wrap justify-start group-data-horizontal/tabs:h-auto *:h-7 *:flex-none">
          {SETTINGS_TABS.map((t) => (
            <TabsTrigger key={t.value} value={t.value}>
              {t.label}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value="general" className="flex flex-col gap-4">
          <GeneralSection />
          <NetworkSection />
        </TabsContent>
        <TabsContent value="providers">
          <ProvidersSection />
        </TabsContent>
        <TabsContent value="models">
          <ModelsSection />
        </TabsContent>
        <TabsContent value="ranking">
          <RankingSection />
        </TabsContent>
        <TabsContent value="jira" className="flex flex-col gap-4">
          <AtlassianSection product="jira" />
          <JiraSyncSection />
        </TabsContent>
        <TabsContent value="confluence">
          <AtlassianSection product="confluence" />
        </TabsContent>
        <TabsContent value="sources">
          <SourcesSection />
        </TabsContent>
        <TabsContent value="usage">
          <UsageSection />
        </TabsContent>
        <TabsContent value="data">
          <DataSection />
        </TabsContent>
      </Tabs>
    </div>
  );
}
