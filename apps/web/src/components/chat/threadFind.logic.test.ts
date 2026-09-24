import { describe, expect, it } from "vite-plus/test";

import type { TimelineEntry } from "../../session-logic";
import { findTextOccurrences, findThreadMatches, stepThreadFindIndex } from "./threadFind.logic";

const AT = "2026-01-01T00:00:00Z";

function message(
  id: string,
  role: "user" | "assistant" | "system",
  text: string,
  turnId: string | null = null,
): TimelineEntry {
  return {
    id,
    kind: "message",
    createdAt: AT,
    message: {
      id: id as never,
      role,
      text,
      turnId: turnId as never,
      createdAt: AT,
      updatedAt: AT,
      streaming: false,
    },
  };
}

describe("findTextOccurrences", () => {
  it("matches case-insensitively without overlapping", () => {
    expect(findTextOccurrences("Aaa aA", "aa")).toEqual([0, 4]);
  });

  it("ignores whitespace-only queries", () => {
    expect(findTextOccurrences("a b", " ")).toEqual([]);
  });

  it("matches Thai text", () => {
    expect(findTextOccurrences("ค้นหาคำ แล้วค้นหาอีก", "ค้นหา")).toEqual([0, 12]);
  });
});

describe("findThreadMatches", () => {
  it("lists every occurrence in timeline order with its turn", () => {
    const entries: TimelineEntry[] = [
      message("u1", "user", "Fix the build"),
      message("a1", "assistant", "The build fails; rebuild after the fix.", "turn-1"),
      {
        id: "w1",
        kind: "work",
        createdAt: AT,
        entry: { id: "w1", label: "build" } as never,
      },
      {
        id: "p1",
        kind: "proposed-plan",
        createdAt: AT,
        proposedPlan: { id: "p1", turnId: "turn-2", planMarkdown: "1. Build" } as never,
      },
    ];
    expect(findThreadMatches(entries, "build")).toEqual([
      { entryId: "u1", turnId: null, occurrence: 0 },
      { entryId: "a1", turnId: "turn-1", occurrence: 0 },
      { entryId: "a1", turnId: "turn-1", occurrence: 1 },
      { entryId: "p1", turnId: "turn-2", occurrence: 0 },
    ]);
  });

  it("skips system messages, which the timeline never renders", () => {
    expect(findThreadMatches([message("s1", "system", "build")], "build")).toEqual([]);
  });
});

describe("stepThreadFindIndex", () => {
  it("wraps in both directions", () => {
    expect(stepThreadFindIndex(2, 1, 3)).toBe(0);
    expect(stepThreadFindIndex(0, -1, 3)).toBe(2);
  });

  it("stays at zero without matches", () => {
    expect(stepThreadFindIndex(0, 1, 0)).toBe(0);
  });
});
