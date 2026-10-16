// The contextual skip pill — the small bottom-right "Skip intro" offer the
// full-screen Player shows when the playhead crosses a known section window
// (intro / recap / end credits) and the auto-skip switch is OFF.
//
// pillState is a PURE decision (no DOM, no state): same input → same Pill or
// null (pill hidden). It reuses segAction (src/putio/segments.ts) for the
// window logic — the shared rule the engine also uses — and adds the pill's
// visibility gates. The contract this test pins:
//   - a Pill appears ONLY for the FIRST unconsumed segment whose window
//     contains t (start <= t < end; a null end runs to the media end)
//   - Pill = { label, index, target }:
//       label  "Skip intro" / "Skip recap" / "Skip credits" (by seg type)
//       index  the segment's index (the Player marks it consumed on settle —
//              a settled section is never offered again)
//       target where skipping lands: seg.end ?? duration (credits run to the
//              media end — the Player's credits path ends the episode, so it
//              only needs index + label; target is returned for uniformity)
//   - gates, ALL must hold for a visible pill:
//       autoSkip OFF (the engine auto-skips; no offer), mode "full" (the
//       docked player shows no pill), no panel open, and a real duration
//       (live / unknown duration → hidden)
//
// Run: pnpm vitest run test/ctx-pill.test.mjs
import { test } from "vitest";
import assert from "node:assert/strict";
import { pillState } from "../src/putio/ctx-pill.ts";

// One episode with all three section kinds (TheIntroDB seconds, sorted by
// start): intro 60–150, recap 150–240, credits 2340–end. The middle is a
// long gap, so "after the window" lands in real silence, not the next
// window.
const BASE = {
  segs: [
    { type: "intro", start: 60, end: 150 },
    { type: "recap", start: 150, end: 240 },
    { type: "credits", start: 2340, end: null },
  ],
  time: 90,
  duration: 2400,
  consumed: [false, false, false],
  mode: "full",
  autoSkip: false,
  panelOpen: false,
};

const pill = (over = {}) => pillState({ ...BASE, ...over });

test("offers the skip when the playhead is inside the intro window", () => {
  assert.deepEqual(pill(), { label: "Skip intro", index: 0, target: 150 });
});

test("stays hidden before the window opens and after it closes", () => {
  assert.equal(pill({ time: 59 }), null); // 1s before the intro starts
  assert.equal(pill({ time: 1000 }), null); // in the gap after the recap
  assert.equal(pill({ time: 2400 }), null); // at the very end: credits' window is open only until t < duration
});

test("never re-offers a section that was settled (consumed)", () => {
  assert.equal(pill({ time: 90, consumed: [true, false, false] }), null);
  assert.equal(pill({ time: 200, consumed: [false, true, false] }), null);
  assert.equal(pill({ time: 2350, consumed: [false, false, true] }), null);
});

test("no offer when auto-skip is ON (the engine skips on its own)", () => {
  assert.equal(pill({ time: 90, autoSkip: true }), null); // intro
  assert.equal(pill({ time: 200, autoSkip: true }), null); // recap
  assert.equal(pill({ time: 2350, autoSkip: true }), null); // credits
});

test("the docked player (mini / micro) shows no pill", () => {
  assert.equal(pill({ mode: "mini" }), null);
  assert.equal(pill({ mode: "micro" }), null);
});

test("hides the pill while a panel is open", () => {
  assert.equal(pill({ panelOpen: true }), null);
});

test("hides the pill on live / unknown duration", () => {
  assert.equal(pill({ duration: 0 }), null);
  assert.equal(pill({ duration: Infinity }), null);
  assert.equal(pill({ duration: NaN }), null);
});

test("the label names the section: intro, recap, credits", () => {
  assert.equal(pill({ time: 90 }).label, "Skip intro");
  assert.equal(pill({ time: 200 }).label, "Skip recap");
  assert.equal(pill({ time: 2350 }).label, "Skip credits");
});

test("the target lands on the section end; credits land on the media end", () => {
  assert.equal(pill({ time: 90 }).target, 150); // intro.end
  assert.equal(pill({ time: 200 }).target, 240); // recap.end
  assert.equal(pill({ time: 2350 }).target, 2400); // credits.end is null → duration
});

test("returns the segment's index so the Player can mark it consumed", () => {
  assert.equal(pill({ time: 90 }).index, 0);
  assert.equal(pill({ time: 200 }).index, 1);
  assert.equal(pill({ time: 2350 }).index, 2);
});

test("with overlapping unconsumed windows, offers the FIRST window containing t", () => {
  const segs = [
    { type: "intro", start: 60, end: 150 },
    { type: "recap", start: 140, end: 240 }, // overlaps the intro by 10s
  ];
  assert.deepEqual(pill({ segs, consumed: [false, false], time: 145 }), {
    label: "Skip intro",
    index: 0,
    target: 150,
  });
  assert.equal(pill({ segs, consumed: [false, false], time: 200 }).index, 1); // intro closed, recap is first that contains t
});

test("no segment data (null / undefined / empty) → no pill", () => {
  assert.equal(pill({ segs: null }), null);
  assert.equal(pill({ segs: undefined }), null);
  assert.equal(pill({ segs: [] }), null);
});

test("no pill before playback starts (time 0)", () => {
  assert.equal(pill({ time: 0 }), null);
});
