/**
 * Resolve the Traceloop `traceContent` flag from the environment.
 *
 * `captureContent` on the plugin config controls whether LLM prompt/completion
 * text is recorded on Traceloop spans. Because the preload runs *before* the
 * plugin's `start()` phase (NODE_OPTIONS=--import loads it before anything
 * else), the value must be bridged through an environment variable that is
 * set by whatever launches the gateway.
 *
 * Strict string match on 'true'. Any other value (including '1', 'True',
 * 'yes', unset) resolves to `false` so privacy-first stays the default.
 */
export function resolveCaptureContent(env = process.env) {
  return env.OPENCLAW_OTEL_CAPTURE_CONTENT === "true";
}

export const CAPTURE_CONTENT_ENV = "OPENCLAW_OTEL_CAPTURE_CONTENT";
