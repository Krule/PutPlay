// ISSUE: put.io returns 429 on login — the app was hammering the auth API.
//
// Root cause: the out-of-band sign-in poll (store/auth.ts) had NO expiry and
// swallowed every error — including 429 rate-limit responses — then
// rescheduled at the same 3s cadence. A TV left on the sign-in screen
// (or a code that expired, or a rate-limited account) produced a request
// every 3 seconds, forever: ~2,880 requests/day. Worse, stopping the poll
// while a request was in flight let the in-flight tick reschedule AFTER
// the stop (zombie poller).
//
// Fix contract:
//  - oob-poll.ts: pure nextPollStep() decides each step —
//      * never polls after the code TTL (5 min)
//      * a 429 STOPS the poll (manual retry with a fresh code)
//      * other consecutive errors back off 3s → 5s → 8s → 15s (capped)
//  - auth.ts uses the planner, tracks consecutive errors + 429, and kills
//    in-flight ticks with a generation counter (no zombies).
//
// Run: pnpm test
import { test } from "vitest";
import assert from "assert/strict";
import { nextPollStep, OOB_CODE_TTL_MS } from "../src/putio/oob-poll.ts";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "url";

const here = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(here, "..", p), "utf8");

test("fresh code, healthy endpoint — poll at the base 3s cadence", () => {
  const d = nextPollStep({ elapsedMs: 1000, consecutiveErrors: 0, lastErrorWas429: false });
  assert.deepEqual(d, { action: "poll", delayMs: 3000 });
});

test("code TTL — never poll after 5 minutes (expired codes must not be polled)", () => {
  const atTtl = nextPollStep({ elapsedMs: OOB_CODE_TTL_MS, consecutiveErrors: 0, lastErrorWas429: false });
  assert.deepEqual(atTtl, { action: "stop", reason: "code-expired" });
  const pastTtl = nextPollStep({ elapsedMs: OOB_CODE_TTL_MS + 60_000, consecutiveErrors: 0, lastErrorWas429: false });
  assert.deepEqual(pastTtl, { action: "stop", reason: "code-expired" });
});

test("429 rate-limit — STOP the poll (hammering a limiter only deepens it)", () => {
  const d = nextPollStep({ elapsedMs: 3000, consecutiveErrors: 1, lastErrorWas429: true });
  assert.deepEqual(d, { action: "stop", reason: "rate-limited" });
});

test("consecutive errors back off: 3s → 5s → 8s → 15s, capped at 15s", () => {
  const step = (n) => nextPollStep({ elapsedMs: 1000, consecutiveErrors: n, lastErrorWas429: false }).delayMs;
  assert.equal(step(0), 3000);
  assert.equal(step(1), 5000);
  assert.equal(step(2), 8000);
  assert.equal(step(3), 15000);
  assert.equal(step(9), 15000); // capped — an offline TV never hammers
});

test("auth.ts drives its poll from the planner (no more hardcoded forever-loop)", () => {
  const auth = read("src/store/auth.ts");
  assert.ok(/nextPollStep\(/.test(auth), "the poll loop must consult nextPollStep for every step");
  assert.ok(!/pollTimer = window\.setTimeout\(tick, 3000\)/.test(auth), "the old fixed-3s reschedule must be gone");
});

test("auth.ts detects 429 from the error status", () => {
  const auth = read("src/store/auth.ts");
  assert.ok(/status === 429|status\s*==\s*429/.test(auth), "a 429 response must be recognized (PutioError.status)");
});

test("auth.ts kills in-flight ticks — a stop must not be resurrected by a pending request", () => {
  const auth = read("src/store/auth.ts");
  assert.ok(/pollGen/.test(auth), "a generation counter must invalidate in-flight ticks");
  const stop = auth.slice(auth.indexOf("export function stopOOBPoll"));
  const stopBody = stop.slice(0, stop.indexOf("}"));
  assert.ok(/pollGen/.test(stopBody), "stopOOBPoll must bump the generation so a pending tick sees itself as dead");
});
