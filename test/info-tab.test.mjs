// Unit tests for the player's Info panel content (src/putio/info-tab.ts).
//
// The Info panel says ONLY what the title view cannot: a synopsis (the
// centerpiece), a details row (rating · genres · air-date-or-runtime), and a
// focusable actions row. It never repeats the title, and it practices an
// honest fallback: missing data is OMITTED — no fake metadata, no placeholder
// text, no empty row.
//
// Contract of buildInfoPanel(input):
//   synopsis  — trimmed passthrough; null/""/whitespace-only → null.
//   details   — display-ordered parts, empties omitted:
//                 episode: [rating, genres, "Aired <airDate>"]
//                 movie:   [rating, genres, runtime]   (runtime never prefixed)
//               rating → one decimal ("8.2", "7.0"); genres joined with " · ".
//               All parts empty → [] (the screen omits the whole row).
//   actions   — always starts with { id: "restart", label: "Play from beginning" };
//               episodes add { id: "upnext", label: "Up next · S3 E2 — <title>" }
//               only when a next episode with a non-empty title exists.
//               Movies ignore upNext entirely (defensive).
//
// airDate/runtime arrive PRE-FORMATTED from the async data layer
// ("May 12, 2021", "2h 04m") — this module never formats dates.
//
// Run: pnpm vitest run test/info-tab.test.mjs

import { test } from "vitest";
import assert from "node:assert/strict";
import { buildInfoPanel } from "../src/putio/info-tab.ts";

const RESTART_ONLY = [{ id: "restart", label: "Play from beginning" }];

// ---------------- episode ----------------

test("episode with full data → synopsis, 3-part details row, restart + up next actions", () => {
  const panel = buildInfoPanel({
    kind: "episode",
    synopsis: "  The patient list keeps growing.  ",
    details: { rating: 8.2, genres: ["Drama", "Medical"], airDate: "May 12, 2021" },
    upNext: { season: 3, episode: 2, title: "The Long Way" },
  });
  assert.deepEqual(panel, {
    synopsis: "The patient list keeps growing.",
    details: ["8.2", "Drama · Medical", "Aired May 12, 2021"],
    chapters: [],
    actions: [
      { id: "restart", label: "Play from beginning" },
      { id: "upnext", label: "Up next · S3 E2 — The Long Way" },
    ],
  });
});

test("episode with missing rating and air date → row shrinks, order preserved", () => {
  const panel = buildInfoPanel({ kind: "episode", details: { genres: ["Documentary"] } });
  assert.deepEqual(panel.details, ["Documentary"]);
});

test("episode with missing genres → rating and air date keep their order", () => {
  const panel = buildInfoPanel({ kind: "episode", details: { rating: 7.9, airDate: "Jan 3, 2020" } });
  assert.deepEqual(panel.details, ["7.9", "Aired Jan 3, 2020"]);
});

test("episode without up next → single restart action", () => {
  assert.deepEqual(buildInfoPanel({ kind: "episode" }).actions, RESTART_ONLY);
  assert.deepEqual(buildInfoPanel({ kind: "episode", upNext: null }).actions, RESTART_ONLY);
});

test("episode with an empty up-next title → no up next action (honest fallback)", () => {
  const actions = buildInfoPanel({
    kind: "episode",
    upNext: { season: 1, episode: 2, title: "" },
  }).actions;
  assert.deepEqual(actions, RESTART_ONLY);
});

// ---------------- movie ----------------

test("movie with full data → rating · genre · runtime, no air date, restart only", () => {
  const panel = buildInfoPanel({
    kind: "movie",
    synopsis: "A heist gone wrong.",
    details: { rating: 7.4, genres: ["Thriller"], runtime: "2h 04m" },
  });
  assert.deepEqual(panel, {
    synopsis: "A heist gone wrong.",
    details: ["7.4", "Thriller", "2h 04m"],
    chapters: [],
    actions: [{ id: "restart", label: "Play from beginning" }],
  });
});

test("movie with up next passed → still restart only (defensive: up next is episode-only)", () => {
  const actions = buildInfoPanel({
    kind: "movie",
    upNext: { season: 3, episode: 2, title: "The Long Way" },
  }).actions;
  assert.deepEqual(actions, RESTART_ONLY);
});

test("movie never shows an air date, even if one is present in details", () => {
  const panel = buildInfoPanel({
    kind: "movie",
    details: { airDate: "May 12, 2021", runtime: "2h 04m" },
  });
  assert.deepEqual(panel.details, ["2h 04m"]);
});

// ---------------- synopsis ----------------

test("synopsis is a trimmed passthrough", () => {
  assert.equal(buildInfoPanel({ kind: "movie", synopsis: "  Hi there.  " }).synopsis, "Hi there.");
});

test("synopsis absent / null / empty / whitespace-only → null (never a placeholder)", () => {
  assert.equal(buildInfoPanel({ kind: "movie" }).synopsis, null);
  assert.equal(buildInfoPanel({ kind: "movie", synopsis: null }).synopsis, null);
  assert.equal(buildInfoPanel({ kind: "movie", synopsis: "" }).synopsis, null);
  assert.equal(buildInfoPanel({ kind: "movie", synopsis: "   " }).synopsis, null);
});

// ---------------- details row ----------------

test("all details empty → [] (the screen omits the whole row)", () => {
  assert.deepEqual(buildInfoPanel({ kind: "episode" }).details, []);
  assert.deepEqual(buildInfoPanel({ kind: "episode", details: null }).details, []);
  assert.deepEqual(buildInfoPanel({ kind: "episode", details: {} }).details, []);
  assert.deepEqual(
    buildInfoPanel({
      kind: "movie",
      details: { rating: null, genres: [], airDate: null, runtime: null },
    }).details,
    [],
  );
});

test("rating formats to one decimal (8.2 → '8.2', 7 → '7.0')", () => {
  assert.deepEqual(buildInfoPanel({ kind: "movie", details: { rating: 8.2 } }).details, ["8.2"]);
  assert.deepEqual(buildInfoPanel({ kind: "movie", details: { rating: 7 } }).details, ["7.0"]);
});

test("absent or null rating → omitted from the row", () => {
  assert.deepEqual(buildInfoPanel({ kind: "movie", details: {} }).details, []);
  assert.deepEqual(buildInfoPanel({ kind: "movie", details: { rating: null } }).details, []);
  assert.deepEqual(
    buildInfoPanel({ kind: "movie", details: { rating: null, runtime: "1h 32m" } }).details,
    ["1h 32m"],
  );
});

test("genres join with ' · ' — one and three genres", () => {
  assert.deepEqual(buildInfoPanel({ kind: "movie", details: { genres: ["Thriller"] } }).details, [
    "Thriller",
  ]);
  assert.deepEqual(
    buildInfoPanel({ kind: "movie", details: { genres: ["Crime", "Drama", "Thriller"] } }).details,
    ["Crime · Drama · Thriller"],
  );
});

test("empty or absent genres → omitted", () => {
  assert.deepEqual(buildInfoPanel({ kind: "movie", details: { genres: [] } }).details, []);
  assert.deepEqual(buildInfoPanel({ kind: "movie", details: { genres: null } }).details, []);
});

// ---------------- exact label formats ----------------

test("up next label is exactly 'Up next · S{s} E{e} — <title>' (single-digit, no padding)", () => {
  const actions = buildInfoPanel({
    kind: "episode",
    upNext: { season: 3, episode: 2, title: "The Long Way" },
  }).actions;
  assert.deepEqual(actions[1], { id: "upnext", label: "Up next · S3 E2 — The Long Way" });
});

test("up next label keeps unpadded numbers for two-digit seasons/episodes", () => {
  const actions = buildInfoPanel({
    kind: "episode",
    upNext: { season: 12, episode: 1, title: "Finale" },
  }).actions;
  assert.equal(actions[1].label, "Up next · S12 E1 — Finale");
});

test("air date gets the 'Aired ' prefix in the episode row; runtime passes through bare", () => {
  const episode = buildInfoPanel({ kind: "episode", details: { airDate: "May 12, 2021" } });
  assert.deepEqual(episode.details, ["Aired May 12, 2021"]);
  const movie = buildInfoPanel({ kind: "movie", details: { runtime: "2h 04m" } });
  assert.deepEqual(movie.details, ["2h 04m"]);
});
