# Privacy: `captureContent`

The `captureContent` plugin option controls whether the Traceloop LLM-client instrumentations (`@traceloop/instrumentation-anthropic`, `@traceloop/instrumentation-openai`) record the **actual prompt and completion text** of every LLM call as span attributes.

Default: `false` (privacy-first).

## What `captureContent` controls

With `captureContent: true`, Traceloop LLM-client spans include:

| Span attribute | Contents |
|----------------|----------|
| `gen_ai.prompt.N.role` | Role for message *N* (e.g., `user`, `assistant`, `system`). |
| `gen_ai.prompt.N.content` | **Full message text** for message *N*. |
| `gen_ai.completion.N.role` | Role of the model's response. |
| `gen_ai.completion.N.content` | **Full generated text** from the model. |

With `captureContent: false`, those attributes are **omitted**. Token counts, model identifiers, latency, cost, and error state are still recorded — the behavioral metrics are unchanged.

## What `captureContent` does **not** affect

`captureContent` only gates the Traceloop LLM-client spans described above. It does **not** touch the plugin's own hook-surface spans, which already emit only metadata:

- `openclaw.request` — session/channel identifiers, no message body
- `openclaw.agent.turn` — token counts, model, duration; no prompt/completion text
- `tool.*` — tool name, duration, truncated input/result **preview** only (see `src/security.ts` for redaction rules)
- `message_sent` — metadata only

If you need to exclude tool-call previews too, that is controlled separately in the hook layer, not by `captureContent`.

## Gateway-launch setting (not hot-reloadable)

`captureContent` is read by the ESM preload (`instrumentation/preload.mjs`) at gateway launch time, **before** OpenClaw parses plugin config. The Traceloop instrumentations are constructed once, at preload, and the `traceContent` option is fixed for the lifetime of the process.

Consequence: changing `captureContent` in `openclaw.json` mid-run has no effect until the next gateway restart.

### Bridge mechanism

The preload reads the `OPENCLAW_OTEL_CAPTURE_CONTENT` environment variable. The plugin's `start()` phase re-exports this env var from the parsed plugin config so subprocesses inherit the intended value, and warns if the preload resolved to a different value than the plugin config requests.

### How to enable

Set the env var **before** the gateway process starts:

```bash
OPENCLAW_OTEL_CAPTURE_CONTENT=true \
  NODE_OPTIONS="--import /path/to/openclaw-observability-plugin/instrumentation/preload.mjs" \
  openclaw gateway start
```

Or via systemd:

```ini
[Service]
Environment=OPENCLAW_OTEL_CAPTURE_CONTENT=true
Environment=NODE_OPTIONS=--import /path/to/openclaw-observability-plugin/instrumentation/preload.mjs
ExecStart=/usr/bin/openclaw gateway start
```

Plugin config for parity (so the `otel_status` tool and the mismatch warning agree):

```json
{
  "plugins": {
    "entries": {
      "otel-observability": {
        "enabled": true,
        "config": {
          "captureContent": true
        }
      }
    }
  }
}
```

The env-var value must be the exact string `true`. Anything else — `1`, `yes`, `True`, unset — resolves to `false`. The strict match exists to keep the privacy default unambiguous.

## When to enable content capture

Enabling `captureContent` is a deliberate tradeoff. Useful when:

- You are debugging prompt engineering and need to see actual prompt/completion pairs alongside token counts.
- You operate the OTLP backend and downstream storage yourself.
- You have reviewed the backend's retention and access controls against the sensitivity of the prompts your agents handle.

Avoid enabling content capture when:

- Users can pass arbitrary data into the agent (free-form chat, uploaded documents, customer PII).
- Your backend retention is long, retention controls are weak, or access is broad.
- You have regulatory obligations around prompt/completion text (HIPAA, PCI, GDPR right-to-erasure).

## Sensitive data reaching spans

When `captureContent: true`, any of the following can land in span storage:

- User chat input, including PII, credentials, or proprietary data.
- Document contents summarized into prompts.
- Tool outputs fed back to the model (e.g., file contents from `tool.Read`).
- System prompts, which may encode prompt-engineering IP you don't want to expose.

The plugin does **not** scrub Traceloop span attributes before export. If you need redaction, apply it at the OTel Collector (`transform` / `attributes` processors) or at the backend.

## Complementary detections

Whether or not you capture content, the real-time [detection module](./detection.md) runs on the hook-surface path and flags:

- Sensitive file access (`tool.Read` on `.env`, SSH keys, cloud creds)
- Dangerous command execution
- Prompt-injection patterns on inbound messages

These alerts work without content capture — they operate on paths, command strings, and matched patterns, and emit only the patterns and a short preview on the span.

## See also

- [Real-Time Detection](./detection.md) — application-layer security events
- [Configuration](../configuration.md#capturecontent-gateway-launch-setting) — plugin config reference
- [github issue #15](https://github.com/henrikrexed/openclaw-observability-plugin/issues/15) — original report motivating this wiring
