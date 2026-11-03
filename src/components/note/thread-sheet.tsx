/**
 * A conversation of the note, opened on the Note page (FR-20.7, D67): the
 * Inbox's own thread view in a sheet on the right, with its cards, questions
 * and composer. A reply here is a turn of the same thread the Inbox shows.
 */
import { useState } from "react";
import { ThreadView } from "@/components/inbox/thread-view";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";

export function ThreadSheet({ id, onClose }: { id: string | null; onClose: () => void }) {
  // The last thread stays in the sheet while it slides out.
  const [shown, setShown] = useState(id);
  if (id && id !== shown) setShown(id);
  const thread = id ?? shown;
  return (
    <Sheet open={!!id} onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="w-full gap-0 sm:max-w-2xl">
        <SheetHeader className="sr-only">
          <SheetTitle>Conversation on this line</SheetTitle>
          <SheetDescription>The thread this line of your note led to.</SheetDescription>
        </SheetHeader>
        <div className="flex min-h-0 flex-1 flex-col p-4 pt-10">
          {thread && <ThreadView key={thread} id={thread} />}
        </div>
      </SheetContent>
    </Sheet>
  );
}
