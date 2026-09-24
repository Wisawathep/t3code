import {
  CommandId,
  MAX_PINNED_MESSAGES_PER_THREAD,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationPinnedMessage,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";

const NOW = "2026-01-01T00:00:00.000Z";

function pinEntry(index: number): OrchestrationPinnedMessage {
  return {
    messageId: MessageId.make(`message-${index}`),
    role: "user",
    excerpt: `pin ${index}`,
    messageCreatedAt: NOW,
    pinnedAt: NOW,
  };
}

function makeReadModel(pinnedMessages: ReadonlyArray<OrchestrationPinnedMessage>) {
  return {
    snapshotSequence: 0,
    projects: [],
    threads: [
      {
        id: ThreadId.make("thread-1"),
        projectId: ProjectId.make("project-1"),
        title: "Thread",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        pullRequests: [],
        latestTurn: null,
        createdAt: NOW,
        updatedAt: NOW,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        deletedAt: null,
        pinnedMessages,
        messages: [],
        proposedPlans: [],
        activities: [],
        checkpoints: [],
        session: null,
      },
    ],
    updatedAt: NOW,
  } satisfies OrchestrationReadModel;
}

const pinCommand = (messageId: string) =>
  ({
    type: "thread.message.pin",
    commandId: CommandId.make(`cmd-pin-${messageId}`),
    threadId: ThreadId.make("thread-1"),
    messageId: MessageId.make(messageId),
    role: "assistant",
    excerpt: "text",
    messageCreatedAt: NOW,
  }) as const;

it.layer(NodeServices.layer)("message pin decider", (it) => {
  it.effect("rejects a pin past the per-thread limit", () =>
    Effect.gen(function* () {
      const pins = Array.from({ length: MAX_PINNED_MESSAGES_PER_THREAD }, (_, index) =>
        pinEntry(index),
      );
      const result = yield* Effect.result(
        decideOrchestrationCommand({
          command: pinCommand("message-new"),
          readModel: makeReadModel(pins),
        }),
      );
      expect(result._tag).toBe("Failure");
    }),
  );

  it.effect("still re-emits an existing pin at the limit", () =>
    Effect.gen(function* () {
      const pins = Array.from({ length: MAX_PINNED_MESSAGES_PER_THREAD }, (_, index) =>
        pinEntry(index),
      );
      const event = yield* decideOrchestrationCommand({
        command: pinCommand("message-0"),
        readModel: makeReadModel(pins),
      });
      const events = Array.isArray(event) ? event : [event];
      expect(events[0]?.type).toBe("thread.meta-updated");
      if (events[0]?.type === "thread.meta-updated") {
        expect(events[0].payload.pinnedMessages).toEqual(pins);
        expect(events[0].payload.updatedAt).toBe(NOW);
      }
    }),
  );

  it.effect("unpins only the named message", () =>
    Effect.gen(function* () {
      const event = yield* decideOrchestrationCommand({
        command: {
          type: "thread.message.unpin",
          commandId: CommandId.make("cmd-unpin"),
          threadId: ThreadId.make("thread-1"),
          messageId: MessageId.make("message-1"),
        },
        readModel: makeReadModel([pinEntry(0), pinEntry(1), pinEntry(2)]),
      });
      const events = Array.isArray(event) ? event : [event];
      if (events[0]?.type !== "thread.meta-updated") {
        throw new Error(`unexpected event ${events[0]?.type}`);
      }
      expect(
        events[0].payload.pinnedMessages?.map((pin: OrchestrationPinnedMessage) => pin.messageId),
      ).toEqual(["message-0", "message-2"]);
    }),
  );
});
