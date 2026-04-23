/**
 * Sanity test for the captureContent → traceContent wiring.
 *
 * The preload uses `resolveCaptureContent(process.env)` to decide whether
 * Traceloop records prompt/completion text on LLM-client spans. This test
 * pins the resolution semantics so a future regression that (for example)
 * loosens the comparison to truthy won't silently change the privacy
 * default from `false` to `true`.
 *
 * Run with: npm test
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { resolveCaptureContent, CAPTURE_CONTENT_ENV } from "./capture-content.mjs";

test("returns false when env var is unset", () => {
  assert.equal(resolveCaptureContent({}), false);
});

test("returns true only for the exact lowercase string 'true'", () => {
  assert.equal(resolveCaptureContent({ [CAPTURE_CONTENT_ENV]: "true" }), true);
});

test("returns false for 'false'", () => {
  assert.equal(resolveCaptureContent({ [CAPTURE_CONTENT_ENV]: "false" }), false);
});

test("returns false for other truthy strings (privacy-first default)", () => {
  for (const value of ["1", "yes", "True", "TRUE", "on", " true ", "enabled"]) {
    assert.equal(
      resolveCaptureContent({ [CAPTURE_CONTENT_ENV]: value }),
      false,
      `expected '${value}' to resolve to false`
    );
  }
});

test("returns false for empty string", () => {
  assert.equal(resolveCaptureContent({ [CAPTURE_CONTENT_ENV]: "" }), false);
});

test("exports the env var name so callers stay in sync", () => {
  assert.equal(CAPTURE_CONTENT_ENV, "OPENCLAW_OTEL_CAPTURE_CONTENT");
});
