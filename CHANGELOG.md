# Changelog

All notable changes to the OpenClaw OTel Observability Plugin are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Changed

- **`captureContent` is now wired end-to-end to Traceloop LLM-client spans.** Setting `captureContent: true` in the plugin config (plus `OPENCLAW_OTEL_CAPTURE_CONTENT=true` in the gateway's environment, read by `instrumentation/preload.mjs` before Traceloop loads) causes `@traceloop/instrumentation-anthropic` and `@traceloop/instrumentation-openai` to record prompt and completion text as `gen_ai.prompt.*` / `gen_ai.completion.*` span attributes. Previously the option was accepted but had no effect on LLM-client spans.
  - Default stays `false` (privacy-first).
  - `captureContent` is a **gateway-launch setting, not hot-reloadable** — the preload runs before plugin config is parsed, so the Traceloop instrumentations are constructed once at process start. Restart the gateway to pick up changes.
  - The plugin logs a warning at `start()` if the config and the preload's resolved env-var value disagree.
  - See [docs/security/privacy.md](docs/security/privacy.md) and [docs/configuration.md](docs/configuration.md#capturecontent-gateway-launch-setting).
  - Resolves [github issue #15](https://github.com/henrikrexed/openclaw-observability-plugin/issues/15) (ISI-733 / ISI-734).

### Added

- `instrumentation/capture-content.mjs` exports `resolveCaptureContent(env)` and the `CAPTURE_CONTENT_ENV` constant, consumed by the preload and covered by `instrumentation/capture-content.test.mjs` (`npm test`, uses `node --test`).
- `docs/security/privacy.md` — new page covering the privacy implications of `captureContent`, how to enable it safely, and redaction guidance.
