/**
 * Tests for the strict-mode sentinel header warning.
 *
 * Runs via `node --test --import tsx` (see `npm test`). No test framework
 * dependency — `node:test` ships with Node 20+.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { noteSentinelHeader, resetSentinelStateForTest } from "./sentinel.js";

function makeResponse(headers: Record<string, string>): Response {
  return new Response(null, { headers });
}

function captureWarnings(): {
  restore: () => void;
  warnings: string[];
} {
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map((a) => String(a)).join(" "));
  };
  return {
    warnings,
    restore: () => {
      console.warn = original;
    },
  };
}

test("emits warning once when sentinel header is present", () => {
  resetSentinelStateForTest();
  const cap = captureWarnings();
  try {
    noteSentinelHeader(makeResponse({ "X-Quelvio-Sentinel-Set": "closed-v1" }));
    noteSentinelHeader(makeResponse({ "X-Quelvio-Sentinel-Set": "closed-v1" }));
    noteSentinelHeader(makeResponse({ "X-Quelvio-Sentinel-Set": "closed-v1" }));
  } finally {
    cap.restore();
  }
  // First call emits 4 lines (event + 3 human-readable). Subsequent are silent.
  assert.equal(cap.warnings.length, 4);
  assert.match(cap.warnings[0], /quelvio_sentinel_set_detected/);
  assert.match(cap.warnings[0], /sentinel=closed-v1/);
  assert.match(cap.warnings[1], /strict permission mode/);
  assert.match(cap.warnings[3], /docs\.quelvio\.com\/permission-model/);
});

test("emits nothing when header is absent", () => {
  resetSentinelStateForTest();
  const cap = captureWarnings();
  try {
    noteSentinelHeader(makeResponse({}));
    noteSentinelHeader(makeResponse({ "X-Other-Header": "value" }));
  } finally {
    cap.restore();
  }
  assert.equal(cap.warnings.length, 0);
});

test("different sentinel values warn independently", () => {
  resetSentinelStateForTest();
  const cap = captureWarnings();
  try {
    noteSentinelHeader(makeResponse({ "X-Quelvio-Sentinel-Set": "closed-v1" }));
    noteSentinelHeader(makeResponse({ "X-Quelvio-Sentinel-Set": "closed-v2" }));
    // Repeats stay deduped.
    noteSentinelHeader(makeResponse({ "X-Quelvio-Sentinel-Set": "closed-v1" }));
    noteSentinelHeader(makeResponse({ "X-Quelvio-Sentinel-Set": "closed-v2" }));
  } finally {
    cap.restore();
  }
  // 4 lines per unique value, two unique values = 8 lines.
  assert.equal(cap.warnings.length, 8);
});
