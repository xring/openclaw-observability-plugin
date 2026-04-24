/**
 * Regression tests for plugin hook registration.
 *
 * Covers ISI-730: the plugin must no longer register `before_agent_start`
 * and must register `before_model_resolve` + `before_prompt_build` instead.
 * Span creation + attribute enrichment are exercised end-to-end against a
 * stub `api` object that captures the typed handlers.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Counter, Histogram, Span, Tracer, UpDownCounter } from "@opentelemetry/api";

import { registerHooks } from "../src/hooks.js";
import type { OtelObservabilityConfig } from "../src/config.js";
import type { TelemetryRuntime } from "../src/telemetry.js";

// ── Test doubles ────────────────────────────────────────────────────

interface SpanSpy {
  attrs: Record<string, unknown>;
  ended: boolean;
  status: { code?: number; message?: string };
  spanName: string;
}

function createSpanSpy(name: string): Span & SpanSpy {
  const spy: SpanSpy = {
    attrs: {},
    ended: false,
    status: {},
    spanName: name,
  };
  const span = {
    ...spy,
    setAttribute(key: string, value: unknown) {
      spy.attrs[key] = value;
      return this;
    },
    setAttributes(values: Record<string, unknown>) {
      Object.assign(spy.attrs, values);
      return this;
    },
    setStatus(status: { code?: number; message?: string }) {
      spy.status = status;
      return this;
    },
    addEvent() {
      return this;
    },
    addLink() {
      return this;
    },
    addLinks() {
      return this;
    },
    setStatusFromException() {
      return this;
    },
    recordException() {
      return this;
    },
    updateName(n: string) {
      spy.spanName = n;
      return this;
    },
    end() {
      spy.ended = true;
    },
    isRecording() {
      return !spy.ended;
    },
    spanContext() {
      return { traceId: "t", spanId: "s", traceFlags: 1 };
    },
  };
  return span as unknown as Span & SpanSpy;
}

function createTracerSpy(): { tracer: Tracer; spans: Array<Span & SpanSpy> } {
  const spans: Array<Span & SpanSpy> = [];
  const tracer = {
    startSpan(name: string, options?: { attributes?: Record<string, unknown> }) {
      const span = createSpanSpy(name);
      if (options?.attributes) {
        Object.assign((span as unknown as SpanSpy).attrs, options.attributes);
      }
      spans.push(span);
      return span;
    },
    startActiveSpan: (() => {
      throw new Error("startActiveSpan not used by hooks");
    }) as Tracer["startActiveSpan"],
  } as Tracer;
  return { tracer, spans };
}

function noopCounter(): Counter {
  return { add: vi.fn() } as unknown as Counter;
}
function noopUpDownCounter(): UpDownCounter {
  return { add: vi.fn() } as unknown as UpDownCounter;
}
function noopHistogram(): Histogram {
  return { record: vi.fn() } as unknown as Histogram;
}

function createTelemetry(): { telemetry: TelemetryRuntime; spans: Array<Span & SpanSpy> } {
  const { tracer, spans } = createTracerSpy();
  const telemetry: TelemetryRuntime = {
    tracer,
    meter: {} as TelemetryRuntime["meter"],
    counters: {
      llmRequests: noopCounter(),
      llmErrors: noopCounter(),
      tokensTotal: noopCounter(),
      tokensPrompt: noopCounter(),
      tokensCompletion: noopCounter(),
      toolCalls: noopCounter(),
      toolErrors: noopCounter(),
      sessionResets: noopCounter(),
      messagesReceived: noopCounter(),
      messagesSent: noopCounter(),
      securityEvents: noopCounter(),
      sensitiveFileAccess: noopCounter(),
      promptInjection: noopCounter(),
      dangerousCommand: noopCounter(),
    } as unknown as TelemetryRuntime["counters"],
    histograms: {
      agentTurnDuration: noopHistogram(),
      genAiTokenUsage: noopHistogram(),
      genAiOperationDuration: noopHistogram(),
    } as unknown as TelemetryRuntime["histograms"],
    gauges: {} as unknown as TelemetryRuntime["gauges"],
    shutdown: async () => {},
  };
  return { telemetry, spans };
}

type TypedHandler = (event: unknown, ctx: unknown) => unknown;
type EventStreamHandler = (event: unknown) => unknown;

function createStubApi() {
  const typedHooks = new Map<string, TypedHandler>();
  const eventStreamHooks = new Map<string, EventStreamHandler>();
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  const api = {
    logger,
    on(name: string, handler: TypedHandler) {
      typedHooks.set(name, handler);
    },
    registerHook(events: string | string[], handler: EventStreamHandler) {
      const list = Array.isArray(events) ? events : [events];
      for (const ev of list) {
        eventStreamHooks.set(ev, handler);
      }
    },
  };
  return { api, typedHooks, eventStreamHooks, logger };
}

const config: OtelObservabilityConfig = {
  endpoint: "http://localhost:4318",
  protocol: "http",
  serviceName: "test",
  headers: {},
  traces: true,
  metrics: true,
  logs: false,
  captureContent: false,
  metricsIntervalMs: 30_000,
  resourceAttributes: {},
};

// ── Tests ───────────────────────────────────────────────────────────

describe("plugin hook registration (ISI-730 migration)", () => {
  let stopHooks: () => void;

  beforeEach(() => {
    // nothing — each test sets up its own stubs
  });

  it("registers the new phase hooks and NOT the legacy before_agent_start", () => {
    const { api, typedHooks, logger } = createStubApi();
    const { telemetry } = createTelemetry();

    stopHooks = registerHooks(api, telemetry, config);

    expect(typedHooks.has("before_model_resolve")).toBe(true);
    expect(typedHooks.has("before_prompt_build")).toBe(true);
    expect(typedHooks.has("before_agent_start")).toBe(false);

    // Other existing typed hooks are still registered.
    expect(typedHooks.has("message_received")).toBe(true);
    expect(typedHooks.has("llm_input")).toBe(true);
    expect(typedHooks.has("llm_output")).toBe(true);
    expect(typedHooks.has("tool_result_persist")).toBe(true);
    expect(typedHooks.has("message_sent")).toBe(true);
    expect(typedHooks.has("agent_end")).toBe(true);

    expect(logger.info).toHaveBeenCalledWith(
      "[otel] Registered before_model_resolve hook (via api.on)",
    );
    expect(logger.info).toHaveBeenCalledWith(
      "[otel] Registered before_prompt_build hook (via api.on)",
    );

    stopHooks();
  });

  it("before_model_resolve creates an agent.turn span with agent_id + session_key", () => {
    const { api, typedHooks } = createStubApi();
    const { telemetry, spans } = createTelemetry();
    stopHooks = registerHooks(api, telemetry, config);

    const handler = typedHooks.get("before_model_resolve");
    expect(handler).toBeDefined();
    const result = handler!({ prompt: "hi" }, {
      agentId: "claude-4",
      sessionKey: "session-123",
    });
    // Must NOT return a value — we do not override provider/model.
    expect(result).toBeUndefined();

    const turnSpan = spans.find((s) => s.spanName === "openclaw.agent.turn");
    expect(turnSpan).toBeDefined();
    expect(turnSpan!.attrs["openclaw.agent.id"]).toBe("claude-4");
    expect(turnSpan!.attrs["openclaw.session.key"]).toBe("session-123");
    expect(turnSpan!.attrs["gen_ai.agent.id"]).toBe("claude-4");
    expect(turnSpan!.attrs["gen_ai.conversation.id"]).toBe("session-123");
    expect(turnSpan!.attrs["code.function"]).toBe("before_model_resolve");
    // Model is NOT known at this point — must NOT be set.
    expect(turnSpan!.attrs["gen_ai.request.model"]).toBeUndefined();
    expect(turnSpan!.attrs["openclaw.agent.model"]).toBeUndefined();

    stopHooks();
  });

  it("before_prompt_build enriches the existing agent.turn span with prompt + history size", () => {
    const { api, typedHooks } = createStubApi();
    const { telemetry, spans } = createTelemetry();
    stopHooks = registerHooks(api, telemetry, config);

    const resolveHandler = typedHooks.get("before_model_resolve")!;
    const buildHandler = typedHooks.get("before_prompt_build")!;

    // 1. agent turn span starts in before_model_resolve
    resolveHandler({ prompt: "hi" }, { agentId: "a", sessionKey: "s" });

    // 2. before_prompt_build enriches it
    const out = buildHandler(
      {
        prompt: "user asked about X",
        messages: [{ role: "user" }, { role: "assistant" }, { role: "user" }],
      },
      { agentId: "a", sessionKey: "s" },
    );
    expect(out).toBeUndefined();

    const turnSpan = spans.find((s) => s.spanName === "openclaw.agent.turn");
    expect(turnSpan).toBeDefined();
    expect(turnSpan!.attrs["openclaw.prompt.chars"]).toBe("user asked about X".length);
    expect(turnSpan!.attrs["openclaw.session.message_count"]).toBe(3);

    stopHooks();
  });

  it("before_prompt_build is a no-op when no agent span has been started", () => {
    const { api, typedHooks } = createStubApi();
    const { telemetry, spans } = createTelemetry();
    stopHooks = registerHooks(api, telemetry, config);

    const buildHandler = typedHooks.get("before_prompt_build")!;
    // Never ran before_model_resolve → no agent span exists.
    const out = buildHandler(
      { prompt: "x", messages: [] },
      { agentId: "a", sessionKey: "orphan-session" },
    );
    expect(out).toBeUndefined();
    // No agent.turn span created by the build hook.
    expect(spans.find((s) => s.spanName === "openclaw.agent.turn")).toBeUndefined();

    stopHooks();
  });

  it("end-to-end: message_received → before_model_resolve → before_prompt_build produces a connected turn span", () => {
    const { api, typedHooks } = createStubApi();
    const { telemetry, spans } = createTelemetry();
    stopHooks = registerHooks(api, telemetry, config);

    const received = typedHooks.get("message_received")!;
    const resolve = typedHooks.get("before_model_resolve")!;
    const build = typedHooks.get("before_prompt_build")!;

    // Await message_received — async handler.
    return Promise.resolve(
      received(
        { channel: "cli", sessionKey: "s1", from: "user" },
        { sessionKey: "s1" },
      ),
    ).then(() => {
      resolve({ prompt: "hi" }, { agentId: "a1", sessionKey: "s1" });
      build({ prompt: "hi", messages: [] }, { agentId: "a1", sessionKey: "s1" });

      const request = spans.find((s) => s.spanName === "openclaw.request");
      const turn = spans.find((s) => s.spanName === "openclaw.agent.turn");
      expect(request).toBeDefined();
      expect(turn).toBeDefined();
      expect(turn!.attrs["openclaw.session.key"]).toBe("s1");
      expect(turn!.attrs["openclaw.agent.id"]).toBe("a1");

      stopHooks();
    });
  });
});
