import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Effect } from "effect";
import { CheckCircle2, KeyRound } from "lucide-react";
import { useEffect, useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import {
  useAppMutation,
  useErrorToast,
  useSecretStatus,
  useSettings,
  useUpdateSettings,
} from "@/app/hooks";
import { queryKeys } from "@/app/query-client";
import { run } from "@/app/runtime";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { type Deployment, resolveDeployment, TOKEN_HELP } from "@/services/atlassian/deployment";
import { ConfluenceClient, type ConfluenceError } from "@/services/confluence";
import { JiraClient, type JiraError } from "@/services/jira";
import { Secrets, secretNames } from "@/services/secrets";
import { DeploymentSetting } from "@/services/settings/schema";

type Product = "jira" | "confluence";

const COPY: Record<
  Product,
  { name: string; description: string; placeholder: Record<Deployment, string>; secret: string }
> = {
  jira: {
    name: "Jira",
    description: "Tickets are synced from and written back to Jira.",
    placeholder: {
      cloud: "https://your-site.atlassian.net",
      datacenter: "https://jira.example.com",
    },
    secret: secretNames.jiraPat,
  },
  confluence: {
    name: "Confluence",
    description: "Read-only access for searching and importing pages.",
    placeholder: {
      cloud: "https://your-site.atlassian.net/wiki",
      datacenter: "https://confluence.example.com",
    },
    secret: secretNames.confluencePat,
  },
};

const DEPLOYMENT_LABEL: Record<Deployment, string> = { cloud: "Cloud", datacenter: "Data Center" };

const Form = z.object({
  baseUrl: z.union([z.literal(""), z.url({ protocol: /^https?$/, error: "Enter an http(s) URL" })]),
  deployment: DeploymentSetting,
  email: z.union([z.literal(""), z.email("Enter your Atlassian account email")]),
  pat: z.string(),
});
type FormValues = z.infer<typeof Form>;

type Connected = { displayName: string; detail?: string };

const testConnection = (
  product: Product,
  creds: { baseUrl?: string; pat?: string; email?: string },
): Effect.Effect<Connected, JiraError | ConfluenceError, JiraClient | ConfluenceClient> =>
  product === "jira"
    ? Effect.flatMap(JiraClient, (c) => c.testConnection(creds)).pipe(
        Effect.map((u) => ({ displayName: u.displayName, detail: u.emailAddress ?? u.id })),
      )
    : Effect.flatMap(ConfluenceClient, (c) => c.testConnection(creds)).pipe(
        Effect.map((u) => ({ displayName: u.displayName, detail: u.username })),
      );

export function AtlassianSection({ product }: { product: Product }) {
  const copy = COPY[product];
  const { data: settings } = useSettings();
  const update = useUpdateSettings();
  const patStatus = useSecretStatus(copy.secret);
  const client = useQueryClient();
  const onError = useErrorToast();
  const [connectedAs, setConnectedAs] = useState<string | null>(null);

  const form = useForm<FormValues>({
    resolver: zodResolver(Form),
    defaultValues: { baseUrl: "", deployment: "auto", email: "", pat: "" },
  });
  const stored = settings?.[product];
  useEffect(() => {
    if (stored)
      form.reset({
        baseUrl: stored.baseUrl,
        deployment: stored.deployment,
        email: stored.email,
        pat: "",
      });
  }, [stored, form]);

  const url = form.watch("baseUrl");
  const deploymentSetting = form.watch("deployment");
  const deployment = resolveDeployment(url, deploymentSetting);
  const title = `${copy.name} ${DEPLOYMENT_LABEL[deployment]}`;
  const sharesJiraToken =
    product === "confluence" &&
    deployment === "cloud" &&
    !!settings?.jira.baseUrl &&
    url !== "" &&
    safeOrigin(url) === safeOrigin(settings.jira.baseUrl);

  const refreshPatStatus = () =>
    client.invalidateQueries({ queryKey: queryKeys.secretStatus(copy.secret) });

  const save = useMutation({
    mutationFn: async (values: FormValues) => {
      if (values.pat.trim()) {
        await run(Effect.flatMap(Secrets, (s) => s.set(copy.secret, values.pat.trim())));
      }
      await update.mutateAsync((s) => ({
        ...s,
        [product]: {
          ...s[product],
          baseUrl: values.baseUrl,
          deployment: values.deployment,
          email: values.email,
        },
      }));
    },
    onSuccess: () => {
      toast.success(`${copy.name} settings saved`);
      refreshPatStatus();
    },
    onError: (e) => onError(e),
  });

  const removePat = useAppMutation(() => Effect.flatMap(Secrets, (s) => s.remove(copy.secret)), {
    invalidate: [queryKeys.secretStatus(copy.secret)],
    success: "Token removed from the keychain",
    onSuccess: () => setConnectedAs(null),
  });

  const test = useAppMutation(
    (values: FormValues) =>
      testConnection(product, {
        baseUrl: values.baseUrl || undefined,
        pat: values.pat || undefined,
        email: values.email || undefined,
      }),
    {
      onSuccess: (user) =>
        setConnectedAs(user.detail ? `${user.displayName} (${user.detail})` : user.displayName),
    },
  );

  return (
    <Card>
      <form onSubmit={form.handleSubmit((v) => save.mutate(v))}>
        <CardHeader>
          <CardTitle>{title}</CardTitle>
          <CardDescription>{copy.description}</CardDescription>
        </CardHeader>
        <CardContent>
          <FieldGroup>
            <div className="grid grid-cols-[1fr_12rem] gap-4">
              <Field data-invalid={!!form.formState.errors.baseUrl}>
                <FieldLabel htmlFor={`${product}-url`}>Site URL</FieldLabel>
                <Input
                  id={`${product}-url`}
                  placeholder={copy.placeholder[deployment]}
                  {...form.register("baseUrl")}
                />
                <FieldDescription>
                  {deployment === "cloud"
                    ? "Any address on your site works; the app uses the right API path."
                    : "Include any context path, for example https://host/jira."}
                </FieldDescription>
                <FieldError errors={[form.formState.errors.baseUrl]} />
              </Field>
              <Controller
                control={form.control}
                name="deployment"
                render={({ field }) => (
                  <Field>
                    <FieldLabel htmlFor={`${product}-deployment`}>Type</FieldLabel>
                    <Select value={field.value} onValueChange={field.onChange}>
                      <SelectTrigger id={`${product}-deployment`} className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="auto">
                          Detect ({DEPLOYMENT_LABEL[resolveDeployment(url, "auto")]})
                        </SelectItem>
                        <SelectItem value="cloud">Cloud</SelectItem>
                        <SelectItem value="datacenter">Data Center</SelectItem>
                      </SelectContent>
                    </Select>
                  </Field>
                )}
              />
            </div>
            {deployment === "cloud" && (
              <Field data-invalid={!!form.formState.errors.email}>
                <FieldLabel htmlFor={`${product}-email`}>Atlassian account email</FieldLabel>
                <Input
                  id={`${product}-email`}
                  type="email"
                  autoComplete="off"
                  placeholder={sharesJiraToken ? "Blank: same as Jira" : "you@company.com"}
                  {...form.register("email")}
                />
                <FieldError errors={[form.formState.errors.email]} />
              </Field>
            )}
            <Field>
              <FieldLabel htmlFor={`${product}-pat`}>
                {deployment === "cloud" ? "API token" : "Personal access token"}
                {patStatus.data ? (
                  <Badge variant="secondary" className="ml-2">
                    <KeyRound /> Stored in keychain
                  </Badge>
                ) : (
                  <Badge variant="outline" className="ml-2">
                    {sharesJiraToken ? "Uses the Jira token" : "Not set"}
                  </Badge>
                )}
              </FieldLabel>
              <Input
                id={`${product}-pat`}
                type="password"
                autoComplete="off"
                placeholder={
                  patStatus.data ? "Leave blank to keep the stored token" : "Paste token"
                }
                {...form.register("pat")}
              />
              <FieldDescription>Use {TOKEN_HELP[deployment]}.</FieldDescription>
            </Field>
            {connectedAs && (
              <Alert>
                <CheckCircle2 />
                <AlertTitle>Connected</AlertTitle>
                <AlertDescription>Signed in as {connectedAs}.</AlertDescription>
              </Alert>
            )}
          </FieldGroup>
        </CardContent>
        <CardFooter className="mt-4 gap-2">
          <Button type="submit" disabled={save.isPending}>
            Save
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={test.isPending}
            onClick={form.handleSubmit((v) => {
              setConnectedAs(null);
              test.mutate(v);
            })}
          >
            {test.isPending ? "Testing..." : "Test connection"}
          </Button>
          {patStatus.data && (
            <Button
              type="button"
              variant="ghost"
              className="ml-auto text-destructive"
              onClick={() => removePat.mutate()}
            >
              Remove token
            </Button>
          )}
        </CardFooter>
      </form>
    </Card>
  );
}

function safeOrigin(url: string) {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}
