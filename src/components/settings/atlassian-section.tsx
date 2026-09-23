import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Effect } from "effect";
import { CheckCircle2, KeyRound } from "lucide-react";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { useErrorToast, useSecretStatus, useSettings, useUpdateSettings } from "@/app/hooks";
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
import { ConfluenceClient, type ConfluenceError } from "@/services/confluence";
import { JiraClient, type JiraError } from "@/services/jira";
import { Secrets, secretNames } from "@/services/secrets";

type Product = "jira" | "confluence";

const COPY: Record<
  Product,
  { title: string; description: string; placeholder: string; secret: string }
> = {
  jira: {
    title: "Jira Data Center",
    description: "REST API v2 with a personal access token (Profile > Personal Access Tokens).",
    placeholder: "https://jira.example.com",
    secret: secretNames.jiraPat,
  },
  confluence: {
    title: "Confluence Data Center",
    description: "Read-only access for searching and importing pages.",
    placeholder: "https://confluence.example.com",
    secret: secretNames.confluencePat,
  },
};

const Form = z.object({
  baseUrl: z.union([z.literal(""), z.url({ protocol: /^https?$/, error: "Enter an http(s) URL" })]),
  pat: z.string(),
});
type FormValues = z.infer<typeof Form>;

type Connected = { displayName: string; username?: string };

const testConnection = (
  product: Product,
  creds: { baseUrl?: string; pat?: string },
): Effect.Effect<Connected, JiraError | ConfluenceError, JiraClient | ConfluenceClient> =>
  product === "jira"
    ? Effect.flatMap(JiraClient, (c) => c.testConnection(creds)).pipe(
        Effect.map((u) => ({ displayName: u.displayName, username: u.name })),
      )
    : Effect.flatMap(ConfluenceClient, (c) => c.testConnection(creds)).pipe(
        Effect.map((u) => ({ displayName: u.displayName, username: u.username })),
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
    defaultValues: { baseUrl: "", pat: "" },
  });
  const storedUrl = settings?.[product].baseUrl ?? "";
  useEffect(() => form.reset({ baseUrl: storedUrl, pat: "" }), [storedUrl, form]);

  const refreshPatStatus = () =>
    client.invalidateQueries({ queryKey: queryKeys.secretStatus(copy.secret) });

  const save = useMutation({
    mutationFn: async (values: FormValues) => {
      if (values.pat.trim()) {
        await run(Effect.flatMap(Secrets, (s) => s.set(copy.secret, values.pat.trim())));
      }
      await update.mutateAsync((s) => ({
        ...s,
        [product]: { ...s[product], baseUrl: values.baseUrl },
      }));
    },
    onSuccess: () => {
      toast.success(`${copy.title} settings saved`);
      refreshPatStatus();
    },
    onError: (e) => onError(e),
  });

  const removePat = useMutation({
    mutationFn: () => run(Effect.flatMap(Secrets, (s) => s.remove(copy.secret))),
    onSuccess: () => {
      toast.success("Token removed from the keychain");
      setConnectedAs(null);
      refreshPatStatus();
    },
    onError: (e) => onError(e),
  });

  const test = useMutation({
    mutationFn: (values: FormValues) =>
      run(
        testConnection(product, {
          baseUrl: values.baseUrl || undefined,
          pat: values.pat || undefined,
        }),
      ),
    onMutate: () => setConnectedAs(null),
    onSuccess: (user) =>
      setConnectedAs(user.username ? `${user.displayName} (${user.username})` : user.displayName),
    onError: (e) => onError(e),
  });

  return (
    <Card>
      <form onSubmit={form.handleSubmit((v) => save.mutate(v))}>
        <CardHeader>
          <CardTitle>{copy.title}</CardTitle>
          <CardDescription>{copy.description}</CardDescription>
        </CardHeader>
        <CardContent>
          <FieldGroup>
            <Field data-invalid={!!form.formState.errors.baseUrl}>
              <FieldLabel htmlFor={`${product}-url`}>Base URL</FieldLabel>
              <Input
                id={`${product}-url`}
                placeholder={copy.placeholder}
                {...form.register("baseUrl")}
              />
              <FieldDescription>
                Include any context path, for example https://host/jira.
              </FieldDescription>
              <FieldError errors={[form.formState.errors.baseUrl]} />
            </Field>
            <Field>
              <FieldLabel htmlFor={`${product}-pat`}>
                Personal access token
                {patStatus.data ? (
                  <Badge variant="secondary" className="ml-2">
                    <KeyRound /> Stored in keychain
                  </Badge>
                ) : (
                  <Badge variant="outline" className="ml-2">
                    Not set
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
            onClick={form.handleSubmit((v) => test.mutate(v))}
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
