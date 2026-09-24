import type { LegendListRef } from "@legendapp/list/react";
import type { MessageId, TurnId } from "@t3tools/contracts";
import { useEffect, useRef, type RefObject } from "react";

import type { TimelineEntry } from "../../session-logic";
import { toastManager } from "../ui/toast";
import type { MessagesTimelineRow } from "./MessagesTimeline.logic";
import type { CitationHistoryPage } from "./useAssistantCitationTarget";

export interface MessageJumpRequest {
  readonly messageId: MessageId;
  /** Changes on every request so jumping to the same message twice still scrolls. */
  readonly key: number;
}

// Bounds history paging for a message that was removed from the thread.
const MAX_JUMP_HISTORY_PAGES = 50;
const JUMP_FLASH_MS = 1600;

/**
 * Brings a message into view on request: pages in older turns until the
 * message is loaded, unfolds its turn, then scrolls to it and flashes the row.
 */
export function useTimelineMessageJump({
  request,
  entries,
  rows,
  listRef,
  loadEarlier,
  onExpandTurn,
  onManualNavigation,
}: {
  request: MessageJumpRequest | null;
  entries: ReadonlyArray<TimelineEntry>;
  rows: ReadonlyArray<MessagesTimelineRow>;
  listRef: RefObject<LegendListRef | null>;
  loadEarlier: CitationHistoryPage | null;
  onExpandTurn: (turnId: TurnId) => void;
  onManualNavigation: () => void;
}) {
  const settledKeyRef = useRef<number | null>(null);
  const pagesRef = useRef({ key: -1, count: 0 });

  useEffect(() => {
    if (!request || settledKeyRef.current === request.key) return;
    const finish = () => {
      settledKeyRef.current = request.key;
    };
    const entry = entries.find(
      (candidate) => candidate.kind === "message" && candidate.message.id === request.messageId,
    );
    if (!entry || entry.kind !== "message") {
      if (pagesRef.current.key !== request.key) pagesRef.current = { key: request.key, count: 0 };
      if (loadEarlier && pagesRef.current.count < MAX_JUMP_HISTORY_PAGES) {
        if (loadEarlier.loading) return;
        pagesRef.current.count += 1;
        loadEarlier.onLoadEarlier();
        return;
      }
      finish();
      toastManager.add({
        type: "warning",
        title: "Pinned message is no longer in this thread",
        description: "It may have been removed by a revert. You can unpin it from the list.",
      });
      return;
    }
    const rowIndex = rows.findIndex(
      (row) => row.kind === "message" && row.message.id === request.messageId,
    );
    if (rowIndex < 0) {
      // Commentary inside a settled turn is folded away until the turn opens.
      if (entry.message.turnId) {
        onExpandTurn(entry.message.turnId);
        return;
      }
      finish();
      return;
    }
    finish();
    onManualNavigation();
    const rowId = rows[rowIndex]!.id;
    void listRef.current
      ?.scrollToIndex({ index: rowIndex, animated: false, viewOffset: 56 })
      .then(() => {
        requestAnimationFrame(() => {
          const row = listRef.current
            ?.getScrollableNode()
            .querySelector<HTMLElement>(`[data-timeline-row-id="${CSS.escape(rowId)}"]`);
          if (!row) return;
          row.dataset.jumpFlash = "true";
          window.setTimeout(() => {
            delete row.dataset.jumpFlash;
          }, JUMP_FLASH_MS);
        });
      });
  }, [entries, listRef, loadEarlier, onExpandTurn, onManualNavigation, request, rows]);
}
