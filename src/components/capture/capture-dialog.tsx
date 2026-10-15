import { useNavigate } from "@tanstack/react-router";
import { Effect } from "effect";
import { toast } from "sonner";
import { captureStore, describeCapture, submitCapture, useCaptureState } from "@/app/capture";
import { notify, restoreWindow, windowHidden } from "@/app/capture-native";
import { useErrorToast } from "@/app/hooks";
import { run } from "@/app/runtime";
import { Composer, type ComposerMessage, toTriageInput } from "@/components/inbox/composer";
import { useInvalidateAfterDecision } from "@/components/inbox/use-inbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Intake } from "@/services/intake";

/**
 * Quick capture (D48): the Inbox composer in a dialog, opened from Ctrl+K, the
 * tray, the global shortcut and `--capture`. Sending files a new thread and closes
 * the dialog; triage runs in the background.
 */
export function CaptureDialog() {
  const { open, restore } = useCaptureState();
  const navigate = useNavigate();
  const onError = useErrorToast();
  const invalidate = useInvalidateAfterDecision();

  const send = (m: ComposerMessage) => {
    captureStore.close();
    void submitCapture(toTriageInput(m), restore, {
      triage: (input) => run(Effect.flatMap(Intake, (i) => i.triage(input))),
      restoreWindow,
      windowHidden,
      notify,
    })
      .then((r) =>
        toast.success(describeCapture(r), {
          action: {
            label: "Open",
            onClick: () => navigate({ to: "/inbox", search: { item: r.inboxItemId } }),
          },
        }),
      )
      .catch((e) => onError(e))
      .finally(invalidate);
  };

  // Leaving without sending also puts the window back where capture found it.
  const dismiss = () => {
    captureStore.close();
    void restoreWindow(restore).catch(() => undefined);
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && dismiss()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Capture</DialogTitle>
          <DialogDescription>
            Paste a message or type a task. It goes to the Inbox and is read in the background;
            nothing is written to Jira until you approve.
          </DialogDescription>
        </DialogHeader>
        <Composer withSender busy={false} onSend={send} />
      </DialogContent>
    </Dialog>
  );
}
