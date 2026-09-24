import type { LegendListRef } from "@legendapp/list/react";
import type { TurnId } from "@t3tools/contracts";
import { ChevronDownIcon, ChevronUpIcon, SearchIcon, XIcon } from "lucide-react";
import {
  useCallback,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
} from "react";
import type { TimelineEntry } from "../../session-logic";
import { Button } from "../ui/button";
import type { MessagesTimelineRow } from "./MessagesTimeline.logic";
import {
  findTextOccurrences,
  findThreadMatches,
  isSearchableThreadFindQuery,
  stepThreadFindIndex,
  type ThreadFindMatch,
} from "./threadFind.logic";

const MATCH_HIGHLIGHT = "t3-thread-find";
const ACTIVE_MATCH_HIGHLIGHT = "t3-thread-find-active";
const SEARCHABLE_ROWS_SELECTOR =
  '[data-timeline-row-kind="message"], [data-timeline-row-kind="proposed-plan"]';
// Keeps a revealed match clear of the find bar floating over the list's top edge.
const REVEAL_TOP_CLEARANCE_PX = 56;
const REVEAL_BOTTOM_CLEARANCE_PX = 24;

function highlightsSupported(): boolean {
  return (
    typeof CSS !== "undefined" && CSS.highlights !== undefined && typeof Highlight !== "undefined"
  );
}

function clearHighlights() {
  if (!highlightsSupported()) return;
  CSS.highlights.delete(MATCH_HIGHLIGHT);
  CSS.highlights.delete(ACTIVE_MATCH_HIGHLIGHT);
}

/** DOM ranges for each occurrence of `query` in a row's rendered text, in document order. */
function rowMatchRanges(row: Element, query: string): Range[] {
  const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  const nodeStarts: number[] = [];
  let text = "";
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const textNode = node as Text;
    nodes.push(textNode);
    nodeStarts.push(text.length);
    text += textNode.data;
  }
  const ranges: Range[] = [];
  let nodeIndex = 0;
  for (const start of findTextOccurrences(text, query)) {
    const end = start + query.length;
    while (nodeIndex < nodes.length - 1 && nodeStarts[nodeIndex + 1]! <= start) nodeIndex += 1;
    let endIndex = nodeIndex;
    while (endIndex < nodes.length - 1 && nodeStarts[endIndex + 1]! < end) endIndex += 1;
    const range = document.createRange();
    range.setStart(nodes[nodeIndex]!, start - nodeStarts[nodeIndex]!);
    range.setEnd(nodes[endIndex]!, end - nodeStarts[endIndex]!);
    ranges.push(range);
  }
  return ranges;
}

/** Scrolls `rect` into the visible band of the list unless it already sits there. */
function revealRect(scroller: HTMLElement, rect: DOMRect, bottomInset: number) {
  const bounds = scroller.getBoundingClientRect();
  const top = bounds.top + REVEAL_TOP_CLEARANCE_PX;
  const bottom = Math.max(
    top + rect.height,
    bounds.bottom - bottomInset - REVEAL_BOTTOM_CLEARANCE_PX,
  );
  if (rect.top >= top && rect.bottom <= bottom) return;
  const centeredTop = (top + bottom) / 2 - rect.height / 2;
  scroller.scrollTop += rect.top - Math.max(top, centeredTop);
}

function matchKey(query: string, match: ThreadFindMatch): string {
  return `${query}\u0000${match.entryId}\u0000${match.occurrence}`;
}

/**
 * Find bar for the open thread. Matches come from the loaded timeline data so
 * rows outside LegendList's rendered window still count; mounted rows are
 * painted with CSS custom highlights, which never touch the rendered DOM.
 */
export function ThreadFind({
  focusRequest,
  entries,
  rows,
  listRef,
  bottomInset,
  onExpandTurn,
  onManualNavigation,
  onClose,
}: {
  /** Changes each time the user asks for find again while it is already open. */
  focusRequest: number;
  entries: ReadonlyArray<TimelineEntry>;
  rows: ReadonlyArray<MessagesTimelineRow>;
  listRef: RefObject<LegendListRef | null>;
  /** Height the composer covers at the bottom of the list. */
  bottomInset: number;
  onExpandTurn: (turnId: TurnId) => void;
  onManualNavigation: () => void;
  onClose: () => void;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [query, setQuery] = useState("");
  const searchQuery = useDeferredValue(query);
  const matches = useMemo(() => findThreadMatches(entries, searchQuery), [entries, searchQuery]);
  // A query's first results select the newest match, where the reader usually
  // sits, and the selection then stays put while more matches stream in.
  const [selection, setSelection] = useState<{ query: string; index: number } | null>(null);
  if (matches.length > 0 && selection?.query !== searchQuery) {
    setSelection({ query: searchQuery, index: matches.length - 1 });
  }
  const resolvedIndex =
    matches.length === 0
      ? -1
      : Math.min(
          selection?.query === searchQuery ? selection.index : matches.length - 1,
          matches.length - 1,
        );
  const activeMatch = resolvedIndex >= 0 ? matches[resolvedIndex] : undefined;
  const activeKey = activeMatch ? matchKey(searchQuery, activeMatch) : null;
  const matchedEntryIds = useMemo(() => new Set(matches.map((match) => match.entryId)), [matches]);

  const handledFocusRequestRef = useRef<number | null>(null);
  useEffect(() => {
    if (handledFocusRequestRef.current === focusRequest) return;
    handledFocusRequestRef.current = focusRequest;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [focusRequest]);

  // Read by the highlight pass, which runs outside React's render cycle.
  const paintStateRef = useRef({ searchQuery, activeMatch, matchedEntryIds, bottomInset });
  const pendingRevealKeyRef = useRef<string | null>(null);
  const paintFrameRef = useRef<number | null>(null);

  const paint = useCallback(() => {
    paintFrameRef.current = null;
    const scroller = listRef.current?.getScrollableNode() ?? null;
    const state = paintStateRef.current;
    if (!scroller || !isSearchableThreadFindQuery(state.searchQuery)) {
      clearHighlights();
      return;
    }
    const matchRanges: Range[] = [];
    let activeRange: Range | null = null;
    let activeRow: Element | null = null;
    for (const row of scroller.querySelectorAll(SEARCHABLE_ROWS_SELECTOR)) {
      const rowId = (row as HTMLElement).dataset.timelineRowId;
      if (rowId === undefined || !state.matchedEntryIds.has(rowId)) continue;
      const ranges = rowMatchRanges(row, state.searchQuery);
      if (rowId === state.activeMatch?.entryId) {
        activeRow = row;
        activeRange = ranges[Math.min(state.activeMatch.occurrence, ranges.length - 1)] ?? null;
      }
      matchRanges.push(...ranges);
    }
    if (highlightsSupported()) {
      CSS.highlights.set(MATCH_HIGHLIGHT, new Highlight(...matchRanges));
      const active = new Highlight(...(activeRange ? [activeRange] : []));
      active.priority = 1;
      CSS.highlights.set(ACTIVE_MATCH_HIGHLIGHT, active);
    }
    const revealTarget = activeRange ?? activeRow;
    if (
      revealTarget &&
      state.activeMatch &&
      pendingRevealKeyRef.current === matchKey(state.searchQuery, state.activeMatch)
    ) {
      pendingRevealKeyRef.current = null;
      revealRect(scroller, revealTarget.getBoundingClientRect(), state.bottomInset);
    }
  }, [listRef]);

  const schedulePaint = useCallback(() => {
    if (paintFrameRef.current !== null) return;
    paintFrameRef.current = requestAnimationFrame(paint);
  }, [paint]);

  // Rows mount and stream as the list scrolls; repaint whenever their text changes.
  useEffect(() => {
    const scroller = listRef.current?.getScrollableNode();
    if (!scroller) return;
    const observer = new MutationObserver(schedulePaint);
    observer.observe(scroller, { childList: true, subtree: true, characterData: true });
    return () => observer.disconnect();
  }, [listRef, schedulePaint]);

  useLayoutEffect(() => {
    paintStateRef.current = { searchQuery, activeMatch, matchedEntryIds, bottomInset };
    schedulePaint();
  }, [activeMatch, bottomInset, matchedEntryIds, schedulePaint, searchQuery]);

  useEffect(
    () => () => {
      if (paintFrameRef.current !== null) cancelAnimationFrame(paintFrameRef.current);
      paintFrameRef.current = null;
      clearHighlights();
    },
    [],
  );

  // Brings the selected match on screen: unfold its turn when the row is
  // hidden, mount it through the list, then let the paint pass center the
  // exact range. Returns false while the row is still waiting to unfold.
  const revealMatch = useCallback(
    (match: ThreadFindMatch, key: string): boolean => {
      const rowIndex = rows.findIndex((row) => row.id === match.entryId);
      if (rowIndex < 0) {
        if (match.turnId) onExpandTurn(match.turnId);
        return false;
      }
      pendingRevealKeyRef.current = key;
      onManualNavigation();
      const mounted = listRef.current
        ?.getScrollableNode()
        .querySelector(`[data-timeline-row-id="${CSS.escape(match.entryId)}"]`);
      if (mounted) {
        schedulePaint();
      } else {
        void listRef.current
          ?.scrollToIndex({ index: rowIndex, animated: false, viewPosition: 0.5 })
          // Let the list measure the freshly mounted row before reading the range.
          .then(() => requestAnimationFrame(schedulePaint));
      }
      return true;
    },
    [listRef, onExpandTurn, onManualNavigation, rows, schedulePaint],
  );

  // Each newly selected match is revealed once, so later scrolling stays the reader's.
  const revealedKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (!activeMatch || activeKey === null || revealedKeyRef.current === activeKey) return;
    if (revealMatch(activeMatch, activeKey)) revealedKeyRef.current = activeKey;
  }, [activeKey, activeMatch, revealMatch]);

  const step = useCallback(
    (direction: 1 | -1) => {
      if (matches.length === 0) return;
      const nextIndex = stepThreadFindIndex(resolvedIndex, direction, matches.length);
      const nextMatch = matches[nextIndex];
      // A lone match keeps the same selection; scroll back to it directly.
      if (nextIndex === resolvedIndex && nextMatch) {
        revealMatch(nextMatch, matchKey(searchQuery, nextMatch));
        return;
      }
      setSelection({ query: searchQuery, index: nextIndex });
    },
    [matches, resolvedIndex, revealMatch, searchQuery],
  );

  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLInputElement>) => {
      if (event.nativeEvent.isComposing || event.keyCode === 229) return;
      if (event.key === "Enter") {
        event.preventDefault();
        step(event.shiftKey ? -1 : 1);
      } else if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }
    },
    [onClose, step],
  );

  const hasQuery = isSearchableThreadFindQuery(query);
  return (
    <div
      role="search"
      aria-label="Find in thread"
      className="absolute top-2 right-3 z-30 flex items-center gap-0.5 rounded-lg border bg-popover p-1 text-popover-foreground shadow-md sm:right-5"
    >
      <SearchIcon aria-hidden className="ms-1.5 size-3.5 shrink-0 text-muted-foreground" />
      <input
        ref={inputRef}
        type="text"
        value={query}
        placeholder="Find in thread"
        aria-label="Find in thread"
        spellCheck={false}
        onChange={(event) => setQuery(event.currentTarget.value)}
        onKeyDown={handleKeyDown}
        className="h-7 w-36 min-w-0 bg-transparent px-1.5 text-sm outline-none placeholder:text-muted-foreground/70 sm:w-48"
      />
      <span
        aria-live="polite"
        className="min-w-12 shrink-0 px-1 text-right text-xs tabular-nums text-muted-foreground"
      >
        {hasQuery
          ? matches.length === 0
            ? "No results"
            : `${resolvedIndex + 1}/${matches.length}`
          : null}
      </span>
      <Button
        aria-label="Previous match"
        size="icon-xs"
        variant="ghost"
        disabled={matches.length === 0}
        onClick={() => step(-1)}
      >
        <ChevronUpIcon aria-hidden className="size-4" />
      </Button>
      <Button
        aria-label="Next match"
        size="icon-xs"
        variant="ghost"
        disabled={matches.length === 0}
        onClick={() => step(1)}
      >
        <ChevronDownIcon aria-hidden className="size-4" />
      </Button>
      <Button aria-label="Close find" size="icon-xs" variant="ghost" onClick={onClose}>
        <XIcon aria-hidden className="size-4" />
      </Button>
    </div>
  );
}
