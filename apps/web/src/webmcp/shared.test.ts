import { afterEach, describe, expect, it, vi } from "vitest";

import {
  isVisibleWebMcpActivityCall,
  MAX_WEBMCP_COMPLETED_CALLS,
  observeWebMcpRegistry,
  registerWebMcpTool,
  type WebMcpRegistryState,
  webMcpRegistryState,
} from "./shared";
import type { RegisteredWebMcpTool } from "./types";

describe("WebMCP call activity", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("reports active, completed, and failed calls in newest-first order", async () => {
    let registered: RegisteredWebMcpTool | undefined;
    const modelContext = {
      registerTool(tool: RegisteredWebMcpTool) {
        registered = tool;
      },
    };
    vi.stubGlobal("document", {
      modelContext,
    });
    const registration = new AbortController();
    let finishPending: () => void = () => undefined;
    const pendingResult = new Promise<string>((resolve) => {
      finishPending = () => resolve("done");
    });
    const observed: WebMcpRegistryState[] = [];
    const stopObserving = observeWebMcpRegistry((state) => observed.push(state));
    const baseline = webMcpRegistryState();

    await registerWebMcpTool(
      modelContext,
      {
        name: "insert_comment",
        description: "A test tool.",
        inputSchema: {},
        execute(input) {
          if (input === "pending") return pendingResult;
          if (input === "failure") throw new Error("Expected failure");
          return input;
        },
      },
      { signal: registration.signal },
    );
    if (!registered) throw new Error("Expected the tool to be registered.");

    const pendingCall = Promise.resolve(
      registered.execute("pending", { signal: new AbortController().signal }),
    );
    const active = webMcpRegistryState();
    expect(active.activeCallCount).toBe(baseline.activeCallCount + 1);
    expect(active.calls[0]).toMatchObject({
      toolName: "insert_comment",
      status: "active",
      completedAt: null,
    });

    finishPending();
    await expect(pendingCall).resolves.toBe("done");
    const completed = webMcpRegistryState();
    expect(completed.activeCallCount).toBe(baseline.activeCallCount);
    expect(completed.calls[0]).toMatchObject({
      toolName: "insert_comment",
      status: "succeeded",
    });
    expect(completed.calls[0]?.completedAt).toEqual(expect.any(Number));

    await expect(
      Promise.resolve(registered.execute("failure", { signal: new AbortController().signal })),
    ).rejects.toThrow("Expected failure");
    const failed = webMcpRegistryState();
    expect(failed.activeCallCount).toBe(baseline.activeCallCount);
    expect(failed.calls.slice(0, 2).map((call) => call.status)).toEqual(["failed", "succeeded"]);
    expect(observed.some((state) => state.activeCallCount > baseline.activeCallCount)).toBe(true);

    stopObserving();
    registration.abort();
  });

  it("keeps every active call while bounding completed history", async () => {
    let registered: RegisteredWebMcpTool | undefined;
    const modelContext = {
      registerTool(tool: RegisteredWebMcpTool) {
        registered = tool;
      },
    };
    vi.stubGlobal("document", { modelContext });
    const registration = new AbortController();
    let finishPending: () => void = () => undefined;
    const pendingResult = new Promise<string>((resolve) => {
      finishPending = () => resolve("done");
    });

    await registerWebMcpTool(
      modelContext,
      {
        name: "insert_comment",
        description: "A bounded-history test tool.",
        inputSchema: {},
        execute: () => pendingResult,
      },
      { signal: registration.signal },
    );
    if (!registered) throw new Error("Expected the tool to be registered.");
    const registeredTool = registered;

    const callCount = MAX_WEBMCP_COMPLETED_CALLS + 5;
    const pendingCalls = Array.from({ length: callCount }, () =>
      Promise.resolve(registeredTool.execute({}, { signal: new AbortController().signal })),
    );
    expect(webMcpRegistryState().calls.filter((call) => call.status === "active")).toHaveLength(
      callCount,
    );

    finishPending();
    await Promise.all(pendingCalls);
    const completed = webMcpRegistryState().calls;
    expect(completed.filter((call) => call.status !== "active")).toHaveLength(
      MAX_WEBMCP_COMPLETED_CALLS,
    );
    expect(completed.every((call) => call.toolName === "insert_comment")).toBe(true);
    registration.abort();
  });

  it("drops completed watch polling before it can evict visible activity", async () => {
    const registered = new Map<string, RegisteredWebMcpTool>();
    const modelContext = {
      registerTool(tool: RegisteredWebMcpTool) {
        registered.set(tool.name, tool);
      },
    };
    vi.stubGlobal("document", { modelContext });
    const registration = new AbortController();
    for (const name of ["insert_comment", "watch_board"]) {
      await registerWebMcpTool(
        modelContext,
        {
          name,
          description: "A retention test tool.",
          inputSchema: {},
          execute: () => name,
        },
        { signal: registration.signal },
      );
    }
    const visibleTool = registered.get("insert_comment");
    const watchTool = registered.get("watch_board");
    if (!visibleTool || !watchTool) throw new Error("Expected both tools to be registered.");

    await visibleTool.execute({}, { signal: new AbortController().signal });
    for (let index = 0; index < MAX_WEBMCP_COMPLETED_CALLS + 5; index += 1) {
      await watchTool.execute({}, { signal: new AbortController().signal });
    }

    const completed = webMcpRegistryState().calls.filter((call) => call.status !== "active");
    expect(completed.some((call) => call.toolName === "insert_comment")).toBe(true);
    expect(completed.every(isVisibleWebMcpActivityCall)).toBe(true);
    registration.abort();
  });
});
