import { zodResolver } from "@hookform/resolvers/zod";
import { useEffect } from "react";
import { Controller, useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { useSettings, useUpdateSettings } from "@/app/hooks";
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
import { Switch } from "@/components/ui/switch";
import {
  type AppSettings,
  DAY_END_TIME,
  DEFAULT_DAY_END_AT,
  INSTRUCTION_NAMES,
  type InstructionName,
  RULE_NAMES,
  type RuleName,
  WorkSettingsSchema,
} from "@/services/settings/schema";
import { INSTRUCTION_LABELS } from "@/services/work/playbooks/instructions";
import { RULE_LABELS } from "@/services/work/rules";

const whole = (schema: z.ZodNumber, message: string) =>
  z
    .string()
    .trim()
    .refine((v) => /^\d+$/.test(v) && schema.safeParse(Number(v)).success, { message });

const shape = WorkSettingsSchema.shape;
const Form = z.object({
  enabled: z.boolean(),
  questionsPerDay: whole(shape.questionsPerDay.unwrap(), "A whole number from 0 to 50"),
  stateCallsPerDay: whole(shape.stateCallsPerDay.unwrap(), "A whole number from 0 to 1000"),
  groupSizeCap: whole(shape.groupSizeCap.unwrap(), "A whole number from 2 to 50"),
});
type Values = z.infer<typeof Form>;

const toValues = (s: AppSettings): Values => ({
  enabled: s.work.enabled,
  questionsPerDay: String(s.work.questionsPerDay),
  stateCallsPerDay: String(s.work.stateCallsPerDay),
  groupSizeCap: String(s.work.groupSizeCap),
});

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * The consequence rules' switches (FR-19.6, Phase 25): each offers outcome
 * cards when its fact changes. A switch saves at once.
 */
function RuleSwitches() {
  const { data: settings } = useSettings();
  const update = useUpdateSettings();
  const rules = settings?.secretary.rules;
  const set = (rule: RuleName, on: boolean) =>
    update.mutate((s) => ({
      ...s,
      secretary: { ...s.secretary, rules: { ...s.secretary.rules, [rule]: on } },
    }));
  return (
    <Card>
      <CardHeader>
        <CardTitle>Follow-ups</CardTitle>
        <CardDescription>
          When a fact changes, the secretary works out what else is now out of date and offers the
          follow-ups as one card in the Inbox and on Today, each step one you can leave out, with
          one Approve. Nothing runs until you approve it. A kind you dismiss twice on the same work
          item goes quiet there; ask for it again from the item's Work tab.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <FieldGroup>
          {RULE_NAMES.map((rule) => (
            <Field key={rule} orientation="horizontal">
              <Switch
                id={`rule-${rule}`}
                checked={rules?.[rule] ?? true}
                disabled={!rules || update.isPending || settings?.work.enabled === false}
                onCheckedChange={(on) => set(rule, on)}
              />
              <div className="flex flex-col gap-0.5">
                <FieldLabel htmlFor={`rule-${rule}`}>{capital(RULE_LABELS[rule].name)}</FieldLabel>
                <FieldDescription>{RULE_LABELS[rule].offers}</FieldDescription>
              </div>
            </Field>
          ))}
        </FieldGroup>
      </CardContent>
    </Card>
  );
}

/**
 * Standing instructions (FR-19.7, Phase 26): switches the playbooks read when
 * they turn a situation into its chores. A switch saves at once.
 */
function InstructionSwitches() {
  const { data: settings } = useSettings();
  const update = useUpdateSettings();
  const instructions = settings?.secretary.instructions;
  const set = (name: InstructionName, on: boolean) =>
    update.mutate((s) => ({
      ...s,
      secretary: {
        ...s.secretary,
        instructions: { ...s.secretary.instructions, [name]: on },
      },
    }));
  return (
    <Card>
      <CardHeader>
        <CardTitle>Standing instructions</CardTitle>
        <CardDescription>
          What the secretary does on its own initiative when you wait on someone, a wait ends, a
          chase is due or you finish a ticket. Each chore is a step on the card you approve; leave
          the same step out twice and it offers to make that the rule here.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <FieldGroup>
          {INSTRUCTION_NAMES.map((name) => (
            <Field key={name} orientation="horizontal">
              <Switch
                id={`instruction-${name}`}
                checked={instructions?.[name] ?? false}
                disabled={!instructions || update.isPending || settings?.work.enabled === false}
                onCheckedChange={(on) => set(name, on)}
              />
              <div className="flex flex-col gap-0.5">
                <FieldLabel htmlFor={`instruction-${name}`}>
                  {INSTRUCTION_LABELS[name].name}
                </FieldLabel>
                <FieldDescription>{INSTRUCTION_LABELS[name].line}</FieldDescription>
              </div>
            </Field>
          ))}
        </FieldGroup>
      </CardContent>
    </Card>
  );
}

/** The two switches of D62 (Phase 27), each saved at once. */
const WHERE_YOU_ARE = [
  {
    name: "suggestions",
    label: "Suggest next moves where I am",
    line: "The Work tab, Today's \"You're on\" panel and the Drafts page list the next moves of the work item, ranked by their dates. Code ranks them; no model is asked.",
  },
  {
    name: "parkInput",
    label: "Offer to park input about other work",
    line: "While you are on a work item, an Inbox thread about other work shows Park. A parked thread keeps its proposals pending and comes back when you finish, move on, or tomorrow.",
  },
] as const;

/**
 * Suggestions where the user is (FR-19.8, D62): next moves, and parking input
 * about other work while an item is current. A switch saves at once.
 */
function WhereYouAre() {
  const { data: settings } = useSettings();
  const update = useUpdateSettings();
  const secretary = settings?.secretary;
  const set = (name: (typeof WHERE_YOU_ARE)[number]["name"], on: boolean) =>
    update.mutate((s) => ({ ...s, secretary: { ...s.secretary, [name]: on } }));
  return (
    <Card>
      <CardHeader>
        <CardTitle>Where you are</CardTitle>
        <CardDescription>
          Say "I'm on this now" on a work item (its Work tab, or in the chat) and the secretary
          keeps you on it for the day: what to do next, and other work set aside until you are done.
          Nothing is decided for you; parking happens only when you press Park.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <FieldGroup>
          {WHERE_YOU_ARE.map((x) => (
            <Field key={x.name} orientation="horizontal">
              <Switch
                id={`where-${x.name}`}
                checked={secretary?.[x.name] ?? true}
                disabled={!secretary || update.isPending || settings?.work.enabled === false}
                onCheckedChange={(on) => set(x.name, on)}
              />
              <div className="flex flex-col gap-0.5">
                <FieldLabel htmlFor={`where-${x.name}`}>{x.label}</FieldLabel>
                <FieldDescription>{x.line}</FieldDescription>
              </div>
            </Field>
          ))}
        </FieldGroup>
      </CardContent>
    </Card>
  );
}

const DayEndForm = z.object({
  enabled: z.boolean(),
  at: z.string().trim().regex(DAY_END_TIME, "A time such as 17:30"),
});
type DayEndValues = z.infer<typeof DayEndForm>;

/**
 * The end-of-day pass at a set time (FR-19.9, D63): a switch and a local
 * time. It runs only while the app is open then, once a day; Today's "End of
 * day" button and the chat run it at any time.
 */
function DayEndCard() {
  const { data: settings } = useSettings();
  const update = useUpdateSettings();
  const form = useForm<DayEndValues>({
    resolver: zodResolver(DayEndForm),
    defaultValues: { enabled: false, at: DEFAULT_DAY_END_AT },
  });
  useEffect(() => {
    if (settings) form.reset(settings.secretary.dayEnd);
  }, [settings, form]);
  const off = settings?.work.enabled === false;
  const error = form.formState.errors.at;
  const save = form.handleSubmit((v) =>
    update.mutate(
      (s) => ({ ...s, secretary: { ...s.secretary, dayEnd: { enabled: v.enabled, at: v.at } } }),
      { onSuccess: () => toast.success("End of day saved") },
    ),
  );
  return (
    <Card>
      <form onSubmit={save}>
        <CardHeader>
          <CardTitle>End of day</CardTitle>
          <CardDescription>
            A page in the Inbox with what changed on each work item today, what is due tomorrow, and
            the questions held back during the day. Code writes it; no model is asked and nothing
            changes in Jira. Run it from Today or ask the chat to wrap up your day, or have it run
            at a set time while the app is open.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <FieldGroup>
            <Controller
              control={form.control}
              name="enabled"
              render={({ field }) => (
                <Field orientation="horizontal">
                  <Switch
                    id="day-end-enabled"
                    checked={field.value}
                    disabled={off}
                    onCheckedChange={field.onChange}
                  />
                  <FieldLabel htmlFor="day-end-enabled">Run it every day at a set time</FieldLabel>
                </Field>
              )}
            />
            <Field data-invalid={!!error}>
              <FieldLabel htmlFor="day-end-at">Time</FieldLabel>
              <Input
                id="day-end-at"
                type="time"
                className="w-32"
                disabled={off}
                {...form.register("at")}
              />
              <FieldDescription>
                If the app is closed then, it does not run later that day.
              </FieldDescription>
              <FieldError errors={[error]} />
            </Field>
          </FieldGroup>
        </CardContent>
        <CardFooter className="mt-4">
          <Button type="submit" disabled={update.isPending || off}>
            Save
          </Button>
        </CardFooter>
      </form>
    </Card>
  );
}

/**
 * Settings > Secretary (D61): the work model's switch and budgets, where you
 * are (D62), the end of day (D63), the follow-up rules, and the standing
 * instructions below them.
 */
export function SecretarySection() {
  return (
    <div className="flex flex-col gap-6">
      <WorkCard />
      <WhereYouAre />
      <DayEndCard />
      <RuleSwitches />
      <InstructionSwitches />
    </div>
  );
}

function WorkCard() {
  const { data: settings } = useSettings();
  const update = useUpdateSettings();
  const form = useForm<Values>({
    resolver: zodResolver(Form),
    defaultValues: {
      enabled: true,
      questionsPerDay: "3",
      stateCallsPerDay: "60",
      groupSizeCap: "8",
    },
  });
  useEffect(() => {
    if (settings) form.reset(toValues(settings));
  }, [settings, form]);
  const errors = form.formState.errors;
  const save = form.handleSubmit((v) =>
    update.mutate(
      (s) => ({
        ...s,
        work: {
          enabled: v.enabled,
          questionsPerDay: Number(v.questionsPerDay),
          stateCallsPerDay: Number(v.stateCallsPerDay),
          groupSizeCap: Number(v.groupSizeCap),
        },
      }),
      { onSuccess: () => toast.success("Secretary settings saved") },
    ),
  );
  const number = (
    name: "questionsPerDay" | "stateCallsPerDay" | "groupSizeCap",
    label: string,
    description: string,
  ) => (
    <Field data-invalid={!!errors[name]}>
      <FieldLabel htmlFor={`work-${name}`}>{label}</FieldLabel>
      <Input id={`work-${name}`} inputMode="numeric" className="w-32" {...form.register(name)} />
      <FieldDescription>{description}</FieldDescription>
      <FieldError errors={[errors[name]]} />
    </Field>
  );
  return (
    <Card>
      <form onSubmit={save}>
        <CardHeader>
          <CardTitle>Your work</CardTitle>
          <CardDescription>
            The secretary groups your active tickets into work items, records what happens to each,
            keeps a short status note, and asks when it is not sure. It all stays on this computer;
            nothing here writes to Jira.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <FieldGroup>
            <Controller
              control={form.control}
              name="enabled"
              render={({ field }) => (
                <Field orientation="horizontal">
                  <Switch
                    id="work-enabled"
                    checked={field.value}
                    onCheckedChange={field.onChange}
                  />
                  <FieldLabel htmlFor="work-enabled">Keep track of my work items</FieldLabel>
                </Field>
              )}
            />
            {number(
              "questionsPerDay",
              "Questions a day",
              "Questions about your work items, beyond those in the Inbox thread you are in. The most important come first; the rest wait for the next day.",
            )}
            {number(
              "stateCallsPerDay",
              "Status updates a day",
              "Model calls that bring work items up to date. When they run out, items catch up the next day.",
            )}
            {number(
              "groupSizeCap",
              "Most tickets in one item",
              "A group would be larger: the secretary keeps it apart and asks you instead.",
            )}
          </FieldGroup>
        </CardContent>
        <CardFooter className="mt-4">
          <Button type="submit" disabled={update.isPending}>
            Save
          </Button>
        </CardFooter>
      </form>
    </Card>
  );
}
