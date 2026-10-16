// Unit tests for the player chrome's title view (src/putio/title-view.ts).
//
// The chrome shows the file's IDENTITY instead of the raw file name:
//   - an EPISODE (titles.ts found a marker) → the parsed show title as the
//     title and an "S3 · E1" line as the subtitle; once the late TMDb
//     enrichment lands a real episode title, it is appended after an
//     em-dash: "S3 · E1 — The Zone".
//   - a non-episode file (a movie) → the file name as the title, no
//     subtitle line at all.
//   - badges, in order: LIVE (accented) only for ∞-duration streams, then
//     the source badge for the CONVERTED sources only (mp4 → MP4,
//     hls → HLS) — the original file plays itself, so it stays badge-less
//     (mockup chrome: [LIVE][HLS], docs/mockups/player-sheet.html).
//
// The decision is extracted as a pure function so it is testable in node:
//   buildTitleView({ name, episode, live, source, episodeName }) →
//     { title, subtitle, badges }
//
// Honest fallbacks only: no parsed episode → no S/E line, no episode
// title → no em-dash part. The parse comes from titles.ts; the view
// never re-parses the name.
//
// Run: pnpm test

import { test } from "vitest";
import assert from "node:assert/strict";
import { buildTitleView } from "../src/putio/title-view.ts";

// The parsed episode (the titles.ts EpisodeId shape) and its messy name.
const EP = { title: "Breaking Bad", season: 3, episode: 1 };
const NAME = "Breaking.Bad.S03E01.720p.mkv";
// The VOD/original baselines — each test overrides one field at a time.
const base = { name: NAME, episode: EP, live: false, source: "original" };
const MOVIE_NAME = "Dune (2021).1080p.mkv";
const movie = { name: MOVIE_NAME, episode: null, live: false, source: "original" };

// ---------------- title / subtitle ----------------

test("episode without episode title → show title + \"S3 · E1\" subtitle, no badges", () => {
  const v = buildTitleView(base);
  assert.equal(v.title, "Breaking Bad");
  assert.equal(v.subtitle, "S3 · E1");
  assert.deepEqual(v.badges, []);
});

test("episode with TMDb episode title → \"S3 · E1 — <episodeName>\"", () => {
  const v = buildTitleView({ ...base, episodeName: "One Minute" });
  assert.equal(v.title, "Breaking Bad");
  assert.equal(v.subtitle, "S3 · E1 — One Minute");
});

test("empty episode title is no episode title (no em-dash part)", () => {
  const v = buildTitleView({ ...base, episodeName: "" });
  assert.equal(v.subtitle, "S3 · E1");
});

test("whitespace-only episode title is no episode title", () => {
  const v = buildTitleView({ ...base, episodeName: "   " });
  assert.equal(v.subtitle, "S3 · E1");
});

test("explicit null episode title is no episode title", () => {
  const v = buildTitleView({ ...base, episodeName: null });
  assert.equal(v.subtitle, "S3 · E1");
});

test("multi-digit season/episode pass through unpadded (the parsed numbers)", () => {
  const v = buildTitleView({ ...base, episode: { title: "Show", season: 12, episode: 205 } });
  assert.equal(v.subtitle, "S12 · E205");
});

test("movie (no episode) → file name as title, empty subtitle", () => {
  const v = buildTitleView(movie);
  assert.equal(v.title, MOVIE_NAME);
  assert.equal(v.subtitle, "");
});

test("movie with episodeName still shows no subtitle (movies have no episode line)", () => {
  const v = buildTitleView({ ...movie, episodeName: "ignored" });
  assert.equal(v.title, MOVIE_NAME);
  assert.equal(v.subtitle, "");
});

// ---------------- badges ----------------

test("live stream → accent LIVE badge; VOD → no LIVE badge", () => {
  assert.deepEqual(buildTitleView({ ...base, live: true }).badges, [{ label: "LIVE", accent: true }]);
  assert.deepEqual(buildTitleView({ ...base, live: false }).badges, []);
});

test("original source → no badge (only converted sources are badged)", () => {
  assert.deepEqual(buildTitleView({ ...base, source: "original" }).badges, []);
});

test("mp4 source → MP4 badge", () => {
  assert.deepEqual(buildTitleView({ ...base, source: "mp4" }).badges, [{ label: "MP4" }]);
});

test("hls source → HLS badge", () => {
  assert.deepEqual(buildTitleView({ ...base, source: "hls" }).badges, [{ label: "HLS" }]);
});

test("LIVE comes before the source badge (mockup order: [LIVE][HLS])", () => {
  const v = buildTitleView({ ...base, live: true, source: "hls" });
  assert.deepEqual(v.badges, [
    { label: "LIVE", accent: true },
    { label: "HLS" },
  ]);
});

test("movie + live + mp4 → LIVE and MP4 badges, still no subtitle", () => {
  const v = buildTitleView({ ...movie, live: true, source: "mp4" });
  assert.equal(v.subtitle, "");
  assert.deepEqual(v.badges, [
    { label: "LIVE", accent: true },
    { label: "MP4" },
  ]);
});
