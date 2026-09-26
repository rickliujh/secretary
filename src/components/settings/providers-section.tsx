import { KeyRound, Plus } from "lucide-react";
import { useState } from "react";
import { useAppMutation, useSecretStatus, useSettings } from "@/app/hooks";
import { queryKeys } from "@/app/query-client";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ANTHROPIC_MODEL_SUGGESTIONS, TIERS } from "@/services/llm/tasks";
import { secretNames } from "@/services/secrets";
import type { AppSettings, Provider } from "@/services/settings";
import { deleteProvider } from "@/services/settings/providers";
import { ProviderDialog } from "./provider-dialog";
import { useLlmTest } from "./use-llm-test";

function defaultTestModel(provider: Provider, settings: AppSettings) {
  for (const tier of TIERS) {
    const b = settings.tiers[tier];
    if (b?.providerId === provider.id) return b.model;
  }
  return provider.kind === "anthropic" ? ANTHROPIC_MODEL_SUGGESTIONS.fast : "";
}

function ProviderCard({
  provider,
  settings,
  onEdit,
}: {
  provider: Provider;
  settings: AppSettings;
  onEdit: () => void;
}) {
  const key = useSecretStatus(secretNames.providerApiKey(provider.id));
  const [model, setModel] = useState(() => defaultTestModel(provider, settings));
  const boundTiers = TIERS.filter((t) => settings.tiers[t]?.providerId === provider.id);

  const test = useLlmTest(
    () => ({ providerId: provider.id, model }),
    () => provider.name,
  );

  const remove = useAppMutation(() => deleteProvider(provider.id), {
    invalidate: [queryKeys.settings],
    success: `Removed ${provider.name}`,
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          {provider.name}
          <Badge variant="outline">{provider.kind}</Badge>
        </CardTitle>
        <CardDescription className="font-mono text-xs">{provider.baseUrl}</CardDescription>
        <CardAction className="flex gap-2">
          <Button variant="outline" size="sm" onClick={onEdit}>
            Edit
          </Button>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="ghost" size="sm" className="text-destructive">
                Delete
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Delete {provider.name}?</AlertDialogTitle>
                <AlertDialogDescription>
                  Its key and headers are removed from the keychain
                  {boundTiers.length > 0
                    ? ` and the ${boundTiers.join(", ")} tier(s) become unconfigured`
                    : ""}
                  .
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction onClick={() => remove.mutate()}>Delete</AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          {key.data ? (
            <Badge variant="secondary">
              <KeyRound /> Key in keychain
            </Badge>
          ) : (
            <Badge variant="outline">No key</Badge>
          )}
          {provider.headerNames.map((h) => (
            <Badge key={h} variant="outline" className="font-mono">
              {h}
            </Badge>
          ))}
          {boundTiers.map((t) => (
            <Badge key={t}>{t} tier</Badge>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <Input
            aria-label="Model to test"
            placeholder="Model id to test"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            className="max-w-xs font-mono text-xs"
          />
          <Button
            variant="outline"
            size="sm"
            disabled={!model.trim() || test.isPending}
            onClick={() => test.mutate()}
          >
            {test.isPending ? "Testing..." : "Test"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

export function ProvidersSection() {
  const { data: settings } = useSettings();
  const [dialog, setDialog] = useState<{ open: boolean; provider?: Provider }>({ open: false });
  if (!settings) return null;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          Add any Anthropic-compatible or OpenAI-compatible endpoint, then bind models to tiers on
          the Models tab.
        </p>
        <Button onClick={() => setDialog({ open: true })}>
          <Plus /> Add provider
        </Button>
      </div>
      {settings.providers.length === 0 && (
        <Card>
          <CardContent className="py-6 text-center text-sm text-muted-foreground">
            No providers yet.
          </CardContent>
        </Card>
      )}
      {settings.providers.map((p) => (
        <ProviderCard
          key={p.id}
          provider={p}
          settings={settings}
          onEdit={() => setDialog({ open: true, provider: p })}
        />
      ))}
      <ProviderDialog
        open={dialog.open}
        provider={dialog.provider}
        onOpenChange={(open) => setDialog((d) => ({ ...d, open }))}
      />
    </div>
  );
}
