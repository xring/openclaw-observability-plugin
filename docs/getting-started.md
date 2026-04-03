# Getting Started

Get OpenTelemetry observability for your OpenClaw AI agents.

## Prerequisites

- OpenClaw v2026.2.0 or later
- An OTLP endpoint (local collector, Dynatrace, Grafana, etc.)

## Option 1: Official Diagnostics Plugin (Recommended Start)

The fastest way to get observability. No installation needed — just configure.

### Step 1: Add Configuration

Add to your `~/.openclaw/openclaw.json`:

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

### Step 2: Restart Gateway

```bash
openclaw gateway restart
```

### Step 3: Verify

Send a message to your agent and check your backend for:

- **Metrics:** `openclaw.tokens`, `openclaw.cost.usd`, `openclaw.run.duration_ms`
- **Traces:** `openclaw.model.usage`, `openclaw.message.processed`
- **Logs:** Gateway logs with severity and code location

---

## Option 2: Custom Hook-Based Plugin (Deeper Tracing)

For connected traces and per-tool-call visibility, add the custom plugin.

### Step 1: Clone the Repository

```bash
cd ~/.openclaw/extensions
git clone https://github.com/henrikrexed/openclaw-observability-plugin.git otel-observability
```

### Step 2: Install Dependencies

```bash
cd otel-observability
npm install
```

### Step 3: Configure OpenClaw

Add to your `~/.openclaw/openclaw.json`:

```json
{
  "plugins": {
    "load": {
      "paths": ["~/.openclaw/extensions/otel-observability"]
    },
    "entries": {
      "otel-observability": {
        "enabled": true
      }
    }
  }
}
```

> **Note:** Do NOT add a `config` block inside `otel-observability` — OpenClaw's plugin framework rejects unknown properties. The plugin reads its settings from the `diagnostics.otel` section instead. If you need custom settings, configure them in `diagnostics.otel` (see Option 1 above).

### Step 4: Clear Cache and Restart

```bash
rm -rf /tmp/jiti
systemctl --user restart openclaw-gateway
# Or: openclaw gateway restart
```

### Step 5: Verify Connected Traces

Send a message that triggers tool calls (e.g., "read my AGENTS.md file"). You should see:

```
openclaw.request
└── openclaw.agent.turn
    └── tool.Read
```

---

## Using Both Plugins Together

For complete observability, enable both:

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
  },
  "plugins": {
    "load": {
      "paths": ["~/.openclaw/extensions/otel-observability"]
    },
    "entries": {
      "otel-observability": {
        "enabled": true,
        "config": {
          "endpoint": "http://localhost:4318",
          "serviceName": "openclaw-gateway"
        }
      }
    }
  }
}
```

**What you get:**

| Source | Data |
|--------|------|
| Official | Gateway health, queue metrics, log forwarding, session states |
| Custom | Connected request traces, tool call spans, agent turn details |

---

## Backend Quick Setup

### Local OTel Collector

1. Install:
   ```bash
   # Ubuntu/Debian
   wget https://github.com/open-telemetry/opentelemetry-collector-releases/releases/download/v0.144.0/otelcol-contrib_0.144.0_linux_amd64.deb
   sudo dpkg -i otelcol-contrib_0.144.0_linux_amd64.deb
   ```

2. Configure (`/etc/otelcol-contrib/config.yaml`):
   ```yaml
   receivers:
     otlp:
       protocols:
         http:
           endpoint: 0.0.0.0:4318

   processors:
     batch:

   exporters:
     debug:
       verbosity: detailed
     # Add your backend exporter

   service:
     pipelines:
       traces:
         receivers: [otlp]
         processors: [batch]
         exporters: [debug]
       metrics:
         receivers: [otlp]
         processors: [batch]
         exporters: [debug]
       logs:
         receivers: [otlp]
         processors: [batch]
         exporters: [debug]
   ```

3. Start:
   ```bash
   sudo systemctl start otelcol-contrib
   ```

### Dynatrace (Direct)

No collector needed:

```json
{
  "diagnostics": {
    "enabled": true,
    "otel": {
      "enabled": true,
      "endpoint": "https://{environment-id}.live.dynatrace.com/api/v2/otlp",
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

**Required scopes:** `metrics.ingest`, `logs.ingest`, `openTelemetryTrace.ingest`

### Grafana Cloud

```json
{
  "diagnostics": {
    "enabled": true,
    "otel": {
      "enabled": true,
      "endpoint": "https://otlp-gateway-{region}.grafana.net/otlp",
      "headers": {
        "Authorization": "Basic {base64(instanceId:apiKey)}"
      },
      "serviceName": "openclaw-gateway",
      "traces": true,
      "metrics": true
    }
  }
}
```

---

## Troubleshooting

### No data appearing?

1. Check Gateway logs:
   ```bash
   journalctl --user -u openclaw-gateway -f
   ```

2. Verify endpoint is reachable:
   ```bash
   curl -v http://localhost:4318/v1/traces
   ```

3. Check diagnostics config:
   ```bash
   cat ~/.openclaw/openclaw.json | jq '.diagnostics'
   ```

### Custom plugin not loading?

1. Check plugin discovery:
   ```bash
   openclaw plugins list
   ```

2. Clear jiti cache:
   ```bash
   rm -rf /tmp/jiti
   ```

3. Check for TypeScript errors in Gateway logs

### Traces not connected?

The custom plugin requires messages to flow through the normal pipeline. Heartbeats and some internal events may not have full trace context.

---

## Next Steps

- [Configuration Reference](./configuration.md) — All options
- [Architecture](./architecture.md) — How it works
- [Limitations](./limitations.md) — Known constraints
- [Backend Guides](./backends/) — Specific backend setup
