# OpenClaw Observability

[![Documentation](https://img.shields.io/badge/docs-GitHub%20Pages-blue)](https://henrikrexed.github.io/openclaw-observability-plugin/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

OpenTelemetry observability for [OpenClaw](https://github.com/openclaw/openclaw) AI agents.

📖 **[Full Documentation](https://henrikrexed.github.io/openclaw-observability-plugin/)** — Setup guides, configuration reference, and backend examples.

## Two Approaches to Observability

This repository documents **two complementary approaches** to monitoring OpenClaw:

| Approach | Best For | Setup Complexity |
|----------|----------|------------------|
| **Official Plugin** | Operational metrics, Gateway health, cost tracking | Simple config |
| **Custom Plugin** | Deep tracing, tool call visibility, request lifecycle | Plugin installation |

**Recommendation:** Use both for complete observability.

---

## Approach 1: Official Diagnostics Plugin (Built-in)

OpenClaw v2026.2+ includes **built-in OpenTelemetry support**. Just add to `openclaw.json`:

```json
{
  "diagnostics": {
    "enabled": true,
    "otel": {
      "enabled": true,
      "endpoint": "http://localhost:4318",
      "serviceName": "openclaw-gateway",
      "traces": true,
      "metrics": true,
      "logs": true
    }
  }
}
```

Then restart:

```bash
openclaw gateway restart
```

### What It Captures

**Metrics:**
- `openclaw.tokens` — Token usage by type (input/output/cache)
- `openclaw.cost.usd` — Estimated model cost
- `openclaw.run.duration_ms` — Agent run duration
- `openclaw.context.tokens` — Context window usage
- `openclaw.webhook.*` — Webhook processing stats
- `openclaw.message.*` — Message processing stats
- `openclaw.queue.*` — Queue depth and wait times
- `openclaw.session.*` — Session state transitions

**Traces:** Model usage, webhook processing, message processing, stuck sessions

**Logs:** All Gateway logs via OTLP with severity, subsystem, and code location

---

## Approach 2: Custom Hook-Based Plugin (This Repo)

For **deeper observability**, install the custom plugin from this repo. It uses OpenClaw's typed plugin hooks to capture the full agent lifecycle.

### What It Adds

**Connected Traces:**
```
openclaw.request (root span)
├── openclaw.agent.turn
│   ├── tool.Read (file read)
│   ├── tool.exec (shell command)
│   ├── tool.Write (file write)
│   └── tool.web_search
└── (child spans connected via trace context)
```

Plus standalone spans on session commands (`openclaw.command.new|reset|stop`) and gateway startup (`openclaw.gateway.startup`).

**Per-Tool Visibility:**
- Individual spans for each tool call
- Tool execution time
- Result size (characters)
- Error tracking per tool

**Request Lifecycle:**
- Full message → response tracing
- Session context propagation
- Agent turn duration with token breakdown

### Plugin Lifecycle

OpenClaw has two hook registration moments, and the plugin uses both at the right phase:

| Phase | Runs | What the plugin does |
|---|---|---|
| `register()` | Synchronous, before the gateway accepts traffic | Registers **all 15 typed hooks** via `api.on()`, event-stream hooks (`command:*`, `gateway:startup`), the `otel-observability.status` RPC, the `otel` CLI command, the background service, and the optional `otel_status` agent tool. Hooks receive a **lazy telemetry getter** (`() => telemetry`) so they can be wired before the OTel runtime exists. |
| `start()` | Async, after the gateway is ready | Calls `initTelemetry()` to build the `TracerProvider`/`MeterProvider` and register them globally, conditionally initializes OpenLLMetry wraps when `traces` is on, and subscribes to OpenClaw diagnostic events for cost/token data. |
| `stop()` | Async, on gateway reload/shutdown | Clears the 60 s stale-session sweeper `setInterval` ([ISI-522](https://github.com/henrikrexed/openclaw-observability-plugin/commit/b668a4f)), unsubscribes from diagnostics, and calls `telemetry.shutdown()` to flush exporters. |

**Why this matters:** OpenClaw snapshots typed hooks at registration time. If hooks are registered from `start()` instead of `register()`, the gateway never sees them and **hooks register but never fire**. PR #6 (see [ISI-515](https://github.com/henrikrexed/openclaw-observability-plugin/pull/6)) moved them back to `register()` and introduced the lazy getter so handlers no-op cleanly during the brief `register()` → `start()` window.

### Installation

1. Clone this repository:
   ```bash
   git clone https://github.com/henrikrexed/openclaw-observability-plugin.git
   ```

2. Add to your `openclaw.json`:
   ```json
   {
     "plugins": {
       "load": {
         "paths": ["/path/to/openclaw-observability-plugin"]
       },
       "entries": {
         "otel-observability": {
           "enabled": true
         }
       }
     }
   }
   ```

3. Clear cache and restart:
   ```bash
   rm -rf /tmp/jiti
   systemctl --user restart openclaw-gateway
   ```

### Validate your first trace

Send a message that triggers at least one tool call and check Gateway logs for the lifecycle markers:

```bash
journalctl --user -u openclaw-gateway -f | grep -E '\[otel\]'
```

You should see, in this order:

```
[otel] Registered message_received hook (via api.on)
[otel] Registered before_agent_start hook (via api.on)
[otel] Registered tool_result_persist hook (via api.on)
[otel] Registered agent_end hook (via api.on)
[otel] Registered command event hooks (via api.registerHook)
[otel] Registered gateway:startup hook (via api.registerHook)
[otel] Starting OpenTelemetry observability...
[otel] ✅ Observability pipeline active
[otel]   Traces=true Metrics=true Logs=true
[otel]   Endpoint=http://localhost:4318 (http)
```

Then, on the next inbound message, the debug log confirms hooks are live:

```
[otel] Root span started for session=<sessionKey>
[otel] Agent turn span started: agent=<agentId>, session=<sessionKey>
```

In your backend, look for an `openclaw.request` span with at least one `openclaw.agent.turn` child. A healthy trace has `openclaw.request` → `openclaw.agent.turn` → one or more `tool.*` children.

---

## Comparing the Two Approaches

| Feature | Official Plugin | Custom Plugin |
|---------|-----------------|---------------|
| Token metrics | ✅ Per model | ✅ Per session + model |
| Cost tracking | ✅ Yes | ✅ Yes (from diagnostics) |
| Gateway health | ✅ Webhooks, queues, sessions | ❌ Not focused |
| Session state | ✅ State transitions | ❌ Not tracked |
| **Tool call tracing** | ❌ No | ✅ Individual tool spans |
| **Request lifecycle** | ❌ No | ✅ Full request → response |
| **Connected traces** | ❌ Separate spans | ✅ Parent-child hierarchy |
| Setup complexity | 🟢 Config only | 🟡 Plugin installation |

---

## Backend Examples

### Dynatrace (Direct)

```json
{
  "diagnostics": {
    "enabled": true,
    "otel": {
      "enabled": true,
      "endpoint": "https://{env-id}.live.dynatrace.com/api/v2/otlp",
      "headers": {
        "Authorization": "Api-Token {your-token}"
      },
      "serviceName": "openclaw-gateway",
      "traces": true,
      "metrics": true,
      "logs": true
    }
  }
}
```

### Grafana Cloud

```json
{
  "diagnostics": {
    "enabled": true,
    "otel": {
      "enabled": true,
      "endpoint": "https://otlp-gateway-{region}.grafana.net/otlp",
      "headers": {
        "Authorization": "Basic {base64-credentials}"
      },
      "serviceName": "openclaw-gateway",
      "traces": true,
      "metrics": true
    }
  }
}
```

### Local OTel Collector

```json
{
  "diagnostics": {
    "enabled": true,
    "otel": {
      "enabled": true,
      "endpoint": "http://localhost:4318",
      "serviceName": "openclaw-gateway",
      "traces": true,
      "metrics": true,
      "logs": true
    }
  }
}
```

---

## Configuration Reference

### Official Plugin Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `diagnostics.enabled` | boolean | false | Enable diagnostics system |
| `diagnostics.otel.enabled` | boolean | false | Enable OTel export |
| `diagnostics.otel.endpoint` | string | — | OTLP endpoint URL |
| `diagnostics.otel.protocol` | string | "http/protobuf" | Protocol |
| `diagnostics.otel.headers` | object | — | Custom headers |
| `diagnostics.otel.serviceName` | string | "openclaw" | Service name |
| `diagnostics.otel.traces` | boolean | true | Enable traces |
| `diagnostics.otel.metrics` | boolean | true | Enable metrics |
| `diagnostics.otel.logs` | boolean | false | Enable logs |
| `diagnostics.otel.sampleRate` | number | 1.0 | Trace sampling (0-1) |

### Custom Plugin Options

> **Important:** Do NOT add a `config` block inside the plugin entry — OpenClaw's plugin framework rejects unknown properties. The plugin reads its configuration from the `diagnostics.otel` section instead.

The following settings are controlled via the `diagnostics.otel` config block:

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `endpoint` | string | `http://localhost:4318` | OTLP endpoint URL |
| `serviceName` | string | `openclaw-gateway` | Service name |
| `protocol` | string | `http/protobuf` | OTLP protocol |
| `traces` | boolean | true | Enable traces |
| `metrics` | boolean | true | Enable metrics |
| `logs` | boolean | true | Enable logs |

---

## Documentation

- [Getting Started](./docs/getting-started.md) — Setup guide
- [Configuration](./docs/configuration.md) — All options
- [Architecture](./docs/architecture.md) — How it works
- [Limitations](./docs/limitations.md) — Known constraints
- [Backends](./docs/backends/) — Backend-specific guides

---

## Optional: Kernel-Level Security with Tetragon

For **defense in depth**, add [Tetragon](https://tetragon.io) eBPF-based monitoring. While the plugins above capture application-level telemetry, Tetragon sees what happens at the kernel level — file access, process execution, network connections, and privilege changes.

### Why Tetragon?

- **Tamper-proof**: Even a compromised agent can't hide its kernel-level actions
- **Sensitive file detection**: Alert when `.env`, SSH keys, or credentials are accessed
- **Dangerous command detection**: Catch `rm`, `curl | sh`, `chmod 777`, etc.
- **Privilege escalation**: Detect `setuid`/`setgid` attempts

### Quick Setup

```bash
# Install Tetragon
curl -LO https://github.com/cilium/tetragon/releases/latest/download/tetragon-v1.6.0-amd64.tar.gz
tar -xzf tetragon-v1.6.0-amd64.tar.gz && cd tetragon-v1.6.0-amd64
sudo ./install.sh

# Create OpenClaw policies directory
sudo mkdir -p /etc/tetragon/tetragon.tp.d/openclaw

# Add policies (see docs/security/tetragon.md for full examples)
# Start Tetragon
sudo systemctl enable --now tetragon
```

Tetragon events are exported to `/var/log/tetragon/tetragon.log` and can be ingested by the OTel Collector using the `filelog` receiver.

### Complete Observability Stack

| Layer | Source | What It Shows |
|-------|--------|---------------|
| **Application** | Custom Plugin | Tool calls, tokens, request flow |
| **Gateway** | Official Plugin | Session health, queues, costs |
| **Kernel** | Tetragon | System calls, file access, network |

See [Security: Tetragon](./docs/security/tetragon.md) for full installation and configuration guide.

---

## Troubleshooting

### Hooks register but never fire

**Symptom.** The plugin logs `[otel] ✅ Observability pipeline active` at gateway startup, but no `openclaw.request` or `tool.*` spans ever reach your backend — even after you send messages that clearly invoke tools.

**Cause (pre-PR #6).** Earlier builds registered typed hooks from inside the async `service.start()` phase. OpenClaw snapshots typed hooks at plugin registration time, ~30 s before `start()` runs, so the gateway never saw the 15 hook listeners. See [ISI-515](https://github.com/henrikrexed/openclaw-observability-plugin/pull/6).

**Fix.** Upgrade to a build that includes PR #6. Hooks are now registered synchronously in `register()` and resolve the telemetry runtime lazily.

**How to confirm hooks are live:**

1. Check the gateway log for all six registration lines emitted from `register()`:
   ```
   [otel] Registered message_received hook (via api.on)
   [otel] Registered before_agent_start hook (via api.on)
   [otel] Registered tool_result_persist hook (via api.on)
   [otel] Registered agent_end hook (via api.on)
   [otel] Registered command event hooks (via api.registerHook)
   [otel] Registered gateway:startup hook (via api.registerHook)
   ```
   If these are **missing**, the plugin is not loaded — check `plugins.load.paths` in `openclaw.json` and clear `/tmp/jiti`.

2. Send a real message through the pipeline and watch for the per-event debug lines (enable debug logging first):
   ```
   [otel] Root span started for session=<sessionKey>
   [otel] Agent turn span started: agent=<agentId>, session=<sessionKey>
   ```
   If registration lines are present but these do **not** appear on messages, the hooks are registered but the gateway is not firing them for your event path (e.g., heartbeats and some internal events do not carry full session context).

3. Verify your OTLP endpoint is actually receiving data:
   ```bash
   curl -v http://localhost:4318/v1/traces
   ```

### Plugin not loaded at all

Check plugin discovery:

```bash
openclaw plugins list
```

Clear the jiti cache and restart:

```bash
rm -rf /tmp/jiti
systemctl --user restart openclaw-gateway
```

### Traces exported but not connected

The custom plugin requires messages to flow through the normal pipeline (`message_received` → `before_agent_start` → tools → `agent_end`). Heartbeats and some internal events skip `message_received`, so those turns produce a standalone `openclaw.agent.turn` span without a parent `openclaw.request`. This is expected.

---

## Known Limitations

**Auto-instrumentation not possible:** OpenLLMetry/IITM breaks `@mariozechner/pi-ai` named exports due to ESM/CJS module isolation. All telemetry is captured via hooks, not direct SDK instrumentation.

**No per-LLM-call spans:** Individual API calls to Claude/OpenAI cannot be traced. Token usage is aggregated per agent turn.

See [Limitations](./docs/limitations.md) for details.

---

## License

MIT
