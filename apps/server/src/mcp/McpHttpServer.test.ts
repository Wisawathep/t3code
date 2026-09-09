import { expect, it } from "@effect/vitest";
import { NodeHttpServer } from "@effect/platform-node";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EnvironmentId,
  ManagementApiKeyId,
  type ManagementApiKeyScope,
  PreviewTabId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";
import { McpProtocol, McpSchema, McpServer, Tool } from "effect/unstable/ai";
import { HttpBody, HttpClient, HttpRouter, HttpServerResponse } from "effect/unstable/http";

import * as ServerConfig from "../config.ts";
import * as McpHttpServer from "./McpHttpServer.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as McpSessionRegistry from "./McpSessionRegistry.ts";
import * as PreviewAutomationBroker from "./PreviewAutomationBroker.ts";
import * as ManagementApiKeyService from "../auth/ManagementApiKeyService.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ThreadCommandDispatcher from "../orchestration/ThreadCommandDispatcher.ts";
import * as ManagementApiKeys from "../persistence/ManagementApiKeys.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { makeProviderRegistryLayer } from "../provider/testUtils/providerRegistryMock.ts";
import { ThreadToolkit } from "./toolkits/threads/tools.ts";

const environmentId = EnvironmentId.make("environment-mcp-test");
const threadId = ThreadId.make("thread-mcp-test");
const tabId = PreviewTabId.make("tab-mcp-test");
const alternateTabId = PreviewTabId.make("tab-mcp-alternate");
const decodeJsonText = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const invocation = {
  environmentId,
  principal: {
    type: "provider-session" as const,
    threadId,
    providerSessionId: "provider-session-mcp-test",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  issuedAt: 1,
};
const client = McpSchema.McpServerClient.of({
  clientId: 1,
  clientCapabilities: {},
  clientInfo: { name: "mcp-test", version: "1.0.0" },
  protocolVersion: "2025-06-18",
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "mcp-test", version: "1.0.0" },
  },
  getClient: Effect.die("unused"),
});
const TestLayer = McpHttpServer.PreviewToolkitRegistrationLive.pipe(
  Layer.provideMerge(McpServer.McpServer.layer),
  Layer.provideMerge(PreviewAutomationBroker.layer),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-mcp-http-server-test-" })),
  Layer.provideMerge(NodeServices.layer),
);
const ThreadRegistrationTestLayer = McpHttpServer.McpToolkitRegistrationLive.pipe(
  Layer.provideMerge(McpServer.McpServer.layer),
  Layer.provideMerge(PreviewAutomationBroker.layer.pipe(Layer.provide(NodeServices.layer))),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-mcp-http-server-test-" })),
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(makeProviderRegistryLayer()),
  Layer.provideMerge(
    Layer.succeed(
      ProjectionSnapshotQuery.ProjectionSnapshotQuery,
      {} as ProjectionSnapshotQuery.ProjectionSnapshotQuery["Service"],
    ),
  ),
  Layer.provideMerge(
    Layer.succeed(
      ThreadCommandDispatcher.ThreadCommandDispatcher,
      {} as ThreadCommandDispatcher.ThreadCommandDispatcher["Service"],
    ),
  ),
  Layer.provideMerge(
    Layer.succeed(
      OrchestrationEngine.OrchestrationEngineService,
      {} as OrchestrationEngine.OrchestrationEngineService["Service"],
    ),
  ),
  Layer.provideMerge(
    Layer.succeed(
      GitWorkflowService.GitWorkflowService,
      {} as GitWorkflowService.GitWorkflowService["Service"],
    ),
  ),
  Layer.provideMerge(Layer.succeed(McpInvocationContext.McpInvocationContext, invocation)),
);

const managementScopes = [
  "models:read",
  "threads:list",
  "threads:read",
  "threads:create",
  "threads:message",
  "threads:wait",
] satisfies ReadonlyArray<ManagementApiKeyScope>;

const managementPrincipal: ManagementApiKeyService.ManagementApiKeyPrincipal = {
  type: "management-key",
  keyId: ManagementApiKeyId.make("mcp-http-management-key"),
  name: "HTTP management key",
  scopes: new Set(managementScopes),
};

const emptyMcpRegistry = McpSessionRegistry.McpSessionRegistry.of({
  issue: () => Effect.die("MCP issue is not used by this test"),
  resolve: () => Effect.succeed(undefined),
  touch: () => Effect.void,
  revokeProviderSession: () => Effect.void,
  revokeThread: () => Effect.void,
  revokeAll: Effect.void,
});

const testServerEnvironment = ServerEnvironment.ServerEnvironment.of({
  getEnvironmentId: Effect.succeed(environmentId),
  getDescriptor: Effect.die("MCP descriptor is not used by this test"),
});

const mcpHttpToolkitLayer = McpHttpServer.McpToolkitRegistrationLive.pipe(
  Layer.provideMerge(McpServer.McpServer.layer),
  Layer.provideMerge(McpHttpServer.McpTransportLive),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-mcp-http-server-test-" })),
);

const makeMcpHttpTestLayer = (
  managementService: ManagementApiKeyService.ManagementApiKeyService["Service"],
  registry = emptyMcpRegistry,
) =>
  HttpRouter.serve(mcpHttpToolkitLayer, {
    disableListenLog: true,
    disableLogger: true,
  }).pipe(
    Layer.provide(Layer.succeed(McpSessionRegistry.McpSessionRegistry, registry)),
    Layer.provide(Layer.succeed(ServerEnvironment.ServerEnvironment, testServerEnvironment)),
    Layer.provide(
      Layer.succeed(ManagementApiKeyService.ManagementApiKeyService, managementService),
    ),
    Layer.provide(makeProviderRegistryLayer()),
    Layer.provide(
      Layer.succeed(
        ProjectionSnapshotQuery.ProjectionSnapshotQuery,
        {} as ProjectionSnapshotQuery.ProjectionSnapshotQuery["Service"],
      ),
    ),
    Layer.provide(
      Layer.succeed(
        ThreadCommandDispatcher.ThreadCommandDispatcher,
        {} as ThreadCommandDispatcher.ThreadCommandDispatcher["Service"],
      ),
    ),
    Layer.provide(
      Layer.succeed(
        OrchestrationEngine.OrchestrationEngineService,
        {} as OrchestrationEngine.OrchestrationEngineService["Service"],
      ),
    ),
    Layer.provide(
      Layer.succeed(
        GitWorkflowService.GitWorkflowService,
        {} as GitWorkflowService.GitWorkflowService["Service"],
      ),
    ),
    Layer.provide(
      Layer.succeed(
        PreviewAutomationBroker.PreviewAutomationBroker,
        {} as PreviewAutomationBroker.PreviewAutomationBroker["Service"],
      ),
    ),
    Layer.provideMerge(NodeServices.layer),
    Layer.provideMerge(NodeHttpServer.layerTest),
  );

const initializePayload = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "management-key-test", version: "1.0.0" },
  },
});

const mcpRequest = (token: string, body: string, sessionId?: string) => ({
  headers: {
    accept: "application/json, text/event-stream",
    authorization: `Bearer ${token}`,
    ...(sessionId === undefined ? {} : { "mcp-session-id": sessionId }),
    ...(sessionId === undefined ? {} : { "mcp-protocol-version": "2025-06-18" }),
  },
  body: HttpBody.text(body, "application/json"),
});

const callListModelsPayload = JSON.stringify({
  jsonrpc: "2.0",
  id: 2,
  method: "tools/call",
  params: { name: "list_models", arguments: {} },
});

const makeManagementService = (
  resolveToken: ManagementApiKeyService.ManagementApiKeyService["Service"]["resolveToken"],
) =>
  ManagementApiKeyService.ManagementApiKeyService.of({
    create: () => Effect.die("management key creation is not used by this test"),
    list: () => Effect.succeed([]),
    revoke: () => Effect.succeed(false),
    rotate: () => Effect.succeed(Option.none()),
    resolveToken,
    authenticate: resolveToken,
  });

const snapshotResult = {
  url: "http://example.test/",
  title: "Example",
  loading: false,
  visibleText: "Example",
  interactiveElements: [],
  accessibilityTree: {},
  consoleEntries: [],
  networkEntries: [],
  actionTimeline: [],
  screenshot: {
    mimeType: "image/png",
    data: Buffer.from("png").toString("base64"),
    width: 10,
    height: 5,
  },
};

/** Answers every snapshot request on a fresh broker host with the given result. */
const serveSnapshots = (clientId: string, result: unknown) =>
  Effect.gen(function* () {
    const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
    const connected = yield* Deferred.make<void>();
    const inputs: Array<unknown> = [];
    const events = yield* broker.connect({ clientId, environmentId });
    yield* Stream.runForEach(events, (event) => {
      if (event.type === "connected") return Deferred.succeed(connected, undefined);
      inputs.push(event.request.input);
      return broker.respond({
        clientId,
        connectionId: event.connectionId,
        requestId: event.request.requestId,
        ok: true,
        result,
      });
    }).pipe(Effect.forkScoped);
    yield* Deferred.await(connected);
    return inputs;
  });

const callSnapshot = (args: Record<string, unknown>) =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    return yield* server
      .callTool({ name: "preview_snapshot", arguments: args })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
        Effect.provideService(McpSchema.McpServerClient, client),
      );
  });

it("normalizes empty successful notification responses to accepted", () => {
  const notificationResponse = McpHttpServer.normalizeMcpHttpResponse(
    HttpServerResponse.text("", { status: 200, contentType: "application/json" }),
  );
  expect(notificationResponse.status).toBe(202);

  const resultResponse = McpHttpServer.normalizeMcpHttpResponse(
    HttpServerResponse.jsonUnsafe({ jsonrpc: "2.0", id: 1, result: {} }),
  );
  expect(resultResponse.status).toBe(200);
});

it.effect(
  "returns the same generic 401 for missing, malformed, unknown, revoked, and expired bearers",
  () =>
    Effect.gen(function* () {
      const activeToken = "t3mgmt_mcp-http-management-key_active-secret";
      const managementService = makeManagementService((candidate) =>
        Effect.succeed(
          candidate === activeToken ? Option.some(managementPrincipal) : Option.none(),
        ),
      );

      yield* Effect.scoped(
        Effect.gen(function* () {
          const httpClient = yield* HttpClient.HttpClient;
          const candidates = [
            undefined,
            "not-a-bearer",
            "t3mgmt_mcp-http-management-key_unknown-secret",
            "t3mgmt_mcp-http-management-key_revoked-secret",
            "t3mgmt_mcp-http-management-key_expired-secret",
          ] as const;
          const responses = [];
          for (const candidate of candidates) {
            const response = yield* httpClient.post(
              "/mcp",
              candidate === undefined
                ? {
                    headers: { accept: "application/json, text/event-stream" },
                    body: HttpBody.text(initializePayload, "application/json"),
                  }
                : mcpRequest(candidate, initializePayload),
            );
            responses.push({ status: response.status, body: yield* response.text });
          }
          expect(responses).toHaveLength(candidates.length);
          for (const response of responses) {
            expect(response.status).toBe(401);
            expect(response.body).toContain('"error":"invalid_mcp_credential"');
            expect(response.body).toContain("A valid MCP bearer credential is required.");
          }
          expect(new Set(responses.map((response) => response.body)).size).toBe(1);
        }).pipe(Effect.provide(makeMcpHttpTestLayer(managementService))),
      );
    }),
);

it.effect("authenticates a persisted key after rebuilding the service and HTTP transport", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const repository = yield* ManagementApiKeys.ManagementApiKeyRepository;
      const firstService = yield* ManagementApiKeyService.make;
      const issued = yield* firstService.create({
        name: "Persisted HTTP integration",
        scopes: managementScopes,
      });
      const rebuiltService = yield* ManagementApiKeyService.make;
      expect(rebuiltService).not.toBe(firstService);

      yield* Effect.scoped(
        Effect.gen(function* () {
          const httpClient = yield* HttpClient.HttpClient;
          const initialize = yield* httpClient.post(
            "/mcp",
            mcpRequest(issued.secret, initializePayload),
          );
          expect(initialize.status).toBe(200);
          const sessionId = initialize.headers["mcp-session-id"];
          expect(sessionId).toBeDefined();

          const models = yield* httpClient.post(
            "/mcp",
            mcpRequest(issued.secret, callListModelsPayload, sessionId),
          );
          expect(models.status).toBe(200);
          expect(yield* models.text).toContain(environmentId);
        }).pipe(Effect.provide(makeMcpHttpTestLayer(rebuiltService))),
      );
      // Keep the repository alive until the rebuilt transport has finished
      // resolving the token from the in-memory persisted row.
      void repository;
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          ManagementApiKeys.layer.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
          NodeServices.layer,
        ),
      ),
    ),
  ),
);

it.effect.each([{}, { includeImage: false }])(
  "returns bounded structural preview snapshot failures %#",
  (input) =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* McpServer.McpServer;
        const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
        const events = yield* broker.connect({
          clientId: "mcp-failure-client",
          environmentId,
        });
        yield* Stream.runForEach(events, (event) =>
          event.type === "connected"
            ? Effect.void
            : broker.respond({
                clientId: "mcp-failure-client",
                connectionId: event.connectionId,
                requestId: event.request.requestId,
                ok: false,
                error: {
                  _tag: "PreviewAutomationExecutionError",
                  message: "sensitive renderer failure",
                  detail: { consoleOutput: "sensitive browser output" },
                },
              }),
        ).pipe(Effect.forkScoped);
        yield* Effect.yieldNow;

        const snapshot = yield* server
          .callTool({ name: "preview_snapshot", arguments: input })
          .pipe(
            Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
            Effect.provideService(McpSchema.McpServerClient, client),
          );

        expect(snapshot.isError).toBe(true);
        expect(snapshot.content).toEqual([
          { type: "text", text: "Preview snapshot failed: PreviewAutomationExecutionError." },
        ]);
        expect(snapshot.structuredContent).toEqual({
          error: {
            _tag: "PreviewAutomationExecutionError",
            operation: "snapshot",
            failureCount: 1,
          },
        });
      }),
    ).pipe(Effect.provide(TestLayer)),
);

it.effect.each([
  { mode: "default", input: {}, images: true },
  { mode: "explicit image", input: { includeImage: true }, images: true },
  { mode: "text only", input: { includeImage: false }, images: false },
])("returns fresh $mode snapshots on repeated MCP calls", ({ input, images }) =>
  Effect.scoped(
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
      const connected = yield* Deferred.make<void>();
      const png =
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
      const page = {
        url: "http://example.test/",
        loading: false,
        visibleText: "Save your changes",
        interactiveElements: [
          {
            tag: "button",
            role: "button",
            name: "Save",
            selector: "#save",
            x: 0,
            y: 0,
            width: 20,
            height: 10,
          },
        ],
        accessibilityTree: { role: "document", name: "Example" },
        consoleEntries: [],
        networkEntries: [],
        actionTimeline: [],
      };
      const screenshot = { mimeType: "image/png", width: 1, height: 1 };
      let requests = 0;
      const events = yield* broker.connect({ clientId: "mcp-image-option-client", environmentId });
      yield* Stream.runForEach(events, (event) => {
        if (event.type === "connected") return Deferred.succeed(connected, undefined);
        requests += 1;
        expect(event.request).toMatchObject({
          operation: "snapshot",
          tabId: alternateTabId,
          threadId,
        });
        expect(event.request.input).toEqual({});
        return broker.respond({
          clientId: "mcp-image-option-client",
          connectionId: event.connectionId,
          requestId: event.request.requestId,
          ok: true,
          result: {
            ...page,
            title: `Snapshot ${requests}`,
            screenshot: { ...screenshot, data: png },
          },
        });
      }).pipe(Effect.forkScoped);
      yield* Deferred.await(connected);

      for (const call of [1, 2, 3, 4, 5, 6]) {
        const snapshot = yield* server
          .callTool({
            name: "preview_snapshot",
            arguments: { ...input, tabId: alternateTabId },
          })
          .pipe(
            Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
            Effect.provideService(McpSchema.McpServerClient, client),
          );
        const metadata = { ...page, title: `Snapshot ${call}`, screenshot };
        const { accessibilityTree: _tree, ...boundedMetadata } = metadata;
        expect(snapshot.isError).toBe(false);
        expect(snapshot.structuredContent).toEqual(metadata);
        const [text, ...rest] = snapshot.content;
        expect(text?.type === "text" ? decodeJsonText(text.text) : null).toEqual(boundedMetadata);
        expect(rest).toEqual([
          {
            type: "text",
            text: "Snapshot text was bounded. Omitted: accessibilityTree (use interactiveElements locators or preview_evaluate).",
          },
          ...(images
            ? [
                {
                  type: "image",
                  mimeType: "image/png",
                  data: new Uint8Array(Buffer.from(png, "base64")),
                },
              ]
            : []),
        ]);
      }

      // Output selection belongs to this call, not the MCP session's history.
      const nextDefault = yield* server
        .callTool({
          name: "preview_snapshot",
          arguments: { tabId: alternateTabId },
        })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
      expect(nextDefault.content.map((content) => content.type)).toEqual(["text", "text", "image"]);
      expect(nextDefault.structuredContent).toEqual({ ...page, title: "Snapshot 7", screenshot });
      expect(requests).toBe(7);
    }),
  ).pipe(Effect.provide(TestLayer)),
);

it.effect("rejects non-boolean snapshot image options before selecting a browser host", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    for (const includeImage of ["false", 0, null]) {
      const result = yield* server
        .callTool({
          name: "preview_snapshot",
          arguments: { includeImage },
        })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
      expect(result.isError).toBe(true);
      expect(result.content).toEqual([{ type: "text", text: "Preview snapshot failed: AiError." }]);
      expect(result.structuredContent).toEqual({
        error: { _tag: "AiError", operation: "snapshot", failureCount: 1 },
      });
    }
  }).pipe(Effect.provide(TestLayer)),
);

it.effect("saves the snapshot PNG on request and reports its path", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const inputs = yield* serveSnapshots("mcp-save-client", snapshotResult);

      const snapshot = yield* callSnapshot({ save: true });

      expect(snapshot.isError).toBe(false);
      // The browser never receives the server-only `save` flag.
      expect(inputs).toEqual([{}]);
      const structured = snapshot.structuredContent as { readonly screenshotPath?: string };
      const screenshotPath = structured.screenshotPath;
      expect(typeof screenshotPath).toBe("string");
      expect(path.dirname(screenshotPath!)).toBe(config.browserArtifactsDir);
      expect(path.basename(screenshotPath!)).toMatch(
        /^browser-screenshot-example-test-[0-9a-z]+-[0-9a-f]{8}\.png$/,
      );
      expect(Buffer.from(yield* fileSystem.readFile(screenshotPath!)).toString()).toBe("png");
      const text = snapshot.content.find((content) => content.type === "text");
      expect(decodeJsonText(text?.type === "text" ? text.text : "")).toMatchObject({
        screenshotPath,
      });

      const unsaved = yield* callSnapshot({});
      expect(unsaved.structuredContent).not.toHaveProperty("screenshotPath");
    }),
  ).pipe(Effect.provide(TestLayer)),
);

it.effect("reports a tagged error when the screenshot cannot be saved", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      // A regular file where the artifacts directory should be makes every write fail.
      yield* fileSystem.writeFileString(config.browserArtifactsDir, "");
      yield* serveSnapshots("mcp-save-failure-client", snapshotResult);

      const snapshot = yield* callSnapshot({ save: true });

      expect(snapshot.isError).toBe(true);
      expect(snapshot.content).toEqual([
        { type: "text", text: "Preview snapshot failed: PreviewScreenshotSaveError." },
      ]);
      expect(snapshot.structuredContent).toEqual({
        error: { _tag: "PreviewScreenshotSaveError", operation: "snapshot", failureCount: 1 },
      });
    }),
  ).pipe(Effect.provide(TestLayer)),
);

it.effect("recovers preview status through a healthy host within the tool timeout", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
      let staleConnectionId = "";
      const staleEvents = yield* broker.connect({
        clientId: "mcp-stale-client",
        environmentId,
      });
      yield* Stream.runForEach(staleEvents, (event) => {
        if (event.type === "connected") staleConnectionId = event.connectionId;
        return Effect.void;
      }).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      yield* broker.focusHost({
        clientId: "mcp-stale-client",
        environmentId,
        connectionId: staleConnectionId,
        focused: true,
      });

      const healthyEvents = yield* broker.connect({
        clientId: "mcp-healthy-client",
        environmentId,
      });
      yield* Stream.runForEach(healthyEvents, (event) =>
        event.type === "connected"
          ? Effect.void
          : broker.respond({
              clientId: "mcp-healthy-client",
              connectionId: event.connectionId,
              requestId: event.request.requestId,
              ok: true,
              result: {
                available: true,
                visible: true,
                tabId,
                url: "http://example.test/",
                title: "Recovered",
                loading: false,
              },
            }),
      ).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;

      const statusFiber = yield* server
        .callTool({ name: "preview_status", arguments: {} })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
          Effect.forkChild({ startImmediately: true }),
        );
      yield* TestClock.adjust(3_000);
      const status = yield* Fiber.join(statusFiber);

      expect(status.isError).toBe(false);
      expect(status.structuredContent).toMatchObject({
        available: true,
        tabId,
        title: "Recovered",
      });
    }),
  ).pipe(Effect.provide(TestLayer)),
);

it.effect("keeps the snapshot text under the agent's output ceiling", () =>
  Effect.scoped(
    Effect.gen(function* () {
      // Mirrors the real failure: a [role] container whose innerText is the whole
      // project list, repeated for several elements, plus a big AX tree.
      const pageText = "/Users/theo/Code/project\nClaude, Codex · 79 threads\n".repeat(600);
      const element = (name: string, index: number) => ({
        tag: "div",
        role: "presentation",
        name,
        selector: `div:nth-of-type(${index})`,
        x: 0,
        y: 0,
        width: 10,
        height: 10,
      });
      const oversized = {
        ...snapshotResult,
        visibleText: pageText,
        interactiveElements: [
          element(pageText, 1),
          element(pageText, 2),
          element(pageText, 3),
          element("Continue", 4),
        ],
        accessibilityTree: { nodes: Array.from({ length: 2_000 }, (_, i) => ({ nodeId: `${i}` })) },
        consoleEntries: Array.from({ length: 100 }, (_, i) => ({
          level: "log",
          text: `entry ${i}`,
          timestamp: "t",
        })),
      };
      yield* serveSnapshots("mcp-bounded-client", oversized);

      const snapshot = yield* callSnapshot({ includeImage: false });

      expect(snapshot.isError).toBe(false);
      const [text, notice] = snapshot.content;
      expect(text?.type).toBe("text");
      const body = text?.type === "text" ? text.text : "";
      expect(Buffer.byteLength(body, "utf8")).toBeLessThanOrEqual(
        McpHttpServer.MAX_SNAPSHOT_TEXT_BYTES,
      );
      const parsed = decodeJsonText(body) as {
        readonly accessibilityTree?: unknown;
        readonly visibleText: string;
        readonly interactiveElements: ReadonlyArray<{ readonly name: string }>;
        readonly consoleEntries: ReadonlyArray<{ readonly text: string }>;
      };
      expect(parsed.accessibilityTree).toBeUndefined();
      expect(parsed.visibleText.length).toBeLessThanOrEqual(8_001);
      expect(parsed.interactiveElements).toHaveLength(4);
      expect(parsed.interactiveElements[0]?.name.length).toBeLessThanOrEqual(201);
      expect(parsed.interactiveElements[3]?.name).toBe("Continue");
      expect(parsed.consoleEntries).toHaveLength(40);
      expect(parsed.consoleEntries[0]?.text).toBe("entry 60");
      expect(notice?.type === "text" ? notice.text : "").toContain("accessibilityTree");
      expect(notice?.type === "text" ? notice.text : "").toContain("60 older console entries");
      // The structured result is untouched; only the text the agent reads is bounded.
      expect(snapshot.structuredContent).toMatchObject({
        accessibilityTree: oversized.accessibilityTree,
      });
    }),
  ).pipe(Effect.provide(TestLayer)),
);

it.effect("bounds the snapshot text even when nothing but logs and the title are large", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const oversized = {
        ...snapshotResult,
        title: "t".repeat(70_000),
        interactiveElements: [],
        consoleEntries: [{ level: "log", text: "x".repeat(70_000), timestamp: "t" }],
      };
      yield* serveSnapshots("mcp-bounded-logs-client", oversized);

      const snapshot = yield* callSnapshot({ includeImage: false });

      const [text] = snapshot.content;
      const body = text?.type === "text" ? text.text : "";
      expect(Buffer.byteLength(body, "utf8")).toBeLessThanOrEqual(
        McpHttpServer.MAX_SNAPSHOT_TEXT_BYTES,
      );
      const parsed = decodeJsonText(body) as {
        readonly title: string;
        readonly consoleEntries: ReadonlyArray<{ readonly text: string }>;
      };
      expect(parsed.title.length).toBe(2_049);
      expect(parsed.consoleEntries[0]?.text.length).toBe(501);
      const notice = snapshot.content[1];
      const noticeText = notice?.type === "text" ? notice.text : "";
      expect(noticeText).toContain("url or title after 2048 characters");
      expect(noticeText).toContain("console entries text after 500 characters");
    }),
  ).pipe(Effect.provide(TestLayer)),
);

it.effect("sheds log entries before locators when every list is full", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const long = "x".repeat(2_000);
      const oversized = {
        ...snapshotResult,
        interactiveElements: Array.from({ length: 20 }, (_, i) => ({
          tag: "button",
          role: "button",
          name: `Button ${i}`,
          selector: `#button-${i}`,
          x: 0,
          y: 0,
          width: 10,
          height: 10,
        })),
        consoleEntries: Array.from({ length: 200 }, () => ({
          level: long,
          text: long,
          timestamp: long,
          source: long,
        })),
        networkEntries: Array.from({ length: 200 }, () => ({
          url: long,
          method: long,
          status: 200,
          failed: false,
          errorText: long,
          timestamp: long,
        })),
        actionTimeline: Array.from({ length: 200 }, () => ({
          id: long,
          action: long,
          status: "succeeded",
          startedAt: long,
          completedAt: long,
          error: long,
        })),
      };
      yield* serveSnapshots("mcp-full-logs-client", oversized);

      const snapshot = yield* callSnapshot({ includeImage: false });

      const [text, notice] = snapshot.content;
      const body = text?.type === "text" ? text.text : "";
      expect(Buffer.byteLength(body, "utf8")).toBeLessThanOrEqual(
        McpHttpServer.MAX_SNAPSHOT_TEXT_BYTES,
      );
      const parsed = decodeJsonText(body) as {
        readonly interactiveElements: ReadonlyArray<unknown>;
        readonly consoleEntries: ReadonlyArray<unknown>;
        readonly networkEntries: ReadonlyArray<unknown>;
        readonly actionTimeline: ReadonlyArray<unknown>;
      };
      // Locators survive; the log lists take the cut.
      expect(parsed.interactiveElements).toHaveLength(20);
      expect(
        parsed.consoleEntries.length + parsed.networkEntries.length + parsed.actionTimeline.length,
      ).toBeLessThan(120);
      const noticeText = notice?.type === "text" ? notice.text : "";
      expect(noticeText).toContain("40 of 40 actionTimeline");
      expect(noticeText).not.toMatch(/\d+ of \d+ interactiveElements/);
    }),
  ).pipe(Effect.provide(TestLayer)),
);

it.effect("terminates HTTP MCP sessions with DELETE", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const serverLayer = McpServer.layerHttp({
        name: "MCP termination test",
        version: "1.0.0",
        path: "/mcp",
        protocols: [McpProtocol.v2025_06_18],
      });
      yield* HttpRouter.serve(serverLayer, {
        disableListenLog: true,
        disableLogger: true,
      }).pipe(Layer.build);
      const httpClient = yield* HttpClient.HttpClient;

      const initializeResponse = yield* httpClient.post("/mcp", {
        headers: { accept: "application/json, text/event-stream" },
        body: HttpBody.text(
          `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"mcp-test","version":"1.0.0"}}}`,
          "application/json",
        ),
      });
      const sessionId = initializeResponse.headers["mcp-session-id"];
      expect(initializeResponse.status).toBe(200);
      expect(sessionId).not.toBeNull();

      const missingSessionResponse = yield* httpClient.del("/mcp");
      expect(missingSessionResponse.status).toBe(400);

      const unknownSessionResponse = yield* httpClient.del("/mcp", {
        headers: { "mcp-session-id": "unknown-session" },
      });
      expect(unknownSessionResponse.status).toBe(404);

      const terminateResponse = yield* httpClient.del("/mcp", {
        headers: { "mcp-session-id": sessionId! },
      });
      expect(terminateResponse.status).toBe(204);

      const reusedSessionResponse = yield* httpClient.post("/mcp", {
        headers: {
          accept: "application/json, text/event-stream",
          "mcp-session-id": sessionId!,
        },
        body: HttpBody.text(
          `{"jsonrpc":"2.0","id":2,"method":"ping","params":{}}`,
          "application/json",
        ),
      });
      expect(reusedSessionResponse.status).toBe(404);
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("registers annotated tools and preserves authenticated request context", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
      const routedRequests: Array<{
        readonly operation: string;
        readonly tabId?: string | undefined;
      }> = [];
      const events = yield* broker.connect({
        clientId: "mcp-test-client",
        environmentId,
      });
      yield* Stream.runForEach(events, (event) => {
        if (event.type === "connected") return Effect.void;
        routedRequests.push(event.request);
        return broker.respond({
          clientId: "mcp-test-client",
          connectionId: event.connectionId,
          requestId: event.request.requestId,
          ok: true,
          result:
            event.request.operation === "snapshot"
              ? snapshotResult
              : event.request.operation === "evaluate"
                ? ["Connect", "Continue"]
                : event.request.operation === "press"
                  ? undefined
                  : {
                      available: true,
                      visible: true,
                      tabId,
                      url: "http://example.test/",
                      title: "Example",
                      loading: false,
                    },
        });
      }).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;

      const statusTool = server.tools.find(({ tool }) => tool.name === "preview_status");
      expect(statusTool?.tool.annotations?.readOnlyHint).toBe(true);
      expect(statusTool?.tool.annotations?.idempotentHint).toBe(true);
      expect(statusTool?.tool.annotations?.destructiveHint).toBe(false);

      const snapshotTool = server.tools.find(({ tool }) => tool.name === "preview_snapshot");
      expect(snapshotTool?.tool.annotations?.readOnlyHint).toBe(true);
      expect(snapshotTool?.tool.annotations?.idempotentHint).toBe(true);
      expect(snapshotTool?.tool.annotations?.openWorldHint).toBe(true);

      const clickTool = server.tools.find(({ tool }) => tool.name === "preview_click");
      expect(clickTool?.tool.annotations?.readOnlyHint).toBe(false);
      expect(clickTool?.tool.annotations?.destructiveHint).toBe(true);
      expect(clickTool?.tool.annotations?.openWorldHint).toBe(true);
      expect(clickTool?.tool.outputSchema).toEqual({
        type: "object",
        additionalProperties: false,
        description: "The preview action completed successfully.",
      });

      const navigateTool = server.tools.find(({ tool }) => tool.name === "preview_navigate");
      expect(navigateTool?.tool.annotations?.destructiveHint).toBe(false);
      expect(navigateTool?.tool.annotations?.openWorldHint).toBe(true);

      const status = yield* server
        .callTool({ name: "preview_status", arguments: {} })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
      expect(status.isError).toBe(false);
      expect(status.structuredContent).toMatchObject({
        available: true,
        tabId,
      });

      const malformed = yield* server
        .callTool({ name: "preview_click", arguments: { selector: "" } })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
          Effect.flip,
        );
      expect(malformed._tag).toBe("InvalidParams");

      const snapshot = yield* server
        .callTool({ name: "preview_snapshot", arguments: { tabId: alternateTabId } })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
      expect(snapshot.isError).toBe(false);
      expect(snapshot.content.some((content) => content.type === "image")).toBe(true);
      expect(snapshot.structuredContent).toMatchObject({
        screenshot: { mimeType: "image/png", width: 10, height: 5 },
      });
      expect(routedRequests.find(({ operation }) => operation === "snapshot")?.tabId).toBe(
        alternateTabId,
      );

      // Arrays and primitives are wrapped so structuredContent stays a JSON object.
      // Claude Code rejects the whole result otherwise.
      const evaluateTool = server.tools.find(({ tool }) => tool.name === "preview_evaluate");
      expect(evaluateTool?.tool.outputSchema).toMatchObject({ type: "object" });
      const evaluated = yield* server
        .callTool({ name: "preview_evaluate", arguments: { expression: "buttons()" } })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
      expect(evaluated.isError).toBe(false);
      expect(evaluated.structuredContent).toEqual({ value: ["Connect", "Continue"] });
      expect(evaluated.content).toEqual([
        { type: "text", text: '{"value":["Connect","Continue"]}' },
      ]);

      const actionRequests = [
        { name: "preview_click", arguments: { x: 10, y: 10 } },
        { name: "preview_type", arguments: { text: "Hello" } },
        { name: "preview_press", arguments: { key: "Enter" } },
        { name: "preview_scroll", arguments: { deltaY: 100 } },
        { name: "preview_wait_for", arguments: { text: "Example" } },
      ];
      for (const request of actionRequests) {
        const result = yield* server
          .callTool(request)
          .pipe(
            Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
            Effect.provideService(McpSchema.McpServerClient, client),
          );
        expect(result.isError).toBe(false);
        expect(result.structuredContent).toEqual({});
        expect(result.content).toEqual([{ type: "text", text: "{}" }]);
      }
    }),
  ).pipe(Effect.provide(TestLayer)),
);

it.effect("registers the thread toolkit alongside preview", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const create = server.tools.find(({ tool }) => tool.name === "create_thread");
    expect(create?.tool.annotations).toMatchObject({
      title: "Create thread",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
    });

    const read = server.tools.find(({ tool }) => tool.name === "read_thread");
    expect(read?.tool.annotations).toMatchObject({
      title: "Read thread",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
    });

    const listModels = server.tools.find(({ tool }) => tool.name === "list_models");
    expect(listModels?.tool.annotations).toMatchObject({
      title: "List models",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });

    const wait = server.tools.find(({ tool }) => tool.name === "wait_threads");
    expect(wait?.tool.annotations).toMatchObject({
      title: "Wait for threads",
      readOnlyHint: true,
      idempotentHint: false,
    });
  }).pipe(Effect.provide(ThreadRegistrationTestLayer)),
);

it("keeps optional thread defaults optional in generated MCP schemas", () => {
  const listModelsSchema = Tool.getJsonSchema(ThreadToolkit.tools.list_models) as {
    readonly properties?: Readonly<Record<string, unknown>>;
    readonly required?: ReadonlyArray<string>;
  };
  const listSchema = Tool.getJsonSchema(ThreadToolkit.tools.list_threads) as {
    readonly properties?: Readonly<Record<string, unknown>>;
    readonly required?: ReadonlyArray<string>;
  };
  const readSchema = Tool.getJsonSchema(ThreadToolkit.tools.read_thread) as {
    readonly properties?: Readonly<Record<string, unknown>>;
    readonly required?: ReadonlyArray<string>;
  };
  const hasNull = (value: unknown): boolean => {
    if (value === "null") return true;
    if (Array.isArray(value)) return value.some(hasNull);
    return typeof value === "object" && value !== null && Object.values(value).some(hasNull);
  };

  expect(listSchema.required ?? []).not.toContain("limit");
  expect(listModelsSchema.required ?? []).not.toContain("driver");
  expect(readSchema.required ?? []).not.toEqual(
    expect.arrayContaining(["turnLimit", "includeOutputs", "maxOutputCharsPerItem"]),
  );
  for (const schema of [
    listSchema.properties?.limit,
    listModelsSchema.properties?.driver,
    readSchema.properties?.turnLimit,
    readSchema.properties?.includeOutputs,
    readSchema.properties?.maxOutputCharsPerItem,
  ]) {
    expect(hasNull(schema)).toBe(false);
  }
});
