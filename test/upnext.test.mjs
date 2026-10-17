// Unit tests for the info panel's "Up next" (src/putio/upnext.ts).
//
// Locked design: Up next is PURE QUEUE RESOLUTION — no network. It is the
// file the player's auto-next is about to play (the session's video queue,
// listing order, end of queue is a STOP not a wrap), identified when its
// name parses as an episode. A next file that is not an identifiable
// episode (a movie, an unparseable name) yields no Up next — the info-tab
// module then omits the action. The label data is exactly what
// info-tab's buildInfoPanel consumes: { season, episode, title }.
//
// Run: pnpm test

import { test } from "vitest";
import assert from "node:assert/strict";
import { upNext } from "../src/putio/upnext.ts";

const f = (name) => ({ id: Math.floor(Math.random() * 1e9), name, content_type: "video/mp4" });

const Q = [
  f("Breaking.Bad.S01E04.720p.mkv"),
  f("Breaking.Bad.S01E05.720p.mkv"),
  f("Breaking.Bad.S01E06.720p.mkv"),
];

test("the next episode in the queue is the Up next (its parsed identity)", () => {
  // watching S01E05 (index 1) → up next is S01E06
  assert.deepEqual(upNext(Q, 1), { season: 1, episode: 6, title: "Breaking Bad" });
});

test("anime-style bare episode numbers resolve too", () => {
  const anime = [
    f("[SubsPlease] Black Clover - 171 (1080p) [7AD4AFC7].mkv"),
    f("[SubsPlease] Black Clover - 172 (1080p) [9BC1E2DF].mkv"),
  ];
  const got = upNext(anime, 0);
  assert.equal(got.episode, 172);
  assert.equal(got.season, 1);
  assert.match(got.title, /Black Clover/);
});

test("end of the queue has no Up next (a STOP, not a wrap)", () => {
  assert.equal(upNext(Q, 2), null);
});

test("a next file that is not an episode (a movie) has no Up next", () => {
  const mixed = [Q[1], f("Midnight.Static.2019.1080p.BluRay.x264.mkv")];
  assert.equal(upNext(mixed, 0), null);
});

test("no queue (file opened from a deeper listing) has no Up next", () => {
  assert.equal(upNext(null, 0), null);
  assert.equal(upNext([], 0), null);
  assert.equal(upNext([Q[0]], 0), null); // only file in the queue
});

test("the current file not in the queue still finds its successor", () => {
  // index 0 is the clamped fallback (buildVideoQueue's rule) — the first
  // listed file is "current", the second is the Up next
  assert.deepEqual(upNext(Q, 0), { season: 1, episode: 5, title: "Breaking Bad" });
});
