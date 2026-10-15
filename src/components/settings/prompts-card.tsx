import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { zodResolver } from "@hookform/resolvers/zod";
import { Link } from "@tanstack/react-router";
import { GripVertical, Plus, RotateCcw, Trash2 } from "lucide-react";
import { type ReactNode, useEffect } from "react";
import { useFieldArray, useForm } from "react-hook-form";
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
import { FieldError } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { newId } from "@/lib/ids";
import { cn } from "@/lib/utils";
import { DEFAULT_SUGGESTED_PROMPTS } from "@/services/settings/schema";

// Same limits as SuggestedPromptSchema in settings, with messages for the form.
const MAX_PROMPTS = 12;
const TITLE_MAX = 40;
const MESSAGE_MAX = 1000;

const Form = z.object({
  prompts: z
    .array(
      z.object({
        id: z.string().min(1),
        title: z
          .string()
          .trim()
          .min(1, "Enter a title")
          .max(TITLE_MAX, `At most ${TITLE_MAX} characters`),
        message: z
          .string()
          .trim()
          .min(1, "Enter a message")
          .max(MESSAGE_MAX, `At most ${MESSAGE_MAX} characters`),
      }),
    )
    .max(MAX_PROMPTS),
});
type FormValues = z.infer<typeof Form>;

const defaults = () => DEFAULT_SUGGESTED_PROMPTS.map((p) => ({ ...p }));

/** Edits the chat's one-click questions (D42; on the Chat page only since D49). */
export function PromptsCard() {
  const { data: settings } = useSettings();
  const update = useUpdateSettings();
  const form = useForm<FormValues>({
    resolver: zodResolver(Form),
    defaultValues: { prompts: [] },
  });
  // `key`, not the default `id`: the prompts carry their own ids.
  const { fields, append, remove, move, replace } = useFieldArray({
    control: form.control,
    name: "prompts",
    keyName: "key",
  });
  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  useEffect(() => {
    if (settings) form.reset({ prompts: settings.suggestedPrompts.map((p) => ({ ...p })) });
  }, [settings, form]);

  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    const from = fields.findIndex((f) => f.key === active.id);
    const to = fields.findIndex((f) => f.key === over.id);
    if (from >= 0 && to >= 0) move(from, to);
  };

  const onSubmit = form.handleSubmit((values) =>
    update.mutate((s) => ({ ...s, suggestedPrompts: values.prompts }), {
      onSuccess: () => toast.success("Saved"),
    }),
  );

  const errors = form.formState.errors.prompts;
  const full = fields.length >= MAX_PROMPTS;

  return (
    <Card>
      <form onSubmit={onSubmit}>
        <CardHeader>
          <CardTitle>Suggested prompts</CardTitle>
          <CardDescription>
            One-click questions on the{" "}
            <Link to="/chat" className="underline">
              Chat
            </Link>{" "}
            page. Each starts a new chat with its message. Drag to reorder.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          {fields.length > 0 && (
            <div className="grid grid-cols-[1.5rem_10rem_1fr_2rem] gap-2 text-xs font-medium text-muted-foreground">
              <span />
              <span>Title</span>
              <span>Message</span>
            </div>
          )}
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
            <SortableContext
              items={fields.map((f) => f.key)}
              strategy={verticalListSortingStrategy}
            >
              <ul className="flex flex-col gap-2">
                {fields.map((f, i) => (
                  <SortableRow key={f.key} id={f.key} label={`prompt ${i + 1}`}>
                    <div className="flex flex-col gap-1">
                      <Input
                        aria-label={`Title of prompt ${i + 1}`}
                        maxLength={TITLE_MAX}
                        aria-invalid={!!errors?.[i]?.title}
                        {...form.register(`prompts.${i}.title`)}
                      />
                      <FieldError errors={[errors?.[i]?.title]} />
                    </div>
                    <div className="flex flex-col gap-1">
                      <Textarea
                        aria-label={`Message of prompt ${i + 1}`}
                        rows={1}
                        className="min-h-8"
                        maxLength={MESSAGE_MAX}
                        aria-invalid={!!errors?.[i]?.message}
                        {...form.register(`prompts.${i}.message`)}
                      />
                      <FieldError errors={[errors?.[i]?.message]} />
                    </div>
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      aria-label={`Delete prompt ${i + 1}`}
                      onClick={() => remove(i)}
                    >
                      <Trash2 />
                    </Button>
                  </SortableRow>
                ))}
              </ul>
            </SortableContext>
          </DndContext>
          {fields.length === 0 && (
            <p className="text-sm text-muted-foreground">
              No suggested prompts. The Chat page offers none until you add some.
            </p>
          )}
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="link"
              className="px-0"
              disabled={full}
              onClick={() => append({ id: newId(), title: "", message: "" })}
            >
              <Plus /> Add a suggested prompt
            </Button>
            {full && <span className="text-xs text-muted-foreground">At most {MAX_PROMPTS}.</span>}
          </div>
        </CardContent>
        <CardFooter className="mt-4 gap-2">
          <Button type="submit" disabled={!form.formState.isDirty || update.isPending}>
            Save
          </Button>
          <Button type="button" variant="outline" onClick={() => replace(defaults())}>
            <RotateCcw /> Reset to defaults
          </Button>
        </CardFooter>
      </form>
    </Card>
  );
}

function SortableRow({ id, label, children }: { id: string; label: string; children: ReactNode }) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id });
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn(
        "grid grid-cols-[1.5rem_10rem_1fr_2rem] items-start gap-2 rounded-md bg-card",
        isDragging && "relative z-10 shadow-md",
      )}
    >
      <button
        type="button"
        ref={setActivatorNodeRef}
        aria-label={`Reorder ${label}`}
        className="mt-2 flex cursor-grab touch-none items-center justify-center rounded-sm text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none active:cursor-grabbing"
        {...attributes}
        {...listeners}
      >
        <GripVertical className="size-4" />
      </button>
      {children}
    </li>
  );
}
