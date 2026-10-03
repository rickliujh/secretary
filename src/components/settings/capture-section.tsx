import { zodResolver } from "@hookform/resolvers/zod";
import { Info } from "lucide-react";
import { useEffect } from "react";
import { Controller, useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { displayShortcut, useCaptureState } from "@/app/capture";
import { useSettings, useUpdateSettings } from "@/app/hooks";
import { inTauri, isMac } from "@/app/platform";
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
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { DEFAULT_CAPTURE_SHORTCUT } from "@/services/settings/schema";

const Form = z.object({
  shortcut: z.string().trim().max(60, "At most 60 characters"),
  closeToTray: z.boolean(),
});
type Values = z.infer<typeof Form>;

const code = "rounded bg-muted px-1 font-mono text-xs";

/** Quick capture and the tray (D48): the shortcut, close-to-tray, and what this desktop allows. */
export function CaptureSection() {
  const { data: settings } = useSettings();
  const update = useUpdateSettings();
  const { native, shortcut: registration } = useCaptureState();
  const form = useForm<Values>({
    resolver: zodResolver(Form),
    defaultValues: { shortcut: DEFAULT_CAPTURE_SHORTCUT, closeToTray: true },
  });
  useEffect(() => {
    if (settings) form.reset(settings.capture);
  }, [settings, form]);

  const onSubmit = form.handleSubmit((values) =>
    update.mutate((s) => ({ ...s, capture: values }), {
      onSuccess: () => toast.success("Saved"),
    }),
  );
  const noTray = native && !native.tray;

  return (
    <Card>
      <form onSubmit={onSubmit}>
        <CardHeader>
          <CardTitle>Capture and tray</CardTitle>
          <CardDescription>
            Capture files a message or task in the Inbox without leaving what you are doing. Open it
            from Ctrl+K, the tray menu, the shortcut below, or by running{" "}
            <code className={code}>secretary --capture</code>.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {!inTauri && (
            <p className="text-sm text-muted-foreground">
              The tray and the shortcut work in the desktop app only.
            </p>
          )}
          <Controller
            control={form.control}
            name="closeToTray"
            render={({ field }) => (
              <Field orientation="horizontal">
                <Switch
                  id="closeToTray"
                  checked={field.value}
                  onCheckedChange={field.onChange}
                  disabled={!!noTray}
                />
                <FieldLabel htmlFor="closeToTray">Keep running in the tray when closed</FieldLabel>
              </Field>
            )}
          />
          <FieldDescription className="-mt-2">
            Sync, reminders and the shortcut keep working; Quit is in the tray menu.
            {isMac
              ? " The Dock icon brings the window back."
              : " On GNOME, tray icons need the AppIndicator extension."}
          </FieldDescription>
          {noTray && (
            <Alert>
              <Info />
              <AlertTitle>No tray icon</AlertTitle>
              <AlertDescription>
                <p>
                  {native.trayError ?? "The tray could not be created."} Closing the window quits
                  the app.
                </p>
                <p>
                  On Debian or Ubuntu install{" "}
                  <code className={code}>libayatana-appindicator3-1</code>, on Fedora{" "}
                  <code className={code}>libayatana-appindicator-gtk3</code>, on Arch{" "}
                  <code className={code}>libayatana-appindicator</code>, then restart Secretary.
                </p>
              </AlertDescription>
            </Alert>
          )}
          <Field data-invalid={!!form.formState.errors.shortcut}>
            <FieldLabel htmlFor="captureShortcut">Capture shortcut</FieldLabel>
            <div className="flex flex-wrap items-center gap-2">
              <Input
                id="captureShortcut"
                className="max-w-xs font-mono"
                placeholder="Off"
                {...form.register("shortcut")}
              />
              <ShortcutBadge registration={registration} wayland={!!native?.wayland} />
            </div>
            <FieldDescription>
              Works from any app. Write it as Tauri accelerators, such as{" "}
              <code className={code}>{DEFAULT_CAPTURE_SHORTCUT}</code> or{" "}
              <code className={code}>Alt+Shift+C</code>; leave it blank to turn it off.
            </FieldDescription>
            <FieldError errors={[form.formState.errors.shortcut]} />
          </Field>
          {native?.wayland ? (
            <Alert>
              <Info />
              <AlertTitle>Global shortcuts are not available on Wayland</AlertTitle>
              <AlertDescription>
                <p>
                  Bind <code className={code}>secretary --capture</code> to a key in your desktop's
                  own settings instead (GNOME: Settings, Keyboard, Custom Shortcuts; KDE: System
                  Settings, Shortcuts, Custom Shortcuts). With Secretary running, the key opens
                  Capture; otherwise it starts Secretary with Capture open.
                </p>
              </AlertDescription>
            </Alert>
          ) : (
            registration?.error && (
              <Alert variant="destructive">
                <Info />
                <AlertTitle>The shortcut was not registered</AlertTitle>
                <AlertDescription>
                  <p>
                    {registration.error.replace(/\.$/, "")}. Another app may use it; try another
                    combination, or bind <code className={code}>secretary --capture</code> in your
                    system's keyboard settings.
                  </p>
                </AlertDescription>
              </Alert>
            )
          )}
        </CardContent>
        <CardFooter className="mt-4">
          <Button type="submit" disabled={!form.formState.isDirty || update.isPending}>
            Save
          </Button>
        </CardFooter>
      </form>
    </Card>
  );
}

function ShortcutBadge({
  registration,
  wayland,
}: {
  registration: ReturnType<typeof useCaptureState>["shortcut"];
  wayland: boolean;
}) {
  if (!inTauri || !registration) return null;
  if (registration.registered)
    return <Badge variant="secondary">On: {displayShortcut(registration.registered, isMac)}</Badge>;
  if (registration.error)
    return <Badge variant="outline">{wayland ? "Not available" : "Not registered"}</Badge>;
  return <Badge variant="outline">Off</Badge>;
}
