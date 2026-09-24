import type { MessageId, OrchestrationPinnedMessage } from "@t3tools/contracts";
import { PinIcon, PinOffIcon } from "lucide-react";
import { createContext, memo, use, useMemo, useState } from "react";

import type { ChatMessage } from "../../types";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export interface MessagePinState {
  readonly pinnedIds: ReadonlySet<string>;
  readonly onToggle: (message: ChatMessage) => void;
}

/**
 * Kept apart from the timeline's shared row context so a pin change re-renders
 * only the pin buttons. Null where the server cannot pin messages.
 */
export const MessagePinCtx = createContext<MessagePinState | null>(null);

/** Pin toggle shown beside a message's Copy button. */
export const MessagePinButton = memo(function MessagePinButton({
  message,
}: {
  message: ChatMessage;
}) {
  const pins = use(MessagePinCtx);
  if (!pins || message.streaming || message.role === "system") return null;
  const pinned = pins.pinnedIds.has(message.id);
  const label = pinned ? "Unpin message" : "Pin message";
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            aria-label={label}
            aria-pressed={pinned}
            type="button"
            size="xs"
            variant="ghost"
            onClick={() => pins.onToggle(message)}
            className={cn(
              "text-muted-foreground hover:text-foreground",
              pinned && "text-primary hover:text-primary",
            )}
          />
        }
      >
        <PinIcon className={cn("size-3", pinned && "fill-current")} />
      </TooltipTrigger>
      <TooltipPopup>
        <p>{label}</p>
      </TooltipPopup>
    </Tooltip>
  );
});

function formatPinnedMessageTime(iso: string): string {
  const date = new Date(iso);
  const sameDay = date.toDateString() === new Date().toDateString();
  return sameDay
    ? date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
    : date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** Header button listing the thread's pinned messages, newest pin first. */
export function PinnedMessagesButton({
  pins,
  onJump,
  onUnpin,
}: {
  pins: ReadonlyArray<OrchestrationPinnedMessage>;
  onJump: (messageId: MessageId) => void;
  onUnpin: (messageId: MessageId) => void;
}) {
  const [open, setOpen] = useState(false);
  const newestFirst = useMemo(() => pins.toReversed(), [pins]);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger
          render={
            <PopoverTrigger
              render={
                <Button
                  aria-label={`Pinned messages (${pins.length})`}
                  size={pins.length > 0 ? "xs" : "icon-xs"}
                  variant="ghost"
                  className="gap-1 text-muted-foreground hover:text-foreground"
                />
              }
            />
          }
        >
          <PinIcon aria-hidden className="size-3.5" />
          {pins.length > 0 ? <span className="tabular-nums">{pins.length}</span> : null}
        </TooltipTrigger>
        <TooltipPopup side="bottom">Pinned messages</TooltipPopup>
      </Tooltip>
      <PopoverPopup
        align="end"
        className="w-80"
        viewportClassName="py-2 [--viewport-inline-padding:--spacing(1)]"
      >
        <p className="px-2 pb-1.5 font-medium text-muted-foreground text-xs">Pinned messages</p>
        {newestFirst.length === 0 ? (
          <p className="px-2 pb-1 text-muted-foreground text-sm">
            No pinned messages yet. Hover a message and use the pin next to Copy.
          </p>
        ) : (
          <ul className="flex max-h-96 flex-col gap-0.5 overflow-y-auto">
            {newestFirst.map((pin) => (
              <li key={pin.messageId} className="group/pin relative">
                <button
                  type="button"
                  onClick={() => {
                    setOpen(false);
                    onJump(pin.messageId);
                  }}
                  className="flex w-full flex-col gap-0.5 rounded-md px-2 py-1.5 pe-8 text-left hover:bg-accent focus-visible:bg-accent focus-visible:outline-hidden"
                >
                  <span className="flex items-center gap-1.5 text-muted-foreground text-xs">
                    <span className="font-medium text-foreground/80">
                      {pin.role === "user" ? "You" : "Assistant"}
                    </span>
                    <span aria-hidden>·</span>
                    <span className="tabular-nums">
                      {formatPinnedMessageTime(pin.messageCreatedAt)}
                    </span>
                  </span>
                  <span className="line-clamp-3 break-words text-sm">
                    {pin.excerpt || "(no text)"}
                  </span>
                </button>
                <Button
                  aria-label="Unpin message"
                  size="icon-xs"
                  variant="ghost"
                  onClick={() => onUnpin(pin.messageId)}
                  className="absolute top-1.5 right-1 text-muted-foreground opacity-0 hover:text-foreground focus-visible:opacity-100 group-hover/pin:opacity-100 pointer-coarse:opacity-100"
                >
                  <PinOffIcon aria-hidden className="size-3.5" />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </PopoverPopup>
    </Popover>
  );
}
