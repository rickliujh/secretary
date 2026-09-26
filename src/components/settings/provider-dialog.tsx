import { zodResolver } from "@hookform/resolvers/zod";
import { useQueryClient } from "@tanstack/react-query";
import { X } from "lucide-react";
import { useEffect, useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { z } from "zod";
import { useAppMutation } from "@/app/hooks";
import { queryKeys } from "@/app/query-client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { secretNames } from "@/services/secrets";
import { type Provider, ProviderKind, ProviderSchema } from "@/services/settings";
import { parseHeaderLines, saveProvider } from "@/services/settings/providers";

const Form = z
  .object({
    name: z.string().trim().min(1, "Name is required"),
    kind: ProviderKind,
    baseUrl: z.url({ protocol: /^https?$/, error: "Enter an http(s) URL" }),
    apiKey: z.string(),
    newHeaders: z.string(),
    authStyle: ProviderSchema.shape.authStyle.unwrap(),
    thinking: ProviderSchema.shape.thinking.unwrap(),
    effort: ProviderSchema.shape.effort.unwrap(),
    structuredOutputMode: ProviderSchema.shape.structuredOutputMode.unwrap(),
    jsonSchemaOutputs: z.boolean(),
    sendTemperature: z.boolean(),
    seed: z.string().regex(/^\d*$/, "Whole number"),
  })
  .superRefine((v, ctx) => {
    for (const message of parseHeaderLines(v.newHeaders).errors) {
      ctx.addIssue({ code: "custom", path: ["newHeaders"], message });
    }
  });
type FormValues = z.infer<typeof Form>;

const BASE_URL_HINT: Record<ProviderKind, string> = {
  anthropic: "https://api.anthropic.com/v1",
  "openai-compatible": "https://host/v1",
};

function defaults(p?: Provider): FormValues {
  return {
    name: p?.name ?? "",
    kind: p?.kind ?? "anthropic",
    baseUrl: p?.baseUrl ?? "",
    apiKey: "",
    newHeaders: "",
    authStyle: p?.authStyle ?? "x-api-key",
    thinking: p?.thinking ?? "default",
    effort: p?.effort ?? "default",
    structuredOutputMode: p?.structuredOutputMode ?? "auto",
    jsonSchemaOutputs: p?.jsonSchemaOutputs ?? true,
    sendTemperature: p?.sendTemperature ?? true,
    seed: p?.seed === undefined ? "" : String(p.seed),
  };
}

type Option = { value: string; label: string };

function SelectField({
  control,
  name,
  label,
  description,
  options,
}: {
  control: ReturnType<typeof useForm<FormValues>>["control"];
  name: "kind" | "authStyle" | "thinking" | "effort" | "structuredOutputMode";
  label: string;
  description?: string;
  options: Option[];
}) {
  return (
    <Controller
      control={control}
      name={name}
      render={({ field }) => (
        <Field>
          <FieldLabel htmlFor={`provider-${name}`}>{label}</FieldLabel>
          <Select value={field.value} onValueChange={field.onChange}>
            <SelectTrigger id={`provider-${name}`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {options.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {description && <FieldDescription>{description}</FieldDescription>}
        </Field>
      )}
    />
  );
}

function SwitchField({
  control,
  name,
  label,
  description,
}: {
  control: ReturnType<typeof useForm<FormValues>>["control"];
  name: "jsonSchemaOutputs" | "sendTemperature";
  label: string;
  description: string;
}) {
  return (
    <Controller
      control={control}
      name={name}
      render={({ field }) => (
        <Field orientation="horizontal">
          <FieldContent>
            <FieldLabel htmlFor={`provider-${name}`}>{label}</FieldLabel>
            <FieldDescription>{description}</FieldDescription>
          </FieldContent>
          <Switch id={`provider-${name}`} checked={field.value} onCheckedChange={field.onChange} />
        </Field>
      )}
    />
  );
}

export function ProviderDialog({
  open,
  onOpenChange,
  provider,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  provider?: Provider;
}) {
  const client = useQueryClient();
  const [removed, setRemoved] = useState<string[]>([]);
  const form = useForm<FormValues>({
    resolver: zodResolver(Form),
    defaultValues: defaults(provider),
  });
  const kind = form.watch("kind");
  const errors = form.formState.errors;

  useEffect(() => {
    if (open) {
      form.reset(defaults(provider));
      setRemoved([]);
    }
  }, [open, provider, form]);

  const save = useAppMutation(
    (v: FormValues) =>
      saveProvider({
        id: provider?.id,
        name: v.name,
        kind: v.kind,
        baseUrl: v.baseUrl,
        apiKey: v.apiKey,
        removeHeaders: removed,
        addHeaders: parseHeaderLines(v.newHeaders).headers,
        authStyle: v.authStyle,
        thinking: v.thinking,
        effort: v.effort,
        structuredOutputMode: v.structuredOutputMode,
        jsonSchemaOutputs: v.jsonSchemaOutputs,
        sendTemperature: v.sendTemperature,
        seed: v.seed === "" ? undefined : Number(v.seed),
      }),
    {
      invalidate: [queryKeys.settings],
      success: (saved) => `Saved ${saved.name}`,
      onSuccess: (saved) => {
        void client.invalidateQueries({
          queryKey: queryKeys.secretStatus(secretNames.providerApiKey(saved.id)),
        });
        onOpenChange(false);
      },
    },
  );

  const headerNames = (provider?.headerNames ?? []).filter((h) => !removed.includes(h));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90svh] overflow-y-auto sm:max-w-xl">
        <form onSubmit={form.handleSubmit((v) => save.mutate(v))}>
          <DialogHeader className="mb-4">
            <DialogTitle>{provider ? `Edit ${provider.name}` : "Add provider"}</DialogTitle>
            <DialogDescription>
              The API key and header values are stored in the OS keychain, never in the settings
              file.
            </DialogDescription>
          </DialogHeader>
          <FieldGroup>
            <Field data-invalid={!!errors.name}>
              <FieldLabel htmlFor="provider-name">Name</FieldLabel>
              <Input id="provider-name" placeholder="Anthropic" {...form.register("name")} />
              <FieldError errors={[errors.name]} />
            </Field>
            <SelectField
              control={form.control}
              name="kind"
              label="Kind"
              options={[
                { value: "anthropic", label: "Anthropic-compatible (Messages API)" },
                { value: "openai-compatible", label: "OpenAI-compatible (Chat Completions)" },
              ]}
            />
            <Field data-invalid={!!errors.baseUrl}>
              <FieldLabel htmlFor="provider-url">Base URL</FieldLabel>
              <Input
                id="provider-url"
                placeholder={BASE_URL_HINT[kind]}
                {...form.register("baseUrl")}
              />
              <FieldDescription>
                Include the version path, for example {BASE_URL_HINT[kind]}.
              </FieldDescription>
              <FieldError errors={[errors.baseUrl]} />
            </Field>
            <Field>
              <FieldLabel htmlFor="provider-key">API key</FieldLabel>
              <Input
                id="provider-key"
                type="password"
                autoComplete="off"
                placeholder={
                  provider ? "Leave blank to keep the stored key" : "Optional for local servers"
                }
                {...form.register("apiKey")}
              />
            </Field>
            <Field data-invalid={!!errors.newHeaders}>
              <FieldLabel htmlFor="provider-headers">Extra headers</FieldLabel>
              {headerNames.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {headerNames.map((h) => (
                    <Badge key={h} variant="secondary" className="gap-1">
                      {h}
                      <button
                        type="button"
                        aria-label={`Remove header ${h}`}
                        onClick={() => setRemoved((r) => [...r, h])}
                      >
                        <X className="size-3" />
                      </button>
                    </Badge>
                  ))}
                </div>
              )}
              <Textarea
                id="provider-headers"
                rows={2}
                placeholder="X-Proxy-Auth: value"
                className="font-mono text-xs"
                {...form.register("newHeaders")}
              />
              <FieldDescription>
                One "Name: value" per line. Adds to or replaces stored headers.
              </FieldDescription>
              <FieldError errors={errors.newHeaders ? [errors.newHeaders] : undefined} />
            </Field>

            {kind === "anthropic" ? (
              <FieldSet>
                <FieldLegend variant="label">Anthropic options</FieldLegend>
                <FieldDescription>
                  Compatible proxies may reject thinking or effort; leave them on "Provider default"
                  if unsure.
                </FieldDescription>
                <div className="grid grid-cols-2 gap-4">
                  <SelectField
                    control={form.control}
                    name="authStyle"
                    label="Auth header"
                    options={[
                      { value: "x-api-key", label: "x-api-key" },
                      { value: "bearer", label: "Authorization: Bearer" },
                    ]}
                  />
                  <SelectField
                    control={form.control}
                    name="structuredOutputMode"
                    label="Structured output"
                    options={[
                      { value: "auto", label: "Auto" },
                      { value: "outputFormat", label: "Native output format" },
                      { value: "jsonTool", label: "JSON tool" },
                    ]}
                  />
                  <SelectField
                    control={form.control}
                    name="thinking"
                    label="Thinking"
                    options={[
                      { value: "default", label: "Provider default" },
                      { value: "adaptive", label: "Adaptive" },
                      { value: "disabled", label: "Disabled" },
                    ]}
                  />
                  <SelectField
                    control={form.control}
                    name="effort"
                    label="Effort"
                    options={["default", "low", "medium", "high", "xhigh", "max"].map((v) => ({
                      value: v,
                      label: v === "default" ? "Provider default" : v,
                    }))}
                  />
                </div>
              </FieldSet>
            ) : (
              <FieldSet>
                <FieldLegend variant="label">OpenAI-compatible options</FieldLegend>
                <SwitchField
                  control={form.control}
                  name="jsonSchemaOutputs"
                  label="JSON schema outputs"
                  description="Use response_format json_schema. Turn off for servers that only support JSON mode."
                />
                <SwitchField
                  control={form.control}
                  name="sendTemperature"
                  label="Send temperature 0"
                  description="Turn off for endpoints that reject sampling parameters."
                />
                <Field data-invalid={!!errors.seed}>
                  <FieldLabel htmlFor="provider-seed">Seed</FieldLabel>
                  <Input
                    id="provider-seed"
                    inputMode="numeric"
                    className="max-w-40"
                    {...form.register("seed")}
                  />
                  <FieldDescription>Optional, for servers that support it.</FieldDescription>
                  <FieldError errors={[errors.seed]} />
                </Field>
              </FieldSet>
            )}
          </FieldGroup>
          <DialogFooter className="mt-6">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={save.isPending}>
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
