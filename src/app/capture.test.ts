import { afterEach, describe, expect, test } from "bun:test";
import { Effect, ManagedRuntime } from "effect";
import { Intake, type TriageResult } from "@/services/intake";
import { readThread, TODAY } from "@/test/helpers";
import { intakeTestLayer, out } from "@/test/intake-layer";
import { syncOnce } from "@/test/seed";
import {
  type CaptureDeps,
  captureStore,
  describeCapture,
  displayShortcut,
  onHiddenToTray,
  onOpenCaptureEvent,
  type Restore,
  submitCapture,
  TRAY_NOTICE,
} from "./capture";

afterEach(() => captureStore.close());

describe("open-capture event", () => {
  test("opens the dialog and remembers how to put the window back", () => {
    onOpenCaptureEvent({ restore: "hide" });
    expect(captureStore.get()).toMatchObject({ open: true, restore: "hide" });
    captureStore.close();
    expect(captureStore.get()).toMatchObject({ open: false, restore: null });
    onOpenCaptureEvent({ restore: "minimize" });
    expect(captureStore.get().restore).toBe("minimize");
  });

  test("a window that was already open stays open; a malformed payload still opens", () => {
    onOpenCaptureEvent({ restore: null });
    expect(captureStore.get()).toMatchObject({ open: true, restore: null });
    captureStore.close();
    onOpenCaptureEvent("garbage");
    expect(captureStore.get()).toMatchObject({ open: true, restore: null });
    captureStore.close();
    onOpenCaptureEvent({ restore: "explode" });
    expect(captureStore.get()).toMatchObject({ open: true, restore: null });
  });

  test("a second open while the dialog is up keeps the first restore", () => {
    onOpenCaptureEvent({ restore: "hide" });
    // The window is visible now, so a second shortcut press reports nothing to restore.
    onOpenCaptureEvent({ restore: null });
    expect(captureStore.get().restore).toBe("hide");
  });
});

describe("displayShortcut", () => {
  test("reads the accelerator as the platform's keys", () => {
    expect(displayShortcut("CommandOrControl+Shift+Space", false)).toBe("Ctrl+Shift+Space");
    expect(displayShortcut("CommandOrControl+Shift+Space", true)).toBe("Cmd+Shift+Space");
    expect(displayShortcut("CmdOrCtrl+Alt+C", true)).toBe("Cmd+Option+C");
    expect(displayShortcut("Super+K", false)).toBe("Super+K");
  });
});

const result = (r: Partial<TriageResult>): TriageResult => ({
  inboxItemId: "t1",
  items: 1,
  proposals: 0,
  questions: 0,
  ...r,
});

describe("describeCapture", () => {
  test("says what waits for the user", () => {
    expect(describeCapture(result({ proposals: 2 }))).toBe("Captured: 2 proposals to approve");
    expect(describeCapture(result({ proposals: 1, questions: 1 }))).toBe(
      "Captured: 1 proposal to approve and 1 question to answer",
    );
    expect(describeCapture(result({}))).toBe("Captured: nothing to do in that input");
  });
});

/** Fake window: records what capture did with it. */
function fakeDesktop(hidden: () => boolean) {
  const log: string[] = [];
  const deps: Omit<CaptureDeps, "triage"> = {
    restoreWindow: async (r: Restore) => void log.push(`restore:${r}`),
    windowHidden: async () => hidden(),
    notify: async (title, body) => void log.push(`notify:${title}:${body}`),
  };
  return { log, deps };
}

const text =
  "Hi Rick,\n\nPAY-2 is blocked on INC0012345 from Platform, can you move it to Blocked?\n\nThanks,\nAna";
const e = { rationale: "because", evidence: "blocked on INC0012345", confidence: 0.9 };
const answer = {
  summary: "PAY-2 is blocked on INC0012345",
  question: null,
  confidence: 0.9,
  proposals: [{ kind: "transition_issue", target: "PAY-2", toStatus: "To Do", ...e }],
};

describe("submitCapture", () => {
  test("files the thread, re-hides the window at once and notifies when triage ends hidden", async () => {
    const { layer } = intakeTestLayer({ "std-m": [out(answer)] });
    const rt = ManagedRuntime.make(layer);
    await rt.runPromise(syncOnce);
    const { log, deps } = fakeDesktop(() => log.includes("restore:hide"));
    const r = await submitCapture(
      { text, instruction: null, source: "teams", senderPersonId: null, today: TODAY },
      "hide",
      {
        ...deps,
        triage: (input) => {
          log.push("triage");
          return rt.runPromise(Effect.flatMap(Intake, (i) => i.triage(input)));
        },
      },
    );
    expect(r).toMatchObject({ items: 1, proposals: 1, questions: 0 });
    // Triage starts first, the window goes back before it finishes, one notification after.
    expect(log).toEqual([
      "triage",
      "restore:hide",
      "notify:Secretary:Captured: 1 proposal to approve",
    ]);
    const thread = await rt.runPromise(readThread(r.inboxItemId));
    expect(thread.item).toMatchObject({ status: "triaged", rawText: text, source: "teams" });
    expect(thread.props.map((p) => [p.kind, p.status])).toEqual([["transition_issue", "pending"]]);
    await rt.dispose();
  });

  test("no notification while the window is in sight, or when there is nothing to decide", async () => {
    const visible = fakeDesktop(() => false);
    await submitCapture({ text: "x", source: "typed", senderPersonId: null }, null, {
      ...visible.deps,
      triage: async () => result({ proposals: 3 }),
    });
    expect(visible.log).toEqual(["restore:null"]);

    const hidden = fakeDesktop(() => true);
    await submitCapture({ text: "x", source: "typed", senderPersonId: null }, "hide", {
      ...hidden.deps,
      triage: async () => result({}),
    });
    expect(hidden.log).toEqual(["restore:hide"]);
  });

  test("a failed triage while hidden says so and still rejects for the error toast", async () => {
    const { log, deps } = fakeDesktop(() => true);
    const failed = submitCapture({ text: "x", source: "typed", senderPersonId: null }, "hide", {
      ...deps,
      triage: async () => {
        throw new Error("provider down");
      },
    });
    await expect(failed).rejects.toThrow("provider down");
    expect(log).toEqual([
      "restore:hide",
      "notify:Capture not triaged:It is in the Inbox; open it there to retry.",
    ]);
  });

  test("a window that cannot be restored does not stop the capture", async () => {
    const r = await submitCapture({ text: "x", source: "typed", senderPersonId: null }, "hide", {
      triage: async () => result({ proposals: 1 }),
      restoreWindow: async () => {
        throw new Error("no window");
      },
      windowHidden: async () => {
        throw new Error("no window");
      },
      notify: async () => {
        throw new Error("unreachable");
      },
    });
    expect(r.proposals).toBe(1);
  });
});

describe("tray notice (D48)", () => {
  /** A settings flag and a notifier that records what was sent. */
  const desktop = (opts: { shown?: boolean; allowed?: boolean } = {}) => {
    let shown = opts.shown ?? false;
    const sent: string[] = [];
    return {
      sent,
      isShown: () => shown,
      deps: {
        shown: async () => shown,
        markShown: async () => {
          shown = true;
        },
        notify: async (title: string, body: string) => {
          if (opts.allowed === false) return false;
          sent.push(`${title}: ${body}`);
          return true;
        },
      },
    };
  };

  test("the first hide to the tray says so, and later ones do not", async () => {
    const d = desktop();
    await onHiddenToTray(d.deps);
    await onHiddenToTray(d.deps);
    expect(d.sent).toEqual([`${TRAY_NOTICE.title}: ${TRAY_NOTICE.body}`]);
    expect(TRAY_NOTICE.body).toContain("Quit from the tray menu");
    expect(d.isShown()).toBe(true);
  });

  test("nothing is sent once the flag is set", async () => {
    const d = desktop({ shown: true });
    await onHiddenToTray(d.deps);
    expect(d.sent).toEqual([]);
  });

  test("a refused notification does not use the notice up", async () => {
    const d = desktop({ allowed: false });
    await onHiddenToTray(d.deps);
    expect(d.isShown()).toBe(false);
  });

  test("two closes in quick succession send one notice", async () => {
    const d = desktop();
    await Promise.all([onHiddenToTray(d.deps), onHiddenToTray(d.deps)]);
    expect(d.sent).toHaveLength(1);
  });

  test("a failed settings read sends nothing and lets the next close try again", async () => {
    const d = desktop();
    await expect(
      onHiddenToTray({
        ...d.deps,
        shown: async () => {
          throw new Error("store unreadable");
        },
      }),
    ).rejects.toThrow("store unreadable");
    expect(d.sent).toEqual([]);
    await onHiddenToTray(d.deps);
    expect(d.sent).toHaveLength(1);
  });
});
