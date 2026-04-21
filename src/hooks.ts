/**
 * OpenClaw event hooks — captures tool executions, agent turns, messages,
 * and gateway lifecycle as connected OTel traces.
 *
 * Trace structure per request:
 *   openclaw.request (root span, covers full message → reply lifecycle)
 *   ├── openclaw.agent.turn (agent processing span)
 *   │   ├── tool.exec (tool call)
 *   │   ├── tool.Read (tool call)
 *   │   ├── anthropic.chat (auto-instrumented by OpenLLMetry)
 *   │   └── tool.write (tool call)
 *   └── (future: message.sent span)
 *
 * Context propagation:
 *   - message_received: creates root span, stores in sessionContextMap
 *   - before_agent_start: creates child "agent turn" span under root
 *   - tool_result_persist: creates child tool span under agent turn
 *   - agent_end: ends the agent turn span
 *
 * IMPORTANT: OpenClaw has TWO hook registration systems:
 *   - api.registerHook() → event-stream hooks (command:new, gateway:startup)
 *   - api.on()           → typed plugin hooks (tool_result_persist, agent_end)
 */

import { SpanKind, SpanStatusCode, context, trace, type Span, type Context } from "@opentelemetry/api";
import type { TelemetryRuntime } from "./telemetry.js";
import type { OtelObservabilityConfig } from "./config.js";
import { activeAgentSpans, getPendingUsage, enrichSpanWithUsage, hasDiagnosticsSupport } from "./diagnostics.js";
import { checkToolSecurity, checkMessageSecurity, type SecurityCounters } from "./security.js";
import {
  GEN_AI_AGENT_ID,
  GEN_AI_AGENT_NAME,
  GEN_AI_CONVERSATION_ID,
  GEN_AI_OPERATION_NAME,
  GEN_AI_REQUEST_MODEL,
  GEN_AI_RESPONSE_MODEL,
  GEN_AI_SYSTEM,
  GEN_AI_TOKEN_TYPE,
  GEN_AI_TOOL_CALL_ID,
  GEN_AI_TOOL_NAME,
  GEN_AI_USAGE_INPUT_TOKENS,
  GEN_AI_USAGE_OUTPUT_TOKENS,
  OP_CHAT,
  OP_EXECUTE_TOOL,
  OP_INVOKE_AGENT,
  TOKEN_TYPE_INPUT,
  TOKEN_TYPE_OUTPUT,
  CODE_FUNCTION,
  CODE_NAMESPACE,
  ERROR_TYPE,
  spanNameExecuteTool,
} from "./semconv.js";

const CODE_NS = "openclaw.otel.hooks";

/** Active trace context for a session — allows connecting spans into one trace. */
interface SessionTraceContext {
  rootSpan: Span;
  rootContext: Context;
  agentSpan?: Span;
  agentContext?: Context;
  /** Current in-flight LLM call span, set on `llm_input`, closed on `llm_output`. */
  llmSpan?: Span;
  /** When the in-flight LLM call started (monotonic ms), for duration fallback. */
  llmStartTime?: number;
  startTime: number;
}

/** Map of sessionKey → active trace context. Cleaned up on agent_end. */
const sessionContextMap = new Map<string, SessionTraceContext>();

/**
 * Register all plugin hooks on the OpenClaw plugin API.
 *
 * Both `initTelemetry()` and this function run during the synchronous
 * `register()` phase so OpenClaw sees the typed hooks before the gateway
 * boots AND so telemetry exists in embedded runner contexts (CLI agent,
 * cron, heartbeat, task-runner, subagent) where `service.start()` is a
 * no-op. The telemetry runtime is therefore non-null at hook-fire time.
 */
export function registerHooks(
  api: any,
  telemetry: TelemetryRuntime,
  config: OtelObservabilityConfig
): () => void {
  const logger = api.logger;
  const { tracer, counters, histograms } = telemetry;
  const securityCounters: SecurityCounters = {
    securityEvents: counters.securityEvents,
    sensitiveFileAccess: counters.sensitiveFileAccess,
    promptInjection: counters.promptInjection,
    dangerousCommand: counters.dangerousCommand,
  };

  // ═══════════════════════════════════════════════════════════════════
  // TYPED HOOKS — registered via api.on() into registry.typedHooks
  // ═══════════════════════════════════════════════════════════════════

  // ── message_received ─────────────────────────────────────────────
  // Creates the ROOT span for the entire request lifecycle.
  // All subsequent spans (agent, tools) become children of this span.

  api.on(
    "message_received",
    async (event: any, ctx: any) => {
      try {
        const channel = event?.channel || "unknown";
        const sessionKey = event?.sessionKey || ctx?.sessionKey || "unknown";
        const from = event?.from || event?.senderId || "unknown";
        const messageText = event?.text || event?.message || "";

        // Create root span for this request
        const rootSpan = tracer.startSpan("openclaw.request", {
          kind: SpanKind.SERVER,
          attributes: {
            // openclaw legacy
            "openclaw.message.channel": channel,
            "openclaw.session.key": sessionKey,
            "openclaw.message.direction": "inbound",
            "openclaw.message.from": from,
            // GenAI conversation correlation
            [GEN_AI_CONVERSATION_ID]: sessionKey,
            // code.*
            [CODE_FUNCTION]: "message_received",
            [CODE_NAMESPACE]: CODE_NS,
          },
        });

        // ═══ SECURITY DETECTION 2: Prompt Injection ═══════════════
        if (messageText && typeof messageText === "string" && messageText.length > 0) {
          const securityEvent = checkMessageSecurity(
            messageText,
            rootSpan,
            securityCounters,
            sessionKey
          );
          if (securityEvent) {
            logger.warn?.(`[otel] SECURITY: ${securityEvent.detection} - ${securityEvent.description}`);
          }
        }

        // Optionally capture inbound message content
        if (config.captureContent && messageText) {
          rootSpan.setAttribute("gen_ai.prompt", messageText.slice(0, 1000));
        }

        // Store the context so child spans can reference it
        const rootContext = trace.setSpan(context.active(), rootSpan);

        sessionContextMap.set(sessionKey, {
          rootSpan,
          rootContext,
          startTime: Date.now(),
        });

        // Record message count metric
        counters.messagesReceived.add(1, {
          "openclaw.message.channel": channel,
        });

        logger.debug?.(`[otel] Root span started for session=${sessionKey}`);
      } catch {
        // Never let telemetry errors break the main flow
      }
    },
    { priority: 100 } // High priority — run first to establish context
  );

  logger.info("[otel] Registered message_received hook (via api.on)");

  // ── before_agent_start ───────────────────────────────────────────
  // Creates an "agent turn" child span under the root request span.

  api.on(
    "before_agent_start",
    (event: any, ctx: any) => {
      try {
        const sessionKey = event?.sessionKey || ctx?.sessionKey || "unknown";
        const agentId = event?.agentId || ctx?.agentId || "unknown";
        const model = event?.model || "unknown";

        const sessionCtx = sessionContextMap.get(sessionKey);
        const parentContext = sessionCtx?.rootContext || context.active();

        // Create agent turn span as child of root span.
        // Name is kept as `openclaw.agent.turn` for dashboard backwards-compat;
        // GenAI stable attributes below make it semconv-compliant.
        const agentSpan = tracer.startSpan(
          "openclaw.agent.turn",
          {
            kind: SpanKind.INTERNAL,
            attributes: {
              // GenAI stable
              [GEN_AI_OPERATION_NAME]: OP_INVOKE_AGENT,
              [GEN_AI_AGENT_ID]: agentId,
              [GEN_AI_AGENT_NAME]: agentId,
              [GEN_AI_CONVERSATION_ID]: sessionKey,
              [GEN_AI_REQUEST_MODEL]: model,
              // code.*
              [CODE_FUNCTION]: "before_agent_start",
              [CODE_NAMESPACE]: CODE_NS,
              // openclaw legacy (preserve for dashboards)
              "openclaw.agent.id": agentId,
              "openclaw.session.key": sessionKey,
              "openclaw.agent.model": model,
            },
          },
          parentContext
        );

        const agentContext = trace.setSpan(parentContext, agentSpan);

        // Store agent span context for tool spans
        if (sessionCtx) {
          sessionCtx.agentSpan = agentSpan;
          sessionCtx.agentContext = agentContext;
        } else {
          // No root span (e.g., heartbeat) — create a standalone context
          sessionContextMap.set(sessionKey, {
            rootSpan: agentSpan,
            rootContext: agentContext,
            agentSpan,
            agentContext,
            startTime: Date.now(),
          });
        }

        // Register in activeAgentSpans for diagnostics integration
        activeAgentSpans.set(sessionKey, agentSpan);

        logger.debug?.(`[otel] Agent turn span started: agent=${agentId}, session=${sessionKey}`);
      } catch {
        // Silently ignore
      }

      // Return undefined — don't modify system prompt
      return undefined;
    },
    { priority: 90 }
  );

  logger.info("[otel] Registered before_agent_start hook (via api.on)");

  // ── llm_input ────────────────────────────────────────────────────
  // Start a CLIENT span for the outbound LLM call. The span is the
  // OpenClaw-level record of the round-trip (not the HTTP transport
  // layer — OpenLLMetry's AnthropicInstrumentation covers that if
  // the preload is active). Closed in `llm_output`.

  api.on(
    "llm_input",
    (event: any, ctx: any) => {
      try {
        const sessionKey = event?.sessionKey || ctx?.sessionKey || "unknown";
        const agentId = event?.agentId || ctx?.agentId || "unknown";
        const model = event?.model || event?.requestModel || ctx?.model || "unknown";
        const provider = event?.provider || ctx?.provider || "unknown";

        const sessionCtx = sessionContextMap.get(sessionKey);
        // If llm_input fires without a prior agent span (unusual), fall back
        // to root context so the CLIENT span still attaches to the trace.
        const parentContext =
          sessionCtx?.agentContext || sessionCtx?.rootContext || context.active();

        const llmSpan = tracer.startSpan(
          "openclaw.llm.call",
          {
            kind: SpanKind.CLIENT,
            attributes: {
              // GenAI stable
              [GEN_AI_OPERATION_NAME]: OP_CHAT,
              [GEN_AI_SYSTEM]: provider,
              [GEN_AI_REQUEST_MODEL]: model,
              [GEN_AI_CONVERSATION_ID]: sessionKey,
              [GEN_AI_AGENT_ID]: agentId,
              // code.*
              [CODE_FUNCTION]: "llm_input",
              [CODE_NAMESPACE]: CODE_NS,
              // openclaw legacy
              "openclaw.agent.id": agentId,
              "openclaw.session.key": sessionKey,
              "openclaw.llm.provider": provider,
              "openclaw.llm.request_model": model,
            },
          },
          parentContext
        );

        // Optionally capture LLM prompt content
        if (config.captureContent) {
          const promptContent = event?.messages || event?.prompt || event?.content;
          if (promptContent) {
            const promptStr = typeof promptContent === "string"
              ? promptContent
              : JSON.stringify(promptContent);
            llmSpan.setAttribute("gen_ai.prompt", promptStr.slice(0, 1000));
          }
        }

        if (sessionCtx) {
          sessionCtx.llmSpan = llmSpan;
          sessionCtx.llmStartTime = Date.now();
        } else {
          // No session context at all — end the span right away to avoid
          // leaking an in-flight span with no closer.
          llmSpan.setStatus({ code: SpanStatusCode.OK });
          llmSpan.end();
        }

        logger.debug?.(`[otel] LLM call span started: session=${sessionKey}, model=${model}`);
      } catch {
        // Never let telemetry errors break the main flow
      }

      return undefined;
    },
    { priority: 80 }
  );

  logger.info("[otel] Registered llm_input hook (via api.on)");

  // ── llm_output ───────────────────────────────────────────────────
  // Closes the CLIENT span opened in `llm_input`, recording response
  // model, token counts, and (when available) error state.

  api.on(
    "llm_output",
    (event: any, ctx: any) => {
      try {
        const sessionKey = event?.sessionKey || ctx?.sessionKey || "unknown";
        const sessionCtx = sessionContextMap.get(sessionKey);
        const llmSpan = sessionCtx?.llmSpan;
        if (!llmSpan) return undefined;

        const responseModel =
          event?.responseModel || event?.model || ctx?.model || "unknown";
        const usage = event?.usage || {};
        const inputTokens =
          usage.input ?? usage.inputTokens ?? usage.input_tokens ?? 0;
        const outputTokens =
          usage.output ?? usage.outputTokens ?? usage.output_tokens ?? 0;
        const cacheRead = usage.cacheRead ?? usage.cache_read_tokens ?? 0;
        const cacheWrite = usage.cacheWrite ?? usage.cache_write_tokens ?? 0;
        const totalTokens =
          usage.total ?? inputTokens + outputTokens + cacheRead + cacheWrite;

        llmSpan.setAttribute(GEN_AI_RESPONSE_MODEL, responseModel);
        if (inputTokens > 0) {
          llmSpan.setAttribute("gen_ai.usage.input_tokens", inputTokens);
        }
        if (outputTokens > 0) {
          llmSpan.setAttribute("gen_ai.usage.output_tokens", outputTokens);
        }
        if (cacheRead > 0) {
          llmSpan.setAttribute("gen_ai.usage.cache_read_tokens", cacheRead);
        }
        if (cacheWrite > 0) {
          llmSpan.setAttribute("gen_ai.usage.cache_write_tokens", cacheWrite);
        }
        if (totalTokens > 0) {
          llmSpan.setAttribute("gen_ai.usage.total_tokens", totalTokens);
        }

        const durationMs =
          typeof event?.durationMs === "number"
            ? event.durationMs
            : sessionCtx?.llmStartTime
              ? Date.now() - sessionCtx.llmStartTime
              : undefined;
        if (typeof durationMs === "number") {
          llmSpan.setAttribute("openclaw.llm.duration_ms", durationMs);
        }

        // Optionally captureLLM completion content
        if (config.captureContent) {
          const completionContent = event?.completion || event?.content || event?.text;
          if (completionContent) {
            const compStr = typeof completionContent === "string"
              ? completionContent
              : JSON.stringify(completionContent);
            llmSpan.setAttribute("gen_ai.completion", compStr.slice(0, 10000));
          }
        }

        const errorMsg = event?.error;
        if (errorMsg) {
          const errStr = String(errorMsg).slice(0, 500);
          llmSpan.setAttribute(ERROR_TYPE, "llm_error");
          llmSpan.recordException({ name: "LlmError", message: errStr });
          llmSpan.setStatus({ code: SpanStatusCode.ERROR, message: errStr.slice(0, 200) });
        } else {
          llmSpan.setStatus({ code: SpanStatusCode.OK });
        }

        llmSpan.end();
        sessionCtx!.llmSpan = undefined;
        sessionCtx!.llmStartTime = undefined;
      } catch {
        // Never let telemetry errors break the main flow
      }

      return undefined;
    },
    { priority: -80 }
  );

  logger.info("[otel] Registered llm_output hook (via api.on)");

  // ── tool_result_persist ──────────────────────────────────────────
  // Creates a child span under the agent turn span for each tool call.
  // SYNCHRONOUS — must not return a Promise.

  api.on(
    "tool_result_persist",
    (event: any, ctx: any) => {
      try {
        const toolName = event?.toolName || "unknown";
        const toolCallId = event?.toolCallId || "";
        const isSynthetic = event?.isSynthetic === true;
        const sessionKey = ctx?.sessionKey || "unknown";
        const agentId = ctx?.agentId || "unknown";

        // Tool input is available in event.input for security checks
        const toolInput = event?.input || event?.toolInput || event?.args || {};

        // Record metric — use stable GenAI attribute keys, keep legacy mirrors.
        counters.toolCalls.add(1, {
          [GEN_AI_TOOL_NAME]: toolName,
          [GEN_AI_OPERATION_NAME]: OP_EXECUTE_TOOL,
          [GEN_AI_CONVERSATION_ID]: sessionKey,
          "tool.name": toolName,
          "session.key": sessionKey,
        });

        // Get parent context — prefer agent turn span, fall back to root
        const sessionCtx = sessionContextMap.get(sessionKey);
        const parentContext = sessionCtx?.agentContext || sessionCtx?.rootContext || context.active();

        // Create tool span as child of agent turn.
        // Span name follows GenAI stable: `execute_tool {tool.name}`.
        const span = tracer.startSpan(
          spanNameExecuteTool(toolName),
          {
            kind: SpanKind.INTERNAL,
            attributes: {
              // GenAI stable
              [GEN_AI_OPERATION_NAME]: OP_EXECUTE_TOOL,
              [GEN_AI_TOOL_NAME]: toolName,
              [GEN_AI_TOOL_CALL_ID]: toolCallId,
              [GEN_AI_CONVERSATION_ID]: sessionKey,
              [GEN_AI_AGENT_ID]: agentId,
              // code.*
              [CODE_FUNCTION]: "tool_result_persist",
              [CODE_NAMESPACE]: CODE_NS,
              // openclaw legacy (preserve for dashboards)
              "openclaw.tool.name": toolName,
              "openclaw.tool.call_id": toolCallId,
              "openclaw.tool.is_synthetic": isSynthetic,
              "openclaw.session.key": sessionKey,
              "openclaw.agent.id": agentId,
            },
          },
          parentContext
        );

        // ═══ SECURITY DETECTION 1 & 3: File Access & Dangerous Commands ═══
        const securityEvent = checkToolSecurity(
          toolName,
          toolInput,
          span,
          securityCounters,
          sessionKey,
          agentId
        );
        if (securityEvent) {
          logger.warn?.(`[otel] SECURITY: ${securityEvent.detection} - ${securityEvent.description}`);
          // Add tool input details to span for forensics
          if (toolInput) {
            const inputStr = JSON.stringify(toolInput).slice(0, 1000);
            span.setAttribute("openclaw.tool.input_preview", inputStr);
          }
        }

        // Inspect the message for result metadata
        const message = event?.message;
        if (message) {
          const contentArray = message?.content;
          if (contentArray && Array.isArray(contentArray)) {
            const textParts = contentArray
              .filter((c: any) => c.type === "text")
              .map((c: any) => String(c.text || ""));
            const totalChars = textParts.reduce((sum: number, t: string) => sum + t.length, 0);
            span.setAttribute("openclaw.tool.result_chars", totalChars);
            span.setAttribute("openclaw.tool.result_parts", contentArray.length);
          }

          if (message?.is_error === true || message?.isError === true) {
            counters.toolErrors.add(1, {
              [GEN_AI_TOOL_NAME]: toolName,
              "tool.name": toolName,
            });
            span.setAttribute(ERROR_TYPE, "tool_execution_error");
            span.setStatus({ code: SpanStatusCode.ERROR, message: "Tool execution error" });
          } else if (!securityEvent) {
            // Only set OK status if no security event
            span.setStatus({ code: SpanStatusCode.OK });
          }
        } else if (!securityEvent) {
          span.setStatus({ code: SpanStatusCode.OK });
        }

        span.end();
      } catch {
        // Never let telemetry errors break the main flow
      }

      // Return undefined to keep the tool result unchanged
      return undefined;
    },
    { priority: -100 }
  );

  logger.info("[otel] Registered tool_result_persist hook (via api.on)");

  // ── message_sent ─────────────────────────────────────────────────
  // Records the outbound reply as a short INTERNAL span under the root
  // request span. Also increments the `openclaw.messages.sent` counter
  // that the plugin already declares but has never populated.

  api.on(
    "message_sent",
    (event: any, ctx: any) => {
      try {
        const sessionKey = event?.sessionKey || ctx?.sessionKey || "unknown";
        const channel = event?.channel || ctx?.channel || "unknown";
        const to = event?.to || event?.recipientId || "unknown";
        const messageText = event?.text || event?.message || "";

        logger.info(`[otel] Outbound message: session=${sessionKey}, channel=${channel}, to=${to}, text=${messageText}, text_type=${typeof messageText}`);

        const charCount =
          typeof messageText === "string" ? messageText.length : 0;

        const sessionCtx = sessionContextMap.get(sessionKey);
        const parentContext =
          sessionCtx?.rootContext || sessionCtx?.agentContext || context.active();

        const span = tracer.startSpan(
          "openclaw.message.sent",
          {
            kind: SpanKind.INTERNAL,
            attributes: {
              // openclaw legacy
              "openclaw.message.channel": channel,
              "openclaw.session.key": sessionKey,
              "openclaw.message.direction": "outbound",
              "openclaw.message.to": to,
              "openclaw.message.chars": charCount,
              // GenAI conversation correlation
              [GEN_AI_CONVERSATION_ID]: sessionKey,
              // code.*
              [CODE_FUNCTION]: "message_sent",
              [CODE_NAMESPACE]: CODE_NS,
            },
          },
          parentContext
        );

        counters.messagesSent.add(1, {
          "openclaw.message.channel": channel,
        });

        // Optionally capture outbound reply content
        if (config.captureContent && messageText) {
          span.setAttribute("gen_ai.completion", messageText.slice(0, 10000));
        }

        span.setStatus({ code: SpanStatusCode.OK });
        span.end();

        logger.debug?.(`[otel] Outbound message span recorded: session=${sessionKey}, channel=${channel}, chars=${charCount}`);
      } catch {
        // Never let telemetry errors break the main flow
      }

      return undefined;
    },
    { priority: -90 }
  );

  logger.info("[otel] Registered message_sent hook (via api.on)");

  // ── agent_end ────────────────────────────────────────────────────
  // Ends the agent turn span AND the root request span.
  // Event shape from OpenClaw:
  //   event: { messages, success, error?, durationMs }
  //   ctx:   { agentId, sessionKey, workspaceDir, messageProvider? }
  // Token usage is embedded in the last assistant message's .usage field.

  api.on(
    "agent_end",
    async (event: any, ctx: any) => {
      try {
        const sessionKey = event?.sessionKey || ctx?.sessionKey || "unknown";
        const agentId = event?.agentId || ctx?.agentId || "unknown";
        const durationMs = event?.durationMs;
        const success = event?.success !== false;
        const errorMsg = event?.error;

        // Try to get usage from diagnostic events (includes cost!)
        const diagUsage = getPendingUsage(sessionKey);

        // Fallback: Extract token usage from the messages array
        const messages: any[] = event?.messages || [];
        let totalInputTokens = 0;
        let totalOutputTokens = 0;
        let cacheReadTokens = 0;
        let cacheWriteTokens = 0;
        let model = "unknown";
        let costUsd: number | undefined;

        if (diagUsage) {
          // Use diagnostic event data (more accurate, includes cost)
          totalInputTokens = diagUsage.usage.input || 0;
          totalOutputTokens = diagUsage.usage.output || 0;
          cacheReadTokens = diagUsage.usage.cacheRead || 0;
          cacheWriteTokens = diagUsage.usage.cacheWrite || 0;
          model = diagUsage.model || "unknown";
          costUsd = diagUsage.costUsd;
          logger.debug?.(`[otel] agent_end using diagnostic data: cost=$${costUsd?.toFixed(4) || "?"}`);
        } else {
          // Fallback: parse messages manually
          for (const msg of messages) {
            if (msg?.role === "assistant" && msg?.usage) {
              const u = msg.usage;
              // pi-ai stores usage as .input/.output (normalized names)
              if (typeof u.input === "number") totalInputTokens += u.input;
              else if (typeof u.inputTokens === "number") totalInputTokens += u.inputTokens;
              else if (typeof u.input_tokens === "number") totalInputTokens += u.input_tokens;

              if (typeof u.output === "number") totalOutputTokens += u.output;
              else if (typeof u.outputTokens === "number") totalOutputTokens += u.outputTokens;
              else if (typeof u.output_tokens === "number") totalOutputTokens += u.output_tokens;

              if (typeof u.cacheRead === "number") cacheReadTokens += u.cacheRead;
              if (typeof u.cacheWrite === "number") cacheWriteTokens += u.cacheWrite;
            }
            if (msg?.role === "assistant" && msg?.model) {
              model = msg.model;
            }
          }
        }

        const totalTokens = totalInputTokens + totalOutputTokens + cacheReadTokens + cacheWriteTokens;
        logger.debug?.(`[otel] agent_end tokens: input=${totalInputTokens}, output=${totalOutputTokens}, cache_read=${cacheReadTokens}, cache_write=${cacheWriteTokens}, model=${model}`);

        const sessionCtx = sessionContextMap.get(sessionKey);

        // Safety net: close any leftover in-flight LLM span so it
        // doesn't leak past the agent turn.
        // Some providers (e.g., ZAI/GLM) don't emit llm_output events,
        // so we populate the span with token data from agent_end diagnostics
        // and close it with OK status instead of ERROR.
        if (sessionCtx?.llmSpan) {
          try {
            // Populate token data from agent_end diagnostics if available
            if (totalInputTokens > 0) {
              sessionCtx.llmSpan.setAttribute("gen_ai.usage.input_tokens", totalInputTokens);
            }
            if (totalOutputTokens > 0) {
              sessionCtx.llmSpan.setAttribute("gen_ai.usage.output_tokens", totalOutputTokens);
            }
            if (cacheReadTokens > 0) {
              sessionCtx.llmSpan.setAttribute("gen_ai.usage.cache_read_tokens", cacheReadTokens);
            }
            if (cacheWriteTokens > 0) {
              sessionCtx.llmSpan.setAttribute("gen_ai.usage.cache_write_tokens", cacheWriteTokens);
            }
            const llmDurationMs = sessionCtx.llmStartTime
              ? Date.now() - sessionCtx.llmStartTime
              : undefined;
            if (typeof llmDurationMs === "number") {
              sessionCtx.llmSpan.setAttribute("openclaw.llm.duration_ms", llmDurationMs);
            }
            sessionCtx.llmSpan.setStatus({
              code: SpanStatusCode.OK,
              message: "closed by agent_end (provider did not emit llm_output)",
            });
            sessionCtx.llmSpan.end();
          } catch { /* ignore */ }
          sessionCtx.llmSpan = undefined;
          sessionCtx.llmStartTime = undefined;
        }

        // End the agent turn span
        if (sessionCtx?.agentSpan) {
          const agentSpan = sessionCtx.agentSpan;

          if (typeof durationMs === "number") {
            agentSpan.setAttribute("openclaw.agent.duration_ms", durationMs);
          }

          // Optionally capture assistant completion from messages
          if (config.captureContent) {
            for (const msg of messages) {
              if (msg?.role === "assistant" && msg?.content) {
                const content = typeof msg.content === "string"
                  ? msg.content
                  : JSON.stringify(msg.content);
                agentSpan.setAttribute("gen_ai.completion", content.slice(0, 10000));
                break;
              }
            }
          }

          // Token usage — GenAI semantic convention attributes
          agentSpan.setAttribute("gen_ai.usage.input_tokens", totalInputTokens);
          agentSpan.setAttribute("gen_ai.usage.output_tokens", totalOutputTokens);
          agentSpan.setAttribute("gen_ai.usage.total_tokens", totalTokens);
          agentSpan.setAttribute("gen_ai.response.model", model);
          agentSpan.setAttribute("openclaw.agent.success", success);

          // Cache tokens (custom attributes)
          if (cacheReadTokens > 0) {
            agentSpan.setAttribute("gen_ai.usage.cache_read_tokens", cacheReadTokens);
          }
          if (cacheWriteTokens > 0) {
            agentSpan.setAttribute("gen_ai.usage.cache_write_tokens", cacheWriteTokens);
          }

          // Cost (from diagnostic events) — this is the key addition!
          if (typeof costUsd === "number") {
            agentSpan.setAttribute("openclaw.llm.cost_usd", costUsd);
          }

          // Context window (from diagnostic events)
          if (diagUsage?.context?.limit) {
            agentSpan.setAttribute("openclaw.context.limit", diagUsage.context.limit);
          }
          if (diagUsage?.context?.used) {
            agentSpan.setAttribute("openclaw.context.used", diagUsage.context.used);
          }

          // Record metrics only if we didn't get them from diagnostics
          // (diagnostics module already records metrics on model.usage event)
          if (!diagUsage && (totalInputTokens > 0 || totalOutputTokens > 0)) {
            const metricAttrs = {
              [GEN_AI_RESPONSE_MODEL]: model,
              [GEN_AI_OPERATION_NAME]: OP_INVOKE_AGENT,
              [GEN_AI_AGENT_ID]: agentId,
              "openclaw.agent.id": agentId,
            };
            counters.tokensPrompt.add(totalInputTokens + cacheReadTokens + cacheWriteTokens, metricAttrs);
            counters.tokensCompletion.add(totalOutputTokens, metricAttrs);
            counters.tokensTotal.add(totalTokens, metricAttrs);
            counters.llmRequests.add(1, metricAttrs);

            // Stable GenAI token usage histogram (per gen_ai.token.type)
            histograms.genAiTokenUsage.record(totalInputTokens + cacheReadTokens + cacheWriteTokens, {
              ...metricAttrs,
              [GEN_AI_TOKEN_TYPE]: TOKEN_TYPE_INPUT,
            });
            histograms.genAiTokenUsage.record(totalOutputTokens, {
              ...metricAttrs,
              [GEN_AI_TOKEN_TYPE]: TOKEN_TYPE_OUTPUT,
            });
          }

          // Record duration histograms — legacy (ms) and stable GenAI (s).
          if (typeof durationMs === "number") {
            const durationAttrs = {
              [GEN_AI_RESPONSE_MODEL]: model,
              [GEN_AI_OPERATION_NAME]: OP_INVOKE_AGENT,
              [GEN_AI_AGENT_ID]: agentId,
              "openclaw.agent.id": agentId,
            };
            histograms.agentTurnDuration.record(durationMs, durationAttrs);
            histograms.genAiOperationDuration.record(durationMs / 1000, durationAttrs);
          }

          if (errorMsg) {
            const errStr = String(errorMsg).slice(0, 500);
            agentSpan.setAttribute("openclaw.agent.error", errStr);
            agentSpan.setAttribute(ERROR_TYPE, "agent_error");
            agentSpan.recordException({ name: "AgentError", message: errStr });
            agentSpan.setStatus({ code: SpanStatusCode.ERROR, message: errStr.slice(0, 200) });
          } else {
            agentSpan.setStatus({ code: SpanStatusCode.OK });
          }

          agentSpan.end();
        }

        // End the root request span
        if (sessionCtx?.rootSpan && sessionCtx.rootSpan !== sessionCtx.agentSpan) {
          const totalMs = Date.now() - sessionCtx.startTime;
          sessionCtx.rootSpan.setAttribute("openclaw.request.duration_ms", totalMs);
          sessionCtx.rootSpan.setStatus({ code: SpanStatusCode.OK });
          sessionCtx.rootSpan.end();
        }

        // Clean up
        sessionContextMap.delete(sessionKey);
        activeAgentSpans.delete(sessionKey);

        logger.debug?.(`[otel] Trace completed for session=${sessionKey}`);
      } catch {
        // Silently ignore
      }
    },
    { priority: -100 }
  );

  logger.info("[otel] Registered agent_end hook (via api.on)");

  // ═══════════════════════════════════════════════════════════════════
  // EVENT-STREAM HOOKS — registered via api.registerHook()
  // ═══════════════════════════════════════════════════════════════════

  // ── Command event hooks ──────────────────────────────────────────

  api.registerHook(
    ["command:new", "command:reset", "command:stop"],
    async (event: any) => {
      try {
        const action = event?.action || "unknown";
        const sessionKey = event?.sessionKey || "unknown";

        // Get parent context if available
        const sessionCtx = sessionContextMap.get(sessionKey);
        const parentContext = sessionCtx?.rootContext || context.active();

        const span = tracer.startSpan(
          `openclaw.command.${action}`,
          {
            kind: SpanKind.INTERNAL,
            attributes: {
              "openclaw.command.action": action,
              "openclaw.command.session_key": sessionKey,
              "openclaw.command.source": event?.context?.commandSource || "unknown",
            },
          },
          parentContext
        );

        if (action === "new" || action === "reset") {
          counters.sessionResets.add(1, {
            "command.source": event?.context?.commandSource || "unknown",
          });
        }

        span.setStatus({ code: SpanStatusCode.OK });
        span.end();
      } catch {
        // Silently ignore telemetry errors
      }
    },
    {
      name: "otel-command-events",
      description: "Records session command spans via OpenTelemetry",
    }
  );

  logger.info("[otel] Registered command event hooks (via api.registerHook)");

  // ── Gateway startup hook ─────────────────────────────────────────

  api.registerHook(
    "gateway:startup",
    async (event: any) => {
      try {
        const span = tracer.startSpan("openclaw.gateway.startup", {
          kind: SpanKind.INTERNAL,
          attributes: {
            "openclaw.event.type": "gateway",
            "openclaw.event.action": "startup",
          },
        });
        span.setStatus({ code: SpanStatusCode.OK });
        span.end();
      } catch {
        // Silently ignore
      }
    },
    {
      name: "otel-gateway-startup",
      description: "Records gateway startup event via OpenTelemetry",
    }
  );

  logger.info("[otel] Registered gateway:startup hook (via api.registerHook)");

  // ── Periodic cleanup ─────────────────────────────────────────────
  // Safety net: clean up stale session contexts (e.g., if agent_end never fires).
  // The handle is returned to the caller so service.stop() can clear it and
  // avoid leaking timers across plugin reload / shutdown.
  const cleanupInterval = setInterval(() => {
    const now = Date.now();
    const maxAge = 5 * 60 * 1000; // 5 minutes
    for (const [key, ctx] of sessionContextMap) {
      if (now - ctx.startTime > maxAge) {
        try {
          ctx.llmSpan?.end();
          ctx.agentSpan?.end();
          if (ctx.rootSpan !== ctx.agentSpan) ctx.rootSpan?.end();
        } catch { /* ignore */ }
        sessionContextMap.delete(key);
        logger.debug?.(`[otel] Cleaned up stale trace context for session=${key}`);
      }
    }
  }, 60_000);

  return () => {
    clearInterval(cleanupInterval);
  };
}
