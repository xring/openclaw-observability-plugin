# Kernel-Level Security with Tetragon

Tetragon provides **eBPF-based security observability** at the Linux kernel level. While the OpenClaw plugin captures application-level telemetry, Tetragon sees what actually happens at the system call level — file access, process execution, network connections, and privilege changes.

This is **defense in depth**: the application layer shows what the agent *intended* to do; the kernel layer shows what it *actually* did.

## Why Tetragon for OpenClaw?

AI agents can execute commands, read files, and make network connections. Even with application-level monitoring, a compromised or manipulated agent could:

- Access sensitive files (`.env`, SSH keys, credentials)
- Execute dangerous commands (`rm -rf`, `curl | sh`)
- Attempt privilege escalation
- Make unexpected network connections

Tetragon catches all of this at the kernel level — **tamper-proof** and impossible to bypass.

## Installation

### Prerequisites

- Linux kernel 5.4+ (BTF support required)
- Root access for installation
- systemd (for service management)

### Install Tetragon

```bash
# Download latest release
curl -LO https://github.com/cilium/tetragon/releases/latest/download/tetragon-v1.6.0-amd64.tar.gz

# Extract
tar -xzf tetragon-v1.6.0-amd64.tar.gz
cd tetragon-v1.6.0-amd64

# Install
sudo ./install.sh

# Verify installation
tetra version
```

### Create OpenClaw Policy Directory

```bash
sudo mkdir -p /etc/tetragon/tetragon.tp.d/openclaw
```

## TracingPolicies for OpenClaw

Create the following policy files in `/etc/tetragon/tetragon.tp.d/openclaw/`:

### 1. Process Execution Monitoring

Captures every command executed by Node.js (OpenClaw).

```yaml
# /etc/tetragon/tetragon.tp.d/openclaw/01-process-exec.yaml
apiVersion: cilium.io/v1alpha1
kind: TracingPolicy
metadata:
  name: openclaw-process-exec
spec:
  kprobes:
    - call: "sys_execve"
      syscall: true
      args:
        - index: 0
          type: "string"
        - index: 1
          type: "string"
      selectors:
        - matchBinaries:
            - operator: "In"
              values:
                - "/usr/bin/node"
                - "/usr/local/bin/node"
          matchActions:
            - action: Post
```

### 2. Sensitive File Access Detection

Alerts when OpenClaw accesses sensitive files.

```yaml
# /etc/tetragon/tetragon.tp.d/openclaw/02-sensitive-files.yaml
apiVersion: cilium.io/v1alpha1
kind: TracingPolicy
metadata:
  name: openclaw-sensitive-files
spec:
  kprobes:
    - call: "security_file_open"
      syscall: false
      args:
        - index: 0
          type: "file"
      selectors:
        - matchBinaries:
            - operator: "In"
              values:
                - "/usr/bin/node"
                - "/usr/local/bin/node"
          matchArgs:
            - index: 0
              operator: "Prefix"
              values:
                - "/etc/shadow"
                - "/etc/passwd"
                - "/etc/sudoers"
                - "/root/"
                - ".ssh/"
                - ".aws/"
                - ".kube/"
                - ".config/gcloud/"
                - ".openclaw/"
                - ".env"
          matchActions:
            - action: Post
```

### 3. Privilege Escalation Detection

Catches attempts to change user/group ID.

```yaml
# /etc/tetragon/tetragon.tp.d/openclaw/04-privilege-escalation.yaml
apiVersion: cilium.io/v1alpha1
kind: TracingPolicy
metadata:
  name: openclaw-privilege-escalation
spec:
  kprobes:
    - call: "sys_setuid"
      syscall: true
      args:
        - index: 0
          type: "int"
      selectors:
        - matchBinaries:
            - operator: "In"
              values:
                - "/usr/bin/node"
                - "/usr/local/bin/node"
          matchActions:
            - action: Post
    - call: "sys_setgid"
      syscall: true
      args:
        - index: 0
          type: "int"
      selectors:
        - matchBinaries:
            - operator: "In"
              values:
                - "/usr/bin/node"
                - "/usr/local/bin/node"
          matchActions:
            - action: Post
```

### 4. Dangerous Command Detection

Flags potentially dangerous binaries.

```yaml
# /etc/tetragon/tetragon.tp.d/openclaw/05-dangerous-commands.yaml
apiVersion: cilium.io/v1alpha1
kind: TracingPolicy
metadata:
  name: openclaw-dangerous-commands
spec:
  kprobes:
    - call: "sys_execve"
      syscall: true
      args:
        - index: 0
          type: "string"
        - index: 1
          type: "string"
      selectors:
        - matchArgs:
            - index: 0
              operator: "Postfix"
              values:
                - "/rm"
                - "/dd"
                - "/nc"
                - "/netcat"
                - "/ncat"
                - "/curl"
                - "/wget"
                - "/chmod"
                - "/chown"
          matchActions:
            - action: Post
```

### 5. Kernel Module Loading

Detects attempts to load kernel modules (critical security event).

```yaml
# /etc/tetragon/tetragon.tp.d/openclaw/06-kernel-modules.yaml
apiVersion: cilium.io/v1alpha1
kind: TracingPolicy
metadata:
  name: openclaw-kernel-modules
spec:
  kprobes:
    - call: "__x64_sys_init_module"
      syscall: true
      args:
        - index: 2
          type: "string"
      selectors:
        - matchActions:
            - action: Post
    - call: "__x64_sys_finit_module"
      syscall: true
      args:
        - index: 2
          type: "string"
      selectors:
        - matchActions:
            - action: Post
```

## Configure Tetragon Export

Configure Tetragon to export events to a log file that the OTel Collector can read:

```bash
# Set export file
echo "/var/log/tetragon/tetragon.log" | sudo tee /etc/tetragon/tetragon.conf.d/export-filename

# Set file permissions (readable by collector)
echo "644" | sudo tee /etc/tetragon/tetragon.conf.d/export-file-perm

# Rotate at 50MB
echo "50" | sudo tee /etc/tetragon/tetragon.conf.d/export-file-max-size-mb

# Keep 3 backup files
echo "3" | sudo tee /etc/tetragon/tetragon.conf.d/export-file-max-backups
```

## Start Tetragon

```bash
# Enable and start
sudo systemctl enable tetragon
sudo systemctl start tetragon

# Verify policies loaded
sudo systemctl status tetragon

# Watch events in real-time
sudo tetra getevents -o compact
```

## OTel Collector Integration

Add the Tetragon filelog receiver to your collector configuration:

```yaml
receivers:
  # ... existing receivers ...
  
  filelog/tetragon:
    include:
      - /var/log/tetragon/tetragon.log
    start_at: end
    operators:
      - type: json_parser
        parse_from: body
        timestamp:
          parse_from: attributes.time
          layout: '%Y-%m-%dT%H:%M:%S.%LZ'

processors:
  # ... existing processors ...
  
  # Transform Tetragon events
  transform/tetragon:
    error_mode: ignore
    log_statements:
      - context: log
        statements:
          # Identify event type
          - set(attributes["tetragon.type"], "kprobe") where attributes["process_kprobe"] != nil
          - set(attributes["tetragon.type"], "exec") where attributes["process_exec"] != nil
          - set(attributes["tetragon.type"], "exit") where attributes["process_exit"] != nil
          
          # Extract policy name
          - set(attributes["tetragon.policy"], attributes["process_kprobe"]["policy_name"]) where attributes["process_kprobe"]["policy_name"] != nil
          
          # Extract process info
          - set(attributes["process.binary"], attributes["process_kprobe"]["process"]["binary"]) where attributes["process_kprobe"]["process"]["binary"] != nil
          - set(attributes["process.pid"], attributes["process_kprobe"]["process"]["pid"]) where attributes["process_kprobe"]["process"]["pid"] != nil
          
          # Extract function name
          - set(attributes["tetragon.function"], attributes["process_kprobe"]["function_name"]) where attributes["process_kprobe"]["function_name"] != nil
          
          # Assign security risk levels
          - set(attributes["security.risk"], "critical") where attributes["tetragon.policy"] == "openclaw-privilege-escalation"
          - set(attributes["security.risk"], "critical") where attributes["tetragon.policy"] == "openclaw-kernel-modules"
          - set(attributes["security.risk"], "high") where attributes["tetragon.policy"] == "openclaw-sensitive-files"
          - set(attributes["security.risk"], "high") where attributes["tetragon.policy"] == "openclaw-dangerous-commands"
          - set(attributes["security.risk"], "low") where attributes["tetragon.policy"] == "openclaw-process-exec"

  # Add service metadata
  resource/tetragon:
    attributes:
      - key: service.name
        value: "openclaw-security"
        action: upsert
      - key: tetragon.version
        value: "1.6.0"
        action: upsert

service:
  pipelines:
    # ... existing pipelines ...
    
    logs/tetragon:
      receivers: [filelog/tetragon]
      processors: [transform/tetragon, resource/tetragon, batch]
      exporters: [otlphttp/dynatrace]  # or your exporter
```

### Collector Permissions

The OTel Collector needs read access to the Tetragon log file:

```bash
# Make log readable
sudo chmod 644 /var/log/tetragon/tetragon.log

# Or add collector user to appropriate group
sudo usermod -a -G adm otelcol-contrib
```

### 8. Network Exfiltration Detection (2025-2026)

Detects DNS/HTTP data exfiltration and C2 callbacks from agent processes.

**Threat references:**
- Claude Code DNS exfiltration (CVE-2025-55284)
- Agent Commander promptware C2 (embracethered, March 2026)
- Data exfiltration via image rendering (Amp Code, August 2025)

```yaml
# /etc/tetragon/tetragon.tp.d/openclaw/08-network-exfiltration.yaml
apiVersion: cilium.io/v1alpha1
kind: TracingPolicy
metadata:
  name: openclaw-network-exfiltration
spec:
  kprobes:
    - call: "tcp_connect"
      syscall: false
      args:
        - index: 0
          type: "sockaddr"
      selectors:
        - matchBinaries:
            - operator: "In"
              values:
                - "/usr/bin/node"
                - "/usr/local/bin/node"
          matchActions:
            - action: Post
    - call: "dns_query"
      syscall: false
      args:
        - index: 1
          type: "string"
      selectors:
        - matchBinaries:
            - operator: "In"
              values:
                - "/usr/bin/node"
                - "/usr/local/bin/node"
          matchActions:
            - action: Post
```

### 9. Supply Chain Attack Detection

Monitors package manager invocations from agent processes.

**Threat references:**
- LiteLLM 1.82.8 credential stealer in `.pth` file (March 2026)
- Trivy CI compromise leading to PyPI package poisoning
- Typosquatting attacks in agent-installed packages

```yaml
# /etc/tetragon/tetragon.tp.d/openclaw/09-supply-chain.yaml
apiVersion: cilium.io/v1alpha1
kind: TracingPolicy
metadata:
  name: openclaw-supply-chain
spec:
  kprobes:
    - call: "sys_execve"
      syscall: true
      args:
        - index: 0
          type: "string"
        - index: 1
          type: "string"
      selectors:
        - matchBinaries:
            - operator: "In"
              values:
                - "/usr/bin/node"
                - "/usr/local/bin/node"
          matchArgs:
            - index: 0
              operator: "In"
              values:
                - "/usr/bin/npm"
                - "/usr/bin/pip"
                - "/usr/bin/pip3"
                - "/usr/bin/npx"
                - "/usr/bin/yarn"
                - "/usr/bin/pnpm"
          matchActions:
            - action: Post
```

### 10. Persistence & Configuration Tampering

Detects writes to OpenClaw memory, identity, and configuration files.

**Threat references:**
- Agent Commander persistence via HEARTBEAT.md backdoor (embracethered, March 2026)
- Cross-agent skill overwrite attacks (embracethered, September 2025)
- SOUL.md / IDENTITY.md manipulation for persistent control

```yaml
# /etc/tetragon/tetragon.tp.d/openclaw/10-persistence-tampering.yaml
apiVersion: cilium.io/v1alpha1
kind: TracingPolicy
metadata:
  name: openclaw-persistence-tampering
spec:
  kprobes:
    - call: "security_file_open"
      syscall: false
      args:
        - index: 0
          type: "file"
      selectors:
        - matchBinaries:
            - operator: "In"
              values:
                - "/usr/bin/node"
                - "/usr/local/bin/node"
          matchArgs:
            - index: 0
              operator: "In"
              values:
                - "HEARTBEAT.md"
                - "SOUL.md"
                - "MEMORY.md"
                - "IDENTITY.md"
                - "AGENTS.md"
                - "openclaw.json"
                - "SKILL.md"
          matchActions:
            - action: Post
    - call: "sys_execve"
      syscall: true
      args:
        - index: 0
          type: "string"
      selectors:
        - matchBinaries:
            - operator: "In"
              values:
                - "/usr/bin/node"
                - "/usr/local/bin/node"
          matchArgs:
            - index: 0
              operator: "In"
              values:
                - "/usr/bin/crontab"
                - "/usr/bin/at"
                - "/usr/bin/systemctl"
          matchActions:
            - action: Post
```

### 11. Obfuscation & Encoding Detection

Detects tools commonly used to encode/decode malicious payloads.

**Threat references:**
- Hidden Unicode tag codepoints in Skills (embracethered, February 2026)
- Base64-encoded prompt injection payloads
- Steganographic instructions in images and files

```yaml
# /etc/tetragon/tetragon.tp.d/openclaw/11-obfuscation-encoding.yaml
apiVersion: cilium.io/v1alpha1
kind: TracingPolicy
metadata:
  name: openclaw-obfuscation-encoding
spec:
  kprobes:
    - call: "sys_execve"
      syscall: true
      args:
        - index: 0
          type: "string"
      selectors:
        - matchBinaries:
            - operator: "In"
              values:
                - "/usr/bin/node"
                - "/usr/local/bin/node"
          matchArgs:
            - index: 0
              operator: "In"
              values:
                - "/usr/bin/base64"
                - "/usr/bin/xxd"
                - "/usr/bin/python3"
                - "/usr/bin/perl"
                - "/usr/bin/openssl"
          matchActions:
            - action: Post
```

### 12. Git Operations Monitoring

Monitors git commands and access to credential files.

**Threat references:**
- Git credential theft via `.git-credentials` access
- Force pushing to main branch (Claude Code auto-mode attack)
- Secret leakage through git push

```yaml
# /etc/tetragon/tetragon.tp.d/openclaw/12-git-operations.yaml
apiVersion: cilium.io/v1alpha1
kind: TracingPolicy
metadata:
  name: openclaw-git-operations
spec:
  kprobes:
    - call: "sys_execve"
      syscall: true
      args:
        - index: 0
          type: "string"
      selectors:
        - matchBinaries:
            - operator: "In"
              values:
                - "/usr/bin/node"
                - "/usr/local/bin/node"
          matchArgs:
            - index: 0
              operator: "In"
              values:
                - "/usr/bin/git"
          matchActions:
            - action: Post
    - call: "security_file_open"
      syscall: false
      args:
        - index: 0
          type: "file"
      selectors:
        - matchBinaries:
            - operator: "In"
              values:
                - "/usr/bin/node"
                - "/usr/local/bin/node"
          matchArgs:
            - index: 0
              operator: "In"
              values:
                - ".git-credentials"
                - ".gitconfig"
                - ".netrc"
          matchActions:
            - action: Post
```

## Event Examples

### Process Execution Event

```json
{
  "process_kprobe": {
    "process": {
      "binary": "/usr/bin/node",
      "pid": 58856,
      "uid": 1000,
      "cwd": "/home/user"
    },
    "parent": {
      "binary": "/usr/bin/node",
      "pid": 56271
    },
    "function_name": "__x64_sys_execve",
    "args": [
      {"string_arg": "/bin/sh"},
      {"string_arg": "-c ls -la"}
    ],
    "policy_name": "openclaw-process-exec"
  },
  "time": "2026-02-04T15:13:03.638Z"
}
```

### Sensitive File Access Event

```json
{
  "process_kprobe": {
    "process": {
      "binary": "/usr/bin/node",
      "pid": 58900
    },
    "function_name": "security_file_open",
    "args": [
      {"file_arg": {"path": "/home/user/.ssh/id_rsa"}}
    ],
    "policy_name": "openclaw-sensitive-files"
  },
  "time": "2026-02-04T15:14:22.123Z"
}
```

## Alerting on Security Events

In your observability backend (Dynatrace, Grafana, etc.), create alerts for:

| Alert | Condition | Severity |
|-------|-----------|----------|
| Privilege Escalation | `tetragon.policy == "openclaw-privilege-escalation"` | Critical |
| Kernel Module Load | `tetragon.policy == "openclaw-kernel-modules"` | Critical |
| Persistence Tampering | `tetragon.policy == "openclaw-persistence-tampering"` | Critical |
| Supply Chain Install | `tetragon.policy == "openclaw-supply-chain"` | Critical |
| Sensitive File Access | `tetragon.policy == "openclaw-sensitive-files"` | High |
| Dangerous Command | `tetragon.policy == "openclaw-dangerous-commands"` | High |
| Network Exfiltration | `tetragon.policy == "openclaw-network-exfiltration"` | High |
| Git Credential Access | `tetragon.policy == "openclaw-git-operations"` | High |
| Obfuscation/Encoding | `tetragon.policy == "openclaw-obfuscation-encoding"` | Medium |
| Unusual Process Exec | `tetragon.policy == "openclaw-process-exec"` AND off-hours | Medium |

## Complete Observability Stack

With Tetragon integrated, you have three layers of visibility:

| Layer | Source | What It Shows |
|-------|--------|---------------|
| **Application** | OpenClaw Plugin | Tool calls, tokens, request flow |
| **Gateway** | diagnostics-otel | Session health, queues, costs |
| **Kernel** | Tetragon | System calls, file access, network |

This provides defense in depth — even if application-level telemetry is manipulated, kernel-level events reveal the truth.

## Troubleshooting

### Tetragon not starting

```bash
# Check logs
sudo journalctl -u tetragon -n 50

# Common issues:
# - Kernel too old (need 5.4+)
# - BTF not available
# - Policy YAML syntax error
```

### Events not appearing in collector

```bash
# Check Tetragon is writing events
sudo tail -f /var/log/tetragon/tetragon.log

# Check file permissions
ls -la /var/log/tetragon/tetragon.log

# Check collector logs
sudo journalctl -u otelcol-contrib | grep tetragon
```

### High kernel overhead

If Tetragon causes performance issues, reduce policy scope:

- Use `matchBinaries` to limit to Node.js only
- Remove high-volume policies (like process-exec) if not needed
- Increase rate limits in policies

## Resources

- [Tetragon Documentation](https://tetragon.io/docs/)
- [TracingPolicy Reference](https://tetragon.io/docs/concepts/tracing-policy/)
- [Cilium/Tetragon GitHub](https://github.com/cilium/tetragon)
