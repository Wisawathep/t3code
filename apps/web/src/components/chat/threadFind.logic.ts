import type { TurnId } from "@t3tools/contracts";
import type { TimelineEntry } from "../../session-logic";

export interface ThreadFindMatch {
  /** Timeline entry (and row) id of the message or proposed plan holding the match. */
  readonly entryId: string;
  /** Turn to unfold when the entry is hidden inside a folded turn. */
  readonly turnId: TurnId | null;
  /** Zero-based occurrence of the query within the entry's text. */
  readonly occurrence: number;
}

/** Whitespace-only queries match nothing; everything else is matched verbatim. */
export function isSearchableThreadFindQuery(query: string): boolean {
  return query.trim().length > 0;
}

/**
 * Start offsets of every non-overlapping, case-insensitive occurrence of
 * `query` in `text`. Callers compare against the same lowercased text, so
 * offsets stay valid for the original string in all but a few exotic scripts.
 */
export function findTextOccurrences(text: string, query: string): number[] {
  if (!isSearchableThreadFindQuery(query)) return [];
  const haystack = text.toLowerCase();
  const needle = query.toLowerCase();
  const starts: number[] = [];
  let from = 0;
  while (from <= haystack.length - needle.length) {
    const index = haystack.indexOf(needle, from);
    if (index < 0) break;
    starts.push(index);
    from = index + needle.length;
  }
  return starts;
}

function searchableText(entry: TimelineEntry): { text: string; turnId: TurnId | null } | null {
  if (entry.kind === "message") {
    if (entry.message.role === "system") return null;
    return { text: entry.message.text, turnId: entry.message.turnId };
  }
  if (entry.kind === "proposed-plan") {
    return { text: entry.proposedPlan.planMarkdown, turnId: entry.proposedPlan.turnId };
  }
  return null;
}

/** Every occurrence of `query` in the thread's user, assistant, and plan text, in timeline order. */
export function findThreadMatches(
  entries: ReadonlyArray<TimelineEntry>,
  query: string,
): ThreadFindMatch[] {
  if (!isSearchableThreadFindQuery(query)) return [];
  const matches: ThreadFindMatch[] = [];
  for (const entry of entries) {
    const source = searchableText(entry);
    if (!source) continue;
    const count = findTextOccurrences(source.text, query).length;
    for (let occurrence = 0; occurrence < count; occurrence += 1) {
      matches.push({ entryId: entry.id, turnId: source.turnId, occurrence });
    }
  }
  return matches;
}

/** Wraps `index + step` into `[0, count)`; returns 0 when there is nothing to step through. */
export function stepThreadFindIndex(index: number, step: 1 | -1, count: number): number {
  if (count <= 0) return 0;
  return (((index + step) % count) + count) % count;
}
