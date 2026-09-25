import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Effect } from "effect";
import { KeyRound } from "lucide-react";
import { useEffect } from "react";
import { Controller, useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { useErrorToast, useSecretStatus, useSettings, useUpdateSettings } from "@/app/hooks";
import { queryKeys } from "@/app/query-client";
import { run } from "@/app/runtime";
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
import { Secrets, secretNames } from "@/services/secrets";

const Form = z
  .object({
    proxyMode: z.enum(["system", "manual"]),
    proxyUrl: z.union([
      z.literal(""),
      z.url({
        protocol: /^(https?|socks5h?)$/,
        error: "Use http://host:port (or https://, socks5://)",
      }),
    ]),
    noProxy: z.string(),
    proxyUsername: z.string().trim(),
    proxyPassword: z.string(),
  })
  .refine((v) => v.proxyMode !== "manual" || v.proxyUrl !== "", {
    path: ["proxyUrl"],
    message: "Enter the proxy address",
  });
type Values = z.infer<typeof Form>;

/** Proxy for Jira, Confluence and model requests. */
export function NetworkSection() {
  const { data: settings } = useSettings();
  const update = useUpdateSettings();
  const client = useQueryClient();
  const onError = useErrorToast();
  const passwordStatus = useSecretStatus(secretNames.proxyPassword);
  const form = useForm<Values>({
    resolver: zodResolver(Form),
    defaultValues: {
      proxyMode: "system",
      proxyUrl: "",
      noProxy: "localhost,127.0.0.1",
      proxyUsername: "",
      proxyPassword: "",
    },
  });
  useEffect(() => {
    if (settings) form.reset({ ...settings.network, proxyPassword: "" });
  }, [settings, form]);
  const mode = form.watch("proxyMode");

  const save = useMutation({
    mutationFn: async (v: Values) => {
      if (v.proxyPassword)
        await run(
          Effect.flatMap(Secrets, (s) => s.set(secretNames.proxyPassword, v.proxyPassword)),
        );
      if (!v.proxyUsername)
        await run(Effect.flatMap(Secrets, (s) => s.remove(secretNames.proxyPassword)));
      const { proxyPassword: _p, ...network } = v;
      await update.mutateAsync((s) => ({ ...s, network }));
    },
    onSuccess: () => {
      void client.invalidateQueries({
        queryKey: queryKeys.secretStatus(secretNames.proxyPassword),
      });
      toast.success("Network settings saved; they apply to the next request.");
    },
    onError: (e) => onError(e),
  });
  const e = form.formState.errors;

  return (
    <Card>
      <form onSubmit={form.handleSubmit((v) => save.mutate(v))}>
        <CardHeader>
          <CardTitle>Network</CardTitle>
          <CardDescription>
            Proxy for Jira, Confluence and model providers. Certificates installed on this computer
            (for example a company TLS inspection certificate) are trusted automatically.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <FieldGroup>
            <Controller
              control={form.control}
              name="proxyMode"
              render={({ field }) => (
                <Field>
                  <FieldLabel htmlFor="proxy-mode">Proxy</FieldLabel>
                  <Select value={field.value} onValueChange={field.onChange}>
                    <SelectTrigger id="proxy-mode" className="w-72">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="system">
                        System (environment and manual OS proxy)
                      </SelectItem>
                      <SelectItem value="manual">Manual</SelectItem>
                    </SelectContent>
                  </Select>
                  <FieldDescription>
                    System mode does not read automatic proxy configuration (PAC) files. If your
                    computer uses one, choose Manual and enter the proxy it returns.
                  </FieldDescription>
                </Field>
              )}
            />
            {mode === "manual" && (
              <>
                <Field data-invalid={!!e.proxyUrl}>
                  <FieldLabel htmlFor="proxy-url">Proxy address</FieldLabel>
                  <Input
                    id="proxy-url"
                    placeholder="http://127.0.0.1:9000"
                    className="font-mono"
                    {...form.register("proxyUrl")}
                  />
                  <FieldError errors={[e.proxyUrl]} />
                </Field>
                <Field>
                  <FieldLabel htmlFor="proxy-bypass">Bypass for</FieldLabel>
                  <Input id="proxy-bypass" className="font-mono" {...form.register("noProxy")} />
                  <FieldDescription>
                    Comma separated. Keep localhost if a model provider runs on this computer.
                  </FieldDescription>
                </Field>
                <div className="grid grid-cols-2 gap-4">
                  <Field>
                    <FieldLabel htmlFor="proxy-user">Username (optional)</FieldLabel>
                    <Input id="proxy-user" autoComplete="off" {...form.register("proxyUsername")} />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="proxy-pass">
                      Password
                      {passwordStatus.data && (
                        <Badge variant="secondary" className="ml-2">
                          <KeyRound /> In keychain
                        </Badge>
                      )}
                    </FieldLabel>
                    <Input
                      id="proxy-pass"
                      type="password"
                      autoComplete="off"
                      placeholder={passwordStatus.data ? "Leave blank to keep" : ""}
                      {...form.register("proxyPassword")}
                    />
                  </Field>
                </div>
              </>
            )}
          </FieldGroup>
        </CardContent>
        <CardFooter className="mt-4">
          <Button type="submit" disabled={save.isPending}>
            Save
          </Button>
        </CardFooter>
      </form>
    </Card>
  );
}
