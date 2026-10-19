// OUTER acceptance test: skip intro / recap / credits from REAL show data.
//
// The story: an episode's section boundaries (intro, recap, end credits) are
// KNOWN — a community database (TheIntroDB) carries them, keyed by TMDb id.
// The app resolves a put.io file's title/episode from its name, looks the
// show up on TMDb (a key baked into the app at build time — the TV has no
// viable way to type one), fetches the segments, and then:
//   - the Settings switch is ON  → playback auto-skips at each boundary
//   - the switch is OFF          → the player offers the skip per section
// A resume always wins; a title with no data is left alone; no key = the
// feature is off (and nothing is fetched).
//
// The contract this test pins:
//   1. the chain (seglookup.ts): filename → title/season/episode → TMDb
//      search (baked-in key, Bearer) → TheIntroDB media (no auth) → Seg[] —
//      re-fetched on every play (caching suspended while the feature
//      settles); no key → zero network; no match / no data → []
//      A name WITHOUT an episode marker is a movie: parseMovieName → the
//      TMDb movie query ladder (movieQueryStages) → TheIntroDB's
//      MOVIE-level media (the film's own intro/credits).
//   2. the engine (the REAL MediaEngine, bundled, driven by a minimal fake
//      <video> — same harness as music-player.test.mjs):
//        - a fresh start lands past the leading intro+recap block, reported
//          once (skippedSeg)
//        - a short file is never skipped past its content
//        - a saved position WINS (a resume is never yanked)
//        - a seek to 0 (scrubbing back to the start — the "start from
//          beginning" of the redesigned player) is honored as-is: no
//          content-start re-derivation, no late fresh-skip
//        - segment data that arrives AFTER the metadata still applies the
//          fresh skip (the lookup is async, the intro is long)
//        - a finished / credits-skipped video saves NO resume position
//   3. the wiring: the Player runs the lookup and owns the per-segment
//      action (auto-skip seek / offer / credits→advance); the Settings card
//      persists the single switch (the key is embedded, not configured);
//      the engine derives the
//      fresh target from the shared pure module; the Settings columns still
//      scroll (a clipped card is unreachable — the v1 layout regression).
//
// Run: pnpm test
// media.ts pulls platform.ts → webostvjs: the window + localStorage shims
// (imported first) must exist before those modules load.
import "./shims/node-webos.mjs";
import { compile, preprocess } from "svelte/compiler";
import sveltePreprocess from "svelte-preprocess";
import { vi, test } from "vitest";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { MediaEngine } from "../src/putio/media.ts";
import { DEFAULT_CONFIG } from "../src/putio/config.ts";
import { parseEpisode } from "../src/putio/titles.ts";
import { parseSegments } from "../src/putio/introdb.ts";
import { pickTmdbMatch } from "../src/putio/tmdb.ts";
import { anilistSearchAnime, pickAnilistMatch } from "../src/putio/anilist.ts";
import { aniskipSegments, aniskipSegmentsV1 } from "../src/putio/aniskip.ts";
import { parseIntrodbAppSegments } from "../src/putio/introdb-app.ts";
import { lookupSegments, mergeSegments, fuseSegments } from "../src/putio/seglookup.ts";

// The fake <video> drives the engine — hls.js is stubbed, as the old
// esbuild alias did.
vi.mock("hls.js", () => ({ default: class Hls {} }));

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const read = (p) => readFileSync(join(root, p), "utf8");

// A fetch router: the put.io start-from calls are logged (the "no resume
// saved after a skip" assertion); TMDb + TheIntroDB return per-test canned
// responses so the chain runs offline with real URL/header assertions.
const net = {
  putio: [],
  tmdbCalls: [],
  tidbCalls: [],
  anilistCalls: [],
  aniskipCalls: [],
  aniskip1Calls: [],
  idbaCalls: [],
  tmdb: null, // canned TMDb search response (or null = {})
  tidb: null, // canned TheIntroDB media response (or null = {})
  anilist: null, // canned AniList GraphQL response (or null = {})
  aniskip: null, // canned AniSkip v2 skip-times response (or null = {})
  aniskip1: null, // canned AniSkip v1 (legacy DB) response (or null = {})
  idba: null, // canned introdb.app segments response (or null = {})
};
globalThis.fetch = (url, init) => {
  const u = String(url);
  const method = (init && init.method) || "GET";
  if (u.includes("start-from")) {
    net.putio.push({ url: u, method });
    return Promise.reject(new Error("no network in unit tests"));
  }
  if (u.startsWith("https://api.themoviedb.org/")) {
    net.tmdbCalls.push({ url: u, headers: init && init.headers });
    return Promise.resolve(
      new Response(JSON.stringify(net.tmdb || { results: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );
  }
  if (u.startsWith("https://api.theintrodb.org/")) {
    net.tidbCalls.push({ url: u });
    // The real API answers no-data with a 404 (verified live) — the canned
    // `found: false` knob mimics it; a 200 with a segment-less body is the
    // other honest shape (parseSegments yields []).
    const found = !net.tidb || net.tidb.found !== false;
    return Promise.resolve(
      new Response(JSON.stringify(net.tidb || {}), {
        status: found ? 200 : 404,
        headers: { "Content-Type": "application/json" },
      })
    );
  }
  if (u.startsWith("https://graphql.anilist.co")) {
    net.anilistCalls.push({ url: u, body: init && init.body });
    return Promise.resolve(
      new Response(JSON.stringify(net.anilist || {}), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );
  }
  if (u.startsWith("https://api.aniskip.com/v1/")) {
    net.aniskip1Calls.push({ url: u });
    const found = !net.aniskip1 || net.aniskip1.found !== false;
    return Promise.resolve(
      new Response(JSON.stringify(net.aniskip1 || {}), {
        status: found ? 200 : 404,
        headers: { "Content-Type": "application/json" },
      })
    );
  }
  if (u.startsWith("https://api.aniskip.com/")) {
    net.aniskipCalls.push({ url: u });
    const found = !net.aniskip || net.aniskip.found !== false;
    return Promise.resolve(
      new Response(JSON.stringify(net.aniskip || {}), {
        status: found ? 200 : 404,
        headers: { "Content-Type": "application/json" },
      })
    );
  }
  if (u.startsWith("https://api.introdb.app/")) {
    net.idbaCalls.push({ url: u });
    return Promise.resolve(
      new Response(JSON.stringify(net.idba || {}), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );
  }
  return Promise.reject(new Error("unexpected network in unit tests: " + u));
};

// platform.toast touches document — a stub is enough for it to run
const fakeEl = () => ({
  id: "",
  className: "",
  textContent: "",
  offsetWidth: 0,
  classList: { add() {}, remove() {} },
});
globalThis.document = {
  getElementById: () => null,
  createElement: () => fakeEl(),
  body: { appendChild() {} },
};

const AUTH = { oauthToken: "tok", downloadToken: null };
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

/** Minimal fake <video>: event registry, src, load/play/pause, position. */
function makeFakeVideo() {
  const el = {
    _listeners: {},
    _src: "",
    paused: true,
    currentTime: 0,
    duration: 0, // 0 until the test delivers "metadata"
    seeking: false,
    ended: false,
    error: null,
    buffered: { length: 0, end: () => 0 },
    addEventListener(t, fn) {
      (this._listeners[t] = this._listeners[t] || []).push(fn);
    },
    removeEventListener(t, fn) {
      this._listeners[t] = (this._listeners[t] || []).filter((f) => f !== fn);
    },
    dispatch(t) {
      (this._listeners[t] || []).slice().forEach((f) => f());
    },
    pause() {
      if (this.paused) return;
      this.paused = true;
      this.dispatch("pause");
    },
    play() {
      this.paused = false;
      this.dispatch("playing");
      return Promise.resolve();
    },
    load() {},
    removeAttribute() {},
    get src() {
      return this._src;
    },
    set src(v) {
      this._src = v;
      this.error = null;
    },
  };
  return el;
}

/** Deliver loadedmetadata with a known duration. */
function meta(el, duration) {
  el.duration = duration;
  el.dispatch("loadedmetadata");
}

/** A fresh engine on the original source (the Player's first move). */
function makeEngine(file) {
  const el = makeFakeVideo();
  const patches = [];
  const engine = new MediaEngine(el, file, AUTH, {
    onState: (p) => patches.push(p),
    onSourceChange: () => {},
    onEnded: () => {},
  });
  engine.setSource("original");
  return { el, engine, patches };
}

const savePosts = () =>
  net.putio.filter((c) => c.url.includes("start-from") && c.method === "POST");

/** In-memory SegCache with the same shape the app's idb-backed one has. */
function mapCache() {
  const m = new Map();
  return {
    get: async (k) => m.get(k),
    put: async (k, v) => void m.set(k, v),
  };
}

/** The fetch router is shared between tests — a fresh net per assertion. */
function resetNet() {
  net.putio.length = 0;
  net.tmdbCalls.length = 0;
  net.tidbCalls.length = 0;
  net.anilistCalls.length = 0;
  net.aniskipCalls.length = 0;
  net.aniskip1Calls.length = 0;
  net.idbaCalls.length = 0;
  net.tmdb = null;
  net.tidb = null;
  net.anilist = null;
  net.aniskip = null;
  net.aniskip1 = null;
  net.idba = null;
}

// Canned world: the TMDb search for "Breaking Bad" returns the real show
// (id 1396) plus a near-miss; TheIntroDB carries the real S01E01 shape.
const TMDB_BBD = {
  results: [
    { id: 1396, name: "Breaking Bad", first_air_date: "2008-01-20", popularity: 900, imdb_id: "tt0903747" },
    { id: 4149034, name: "Breaking Bad Season 2", first_air_date: "2015-01-01", popularity: 50, imdb_id: "tt9999003" },
  ],
};
const TIDB_BBD = {
  tmdb_id: 1396,
  type: "tv",
  season: 1,
  episode: 1,
  intro: [{ start_ms: 228664, end_ms: 246143 }],
  credits: [{ start_ms: 3431000, end_ms: null }],
};
const TMDB_ANIME = {
  results: [
    { id: 7, name: "Test Anime", first_air_date: "2020-01-05", popularity: 10, imdb_id: "tt9999001" },
  ],
};
// The user's actual put.io file: an anime with a BARE episode number and a
// release-group tag. TMDb id 73223 is Black Clover's real id.
const TMDB_BCL = {
  results: [
    { id: 73223, name: "Black Clover", first_air_date: "2017-10-03", popularity: 63, imdb_id: "tt7441658" },
    { id: 97067, name: "Squishy! Black Clover", first_air_date: "2019-07-01", popularity: 4, imdb_id: "tt9999004" },
  ],
};
const TIDB_BCL = {
  tmdb_id: 73223,
  type: "tv",
  season: 1,
  episode: 171,
  intro: [{ start_ms: 200000, end_ms: 230000 }],
};
// The anime fallback: AniList resolves the title → MAL id (34572 is
// Black Clover's real MAL id); AniSkip carries the community-measured
// op/ed intervals (start AND end, seconds).
const ANILIST_BCL = {
  data: {
    Page: {
      media: [
        {
          // REAL pair (live-verified): the internal id (97940) and the MAL
          // id (34572) are DIFFERENT namespaces — Media(id:) takes the
          // internal one, AniSkip the MAL one.
          id: 97940,
          idMal: 34572,
          idImdb: "tt7441658", // REAL (live-verified 2026-10-18)
          title: { romaji: "Black Clover", english: "Black Clover" },
          averageScore: 72,
          startDate: { year: 2017 },
        },
        {
          id: 43318,
          idMal: 43317,
          title: { romaji: "Squishy! Black Clover", english: "Squishy! Black Clover" },
          averageScore: 40,
          startDate: { year: 2019 },
        },
      ],
    },
  },
};
const ANISKIP_BCL = {
  found: true,
  results: [
    { interval: { startTime: 105, endTime: 205 }, skipType: "op" },
    { interval: { startTime: 2400, endTime: 2500 }, skipType: "ed" },
  ],
};
// The LEGACY AniSkip DB (v1): same data model, snake_case fields, no
// episodeLength parameter. It holds finished series end-to-end (Black
// Clover 170/170) where the current v2 DB has holes.
const ANISKIP1_BCL = {
  found: true,
  results: [
    { interval: { start_time: 8.44, end_time: 98.44 }, skip_type: "op", episode_length: 1419.101 },
    { interval: { start_time: 1280.999, end_time: 1435 }, skip_type: "ed", episode_length: 1435.988 },
  ],
};
const SEGS_ANIME = [
  { type: "intro", start: 0, end: 90 },
  { type: "recap", start: 90, end: 150 },
];

// ---------------- 1a. titles.ts — filename → title / season / episode ----------------
//
// The put.io file name is the only identity we have before the lookup. The
// patterns people actually use: "Show.Name.S01E05.720p.mkv", the 2x05 form,
// episode-only anime ("One.Piece.E1045.mp4"), an optional (year) tag. A name
// without an episode marker (a movie, a sample, an image) is NOT an episode
// — the feature stays off for it, so the honest answer is null.

test("parseEpisode: the SxxEyy form carries the title, season and episode", () => {
  assert.deepEqual(parseEpisode("Breaking.Bad.S01E01.720p.mkv"), {
    title: "Breaking Bad",
    season: 1,
    episode: 1,
  });
  assert.deepEqual(parseEpisode("The.Show.S12E05.1080p.WEB-DL.mkv"), {
    title: "The Show",
    season: 12,
    episode: 5,
  });
});

test("parseEpisode: the 2x05 form is the same episode", () => {
  assert.deepEqual(parseEpisode("Show.Name.2x05.1080p.mkv"), {
    title: "Show Name",
    season: 2,
    episode: 5,
  });
});

test("parseEpisode: episode-only names are season 1 (the anime convention)", () => {
  assert.deepEqual(parseEpisode("One.Piece.E1045.720p.mp4"), {
    title: "One Piece",
    season: 1,
    episode: 1045,
  });
  assert.deepEqual(parseEpisode("Test.Anime.EP07.1080p.mkv"), {
    title: "Test Anime",
    season: 1,
    episode: 7,
  });
});

test("parseEpisode: anime-style BARE episode numbers resolve (the dominant anime scene form)", () => {
  // the user's actual put.io file
  assert.deepEqual(parseEpisode("[SubsPlease] Black Clover - 171 (1080p) [7AD4AFC7].mkv"), {
    title: "Black Clover",
    season: 1,
    episode: 171,
  });
  assert.deepEqual(parseEpisode("Black Clover 171 (1080p).mkv"), {
    title: "Black Clover",
    season: 1,
    episode: 171,
  });
  assert.deepEqual(parseEpisode("Black.Clover.171.1080p.mkv"), {
    title: "Black Clover",
    season: 1,
    episode: 171,
  });
  assert.deepEqual(parseEpisode("[Crunchyroll] Show - 1 (1080p).mkv"), {
    title: "Show",
    season: 1,
    episode: 1,
  }, "a single-digit number is an episode when a release group tag is present");
});

test("parseEpisode: ambiguous bare numbers stay null (a sequel or a tag is not an episode)", () => {
  assert.equal(parseEpisode("Show 2.mkv"), null, "1–2 digits without a group: sequel risk");
  assert.equal(parseEpisode("Some.Show.2.720p.mkv"), null, "dot-separated season-batch style");
  assert.equal(parseEpisode("Show 720.mkv"), null, "a resolution");
  assert.equal(parseEpisode("Show 2024.mkv"), null, "a year");
  assert.equal(parseEpisode("Show 1.5.mkv"), null, "a decimal special");
});

test("parseEpisode: the broken scene codec form (H 264 / X 265) is not an episode number — the user's Kindergarten Cop movie", () => {
  // the real file: the codec number (264) used to survive the GPRS word
  // strip and read as S1 E264, the movie's title ending in a stray "H"
  assert.equal(parseEpisode("Kindergarten Cop 1990 H 264-GPRS.mkv"), null, "the space-split form");
  assert.equal(parseEpisode("Kindergarten.Cop.1990.H.264.GPRS.mkv"), null, "the dot-separated form");
  assert.equal(parseEpisode("Movie 1990 X 265.mkv"), null, "the 265 variant");
  assert.equal(parseEpisode("Movie 1990 H264.mkv"), null, "the solid form");
});

test("parseEpisode: a real bare episode number BEHIND a codec tail still resolves (the tail is peeled, not fatal)", () => {
  assert.deepEqual(parseEpisode("[Group] Show 171 H 264.mkv"), {
    title: "Show",
    season: 1,
    episode: 171,
  });
});

test("parseEpisode: a (year) tag is captured for the TMDb disambiguation", () => {
  assert.deepEqual(parseEpisode("My.Show.(2021).S01E01.mkv"), {
    title: "My Show",
    season: 1,
    episode: 1,
    year: 2021,
  });
  assert.deepEqual(parseEpisode("Breaking.Bad.S01E01.720p.mkv").year, undefined, "no tag, no year");
});

test("parseEpisode: names without an episode marker are not episodes", () => {
  assert.equal(parseEpisode("Some.Movie.2019.1080p.mkv"), null, "a movie has no episode");
  assert.equal(parseEpisode("wall-1.png"), null, "an image");
  assert.equal(parseEpisode("testvid-9.mp4"), null, "a sample clip");
  assert.equal(parseEpisode("Show.1080p.mkv"), null, "a bare resolution is not an episode number");
});

test("parseEpisode: out-of-range numbers are garbage, not an episode", () => {
  assert.equal(parseEpisode("Show.S00E05.mkv"), null, "seasons start at 1");
  assert.equal(parseEpisode("Show.S01E00.mkv"), null, "episodes start at 1");
  assert.equal(parseEpisode("Show.S99E999.mkv"), null, "nobody has a 999-episode season");
});

test("parseEpisode: dots, underscores and spaces are the same title", () => {
  assert.deepEqual(parseEpisode("breaking_bad S01E02.mkv").title, "breaking bad");
  assert.equal(
    parseEpisode("Breaking.Bad.S01E01.720p.mkv").title,
    parseEpisode("Breaking Bad S01E01.mkv").title,
    "the TMDb query must be form-agnostic"
  );
});

// ---------------- 1. the chain (filename → TMDb → TheIntroDB → Seg[]) ----------------

test("the chain: filename → TMDb → TheIntroDB → segments, re-fetched on every play (caching suspended while the feature settles)", async () => {
  resetNet();
  net.tmdb = TMDB_BBD;
  net.tidb = TIDB_BBD;
  const cache = mapCache();
  const segs = await lookupSegments("fake-tmdb-key", "Breaking.Bad.S01E01.720p.mkv", undefined, cache);
  assert.deepEqual(segs, [
    { type: "intro", start: 228.664, end: 246.143 },
    { type: "credits", start: 3431, end: null },
  ]);
  assert.equal(net.tmdbCalls.length, 1, "one TMDb search");
  const tm = net.tmdbCalls[0];
  assert.ok(tm.url.startsWith("https://api.themoviedb.org/3/search/tv?"), "the /3/search/tv endpoint");
  assert.ok(tm.url.includes("query=") && tm.url.includes("Breaking"), "the title is the query");
  assert.match(String(tm.headers && tm.headers.Authorization), /^Bearer fake-tmdb-key$/, "the user key rides as Bearer");
  assert.equal(net.tidbCalls.length, 1, "one TheIntroDB media call");
  const tb = net.tidbCalls[0].url;
  assert.ok(tb.startsWith("https://api.theintrodb.org/v3/media?"), "the /v3/media endpoint");
  assert.ok(tb.includes("tmdb_id=1396"), "the TMDb id from the search result");
  assert.ok(tb.includes("season=1") && tb.includes("episode=1"), "the episode from the filename");

  // the same episode again: a cache is handed in, but every play re-looks-up
  const again = await lookupSegments("fake-tmdb-key", "Breaking Bad S01E01 720p.mkv", undefined, cache);
  assert.deepEqual(again, segs, "identical segments, freshly fetched");
  assert.equal(net.tmdbCalls.length, 2, "a second TMDb search — caching is suspended");
  assert.equal(net.tidbCalls.length, 2, "a second TheIntroDB call — caching is suspended");
});

test("no TMDb key → the TMDb side never runs; the anime side still resolves (it needs no key)", async () => {
  resetNet();
  const segs = await lookupSegments("", "Breaking.Bad.S01E01.720p.mkv");
  assert.deepEqual(segs, [], "an empty segment list when no source answers");
  assert.equal(net.tmdbCalls.length, 0, "no TMDb call");
  assert.equal(net.tidbCalls.length, 0, "no TheIntroDB call");
  assert.equal(net.anilistCalls.length, 1, "…but the keyless anime side ran");
});

test("no TMDb match → TheIntroDB is never called, no segments", async () => {
  resetNet();
  net.tmdb = { results: [] };
  const segs = await lookupSegments("fake-tmdb-key", "Totally Unknown Show S01E01.mkv");
  assert.deepEqual(segs, []);
  assert.equal(net.tmdbCalls.length, 1, "the search happened");
  assert.equal(net.tidbCalls.length, 0, "…but nothing was resolved, so no media call");
});

test("TheIntroDB has no data for the episode → empty list, and the next play asks again (caching suspended)", async () => {
  resetNet();
  net.tmdb = TMDB_ANIME;
  net.tidb = { tmdb_id: 7, type: "tv", season: 1, episode: 1 };
  const cache = mapCache();
  const segs = await lookupSegments("fake-tmdb-key", "Test.Anime.S01E01.mkv", undefined, cache);
  assert.deepEqual(segs, []);
  const again = await lookupSegments("fake-tmdb-key", "Test.Anime.S01E01.mkv", undefined, cache);
  assert.deepEqual(again, []);
  assert.equal(net.tmdbCalls.length, 2, "an empty answer is NOT cached — the next play re-asks");
  assert.equal(net.tidbCalls.length, 2);
});

test("the chain: an anime file with a bare number resolves (the user's Black Clover form)", async () => {
  resetNet();
  net.tmdb = TMDB_BCL;
  net.tidb = TIDB_BCL;
  const segs = await lookupSegments(
    "fake-tmdb-key",
    "[SubsPlease] Black Clover - 171 (1080p) [7AD4AFC7].mkv"
  );
  assert.deepEqual(segs, [{ type: "intro", start: 200, end: 230 }]);
  assert.equal(net.tmdbCalls.length, 1, "one TMDb search");
  assert.ok(
    net.tmdbCalls[0].url.includes("query=Black+Clover"),
    "the group tag and the number are not part of the TMDb query"
  );
  assert.equal(net.tidbCalls.length, 1, "one TheIntroDB call");
  assert.ok(net.tidbCalls[0].url.includes("tmdb_id=73223"), "the TMDb id from the search");
  assert.ok(net.tidbCalls[0].url.includes("episode=171"), "the bare number is the episode");
});

// ---------------- 1b. the MOVIE chain (no episode marker in the name) ----------------
//
// A marker-less name is a movie, not an unresolvable episode: the title is
// parsed by parseMovieName (the same function the Info tab's movie search
// uses), looked up on TMDb's MOVIE search (the query ladder, movieQueryStages),
// and the segments come from TheIntroDB's MOVIE-level media (no season/
// episode in the URL). Same honesty: no key / no match / no data / any
// failure → [] — the feature is off, never a throw, never a wrong skip.
// The ids and segments below are the REAL live data (verified 2026-10-17):
// Migration (de: "Raus aus dem Teich") is tmdb 940551 — TheIntroDB has no
// data for it (a live 404); Spider-Man: No Way Home is tmdb 634649 with
// intro 60–128s and credits 8918–9342s.

const TMDB_MOVIE_MIGRATION = {
  results: [{ id: 940551, title: "Raus aus dem Teich", release_date: "2023-12-06", popularity: 40, imdb_id: "tt9999002" }],
};
const TMDB_MOVIE_SPIDER = {
  results: [{ id: 634649, title: "Spider-Man: No Way Home", release_date: "2021-12-15", popularity: 950, imdb_id: "tt18256836" }],
};
const TIDB_MOVIE_SPIDER = {
  tmdb_id: 634649,
  type: "movie",
  intro: [{ start_ms: 60000, end_ms: 128000 }],
  credits: [{ start_ms: 8918000, end_ms: 9342000 }],
};

test("movie chain (the user's exact file): title-only name → TMDb movie search (no year) → movie-level media; no data (a live 404) → []", async () => {
  resetNet();
  net.tmdb = TMDB_MOVIE_MIGRATION;
  net.tidb = { found: false }; // the real API answers 404 for this film
  const segs = await lookupSegments("fake-tmdb-key", "Raus aus dem Teich.mp4");
  assert.deepEqual(segs, [], "nothing to skip — the film has no community data");
  assert.equal(net.tmdbCalls.length, 1, "one TMDb search");
  const tm = net.tmdbCalls[0];
  assert.ok(
    tm.url.startsWith("https://api.themoviedb.org/3/search/movie?"),
    "the /3/search/movie endpoint — a movie, not a tv show"
  );
  assert.ok(!net.tmdbCalls.some((c) => c.url.includes("/3/search/tv?")), "no TV search for a marker-less name");
  assert.ok(tm.url.includes("query=Raus+aus+dem+Teich"), "the parsed title (no extension, no junk) is the query");
  assert.ok(!tm.url.includes("primary_release_year"), "no year in the name → no year filter");
  assert.match(String(tm.headers && tm.headers.Authorization), /^Bearer fake-tmdb-key$/, "the key rides as Bearer");
  assert.equal(net.tidbCalls.length, 1, "the id resolved → the media was asked for");
  const tb = net.tidbCalls[0].url;
  assert.ok(tb.includes("tmdb_id=940551"), "the id from the movie search");
  assert.ok(!tb.includes("season=") && !tb.includes("episode="), "movie-level media (no season/episode params)");
  assert.equal(net.anilistCalls.length, 0, "a movie name takes no anime chain");
});

test("movie chain with data: a (year) in the name rides as primary_release_year; movie-level media → segments", async () => {
  resetNet();
  net.tmdb = TMDB_MOVIE_SPIDER;
  net.tidb = TIDB_MOVIE_SPIDER;
  const segs = await lookupSegments("fake-tmdb-key", "Spider.Man.No.Way.Home.2021.1080p.BluRay.x264.mkv");
  assert.deepEqual(segs, [
    { type: "intro", start: 60, end: 128 },
    { type: "credits", start: 8918, end: 9342 },
  ]);
  const tm = net.tmdbCalls[0];
  assert.ok(tm.url.startsWith("https://api.themoviedb.org/3/search/movie?"), "the movie endpoint");
  assert.ok(tm.url.includes("query=Spider+Man+No+Way+Home"), "the scene junk is stripped from the query");
  assert.ok(tm.url.includes("primary_release_year=2021"), "the (year) from the name filters the search");
  assert.equal(net.tmdbCalls.length, 1, "the first stage matched — the ladder stops");
  const tb = net.tidbCalls[0].url;
  assert.ok(tb.includes("tmdb_id=634649"), "the id from the movie search");
  assert.ok(!tb.includes("season=") && !tb.includes("episode="), "movie-level media (no season/episode params)");
});

test("movie: TMDb returns results but nothing close → no media call, no segments (a wrong film's timings are worse than none)", async () => {
  resetNet();
  net.tmdb = { results: [{ id: 123, title: "Totally Different Film", release_date: "2019-01-01" }] };
  const segs = await lookupSegments("fake-tmdb-key", "Raus aus dem Teich.mp4");
  assert.deepEqual(segs, []);
  assert.equal(net.tmdbCalls.length, 1, "the search happened");
  assert.equal(net.tidbCalls.length, 0, "…but nothing was resolved, so no media call");
});

test("movie: no TMDb key → zero network on every side (the anime side has no marker to run on either)", async () => {
  resetNet();
  const segs = await lookupSegments("", "Some.Movie.2020.1080p.mkv");
  assert.deepEqual(segs, []);
  assert.equal(net.tmdbCalls.length, 0, "no TMDb call");
  assert.equal(net.tidbCalls.length, 0, "no TheIntroDB call");
  assert.equal(net.anilistCalls.length, 0, "no episode marker → no anime chain either");
});

test("movie: an episode marker still wins — the TV chain runs, never the movie search", async () => {
  resetNet();
  net.tmdb = TMDB_BBD;
  net.tidb = TIDB_BBD;
  const segs = await lookupSegments("fake-tmdb-key", "Breaking.Bad.S01E01.720p.mkv");
  assert.deepEqual(segs, [
    { type: "intro", start: 228.664, end: 246.143 },
    { type: "credits", start: 3431, end: null },
  ]);
  assert.ok(!net.tmdbCalls.some((c) => c.url.includes("/3/search/movie?")), "no movie search for an SxxEyy name");
});

// ---------------- 1c. the anime sources: AniList (title → MAL id), AniSkip ----------------
//
// TheIntroDB's anime coverage is thin; the anime community's data lives
// elsewhere. AniList (free GraphQL, no key) resolves the title → MAL id;
// AniSkip (open API, no auth) carries the community-measured op/ed/recap
// intervals for that MAL id + episode. Both run LIVE so new series are
// covered as they air — a static DB lags by design.

test("anilistSearchAnime: a Page.media list parses into shows with MAL ids", async () => {
  resetNet();
  net.anilist = ANILIST_BCL;
  const shows = await anilistSearchAnime("Black Clover");
  assert.equal(shows.length, 2);
  assert.deepEqual(shows[0], {
    id: 97940, // the internal id — the Media(id:) query's key
    malId: 34572, // the MAL id — AniSkip's key
    imdbId: "tt7441658", // the IMDb id — introdb.app's key
    title: "Black Clover",
    year: 2017,
    score: 72,
  });
  assert.ok(net.anilistCalls[0].url.startsWith("https://graphql.anilist.co"), "the GraphQL endpoint");
  assert.ok(JSON.parse(net.anilistCalls[0].body).query.includes("Media") ||
            JSON.parse(net.anilistCalls[0].body).query.includes("media"),
    "a search query");
  assert.ok(String(net.anilistCalls[0].body).includes("Black Clover"), "the title is the search term");
});

test("anilistSearchAnime: an entry without a numeric internal id is skipped (the Media query needs it)", async () => {
  resetNet();
  net.anilist = {
    data: {
      Page: {
        media: [
          { idMal: 34572, title: { romaji: "No Internal Id" }, averageScore: 72 },
          { id: null, title: { romaji: "Null Internal Id" }, averageScore: 70 },
          { id: 97940, idMal: 34572, title: { romaji: "Black Clover" }, averageScore: 72, startDate: { year: 2017 } },
        ],
      },
    },
  };
  const shows = await anilistSearchAnime("Black Clover");
  assert.equal(shows.length, 1, "only the well-formed entry survives");
  assert.equal(shows[0].id, 97940);
});

test("anilistSearchAnime: no match, GraphQL errors and network failures degrade to [] — never a throw", async () => {
  resetNet();
  net.anilist = { data: { Page: { media: null } } };
  assert.deepEqual(await anilistSearchAnime("NoSuchAnime"), [], "a null media list");
  net.anilist = { errors: [{ message: "boom" }] };
  assert.deepEqual(await anilistSearchAnime("NoSuchAnime"), [], "GraphQL errors");
  net.anilist = null;
  assert.deepEqual(
    await anilistSearchAnime("NoSuchAnime", undefined, () => Promise.reject(new Error("net down"))),
    [],
    "a network failure"
  );
});

test("pickAnilistMatch: exact title wins; within the candidates, year then score decide (same rules as pickTmdbMatch)", () => {
  const shows = [
    { malId: 34572, title: "Black Clover", year: 2017, score: 72 },
    { malId: 43317, title: "Squishy! Black Clover", year: 2019, score: 40 },
  ];
  assert.equal(pickAnilistMatch(shows, "Black Clover").malId, 34572, "the exact match wins outright");
  assert.equal(pickAnilistMatch(shows, "Black Clover", 2017).malId, 34572, "an exact match keeps its year");
  // no exact match: two near candidates, the (year) tag decides
  const near = [
    { malId: 34572, title: "Black Clover Chronicles", year: 2017, score: 72 },
    { malId: 43317, title: "Black Clover Chronicles", year: 2019, score: 40 },
  ];
  assert.equal(pickAnilistMatch(near, "Black Clover Chronicles").malId, 34572, "no year: the higher score");
  assert.equal(pickAnilistMatch(near, "Black Clover Chronicles", 2019).malId, 43317, "a year decides among near matches");
  assert.equal(pickAnilistMatch([], "Anything"), null, "no results, no match");
  assert.equal(pickAnilistMatch(shows, "Totally Different"), null, "no match among the results");
});

test("pickAnilistMatch: normalized-exact ties settle on the RAW title; a year with no match abstains (same rules as pickTmdbMatch)", () => {
  // normTitle strips .°' — the Gintama family all normalizes to "gintama",
  // so score-picking picks the wrong series (corpus: 72× across dev+holdout)
  const shows = [
    { malId: 28977, title: "Gintama°", year: 2015, score: 85 },
    { malId: 34096, title: "Gintama.", year: 2006, score: 84 },
    { malId: 55719, title: "Gintama'", year: 2024, score: 80 },
  ];
  assert.equal(pickAnilistMatch(shows, "Gintama.").malId, 34096, "file 'Gintama.' → the '.' entry, even though the ° entry scores higher");
  assert.equal(pickAnilistMatch(shows, "Gintama'").malId, 55719, "file 'Gintama'' → the 2024 entry");
  assert.equal(pickAnilistMatch(shows, "GINTAMA°").malId, 28977, "the raw tie is case-insensitive");
  const blue = [
    { malId: 97616, title: "Grand Blue", year: 2014, score: 80 },
    { malId: 38003, title: "Grand Blue", year: 2018, score: 85 },
  ];
  assert.equal(pickAnilistMatch(blue, "Grand Blue", 2018).malId, 38003, "the matching year decides");
  assert.equal(pickAnilistMatch(blue, "Grand Blue", 2016), null, "no candidate airs in 2016 → abstain, don't guess");
});

test("aniskipSegments: op/ed/recap map onto the app's types (the ED runs to the end)", async () => {
  resetNet();
  net.aniskip = ANISKIP_BCL;
  const segs = await aniskipSegments(34572, 171);
  assert.deepEqual(segs, [
    { type: "intro", start: 105, end: 205 },
    { type: "credits", start: 2400, end: null },
  ], "op → intro, ed → credits with end=null (the end-time is length-derived; our credits action ends the episode)");
  const url = net.aniskipCalls[0].url;
  assert.ok(url.startsWith("https://api.aniskip.com/v2/skip-times/34572/171"), "MAL id + episode in the path");
  assert.ok(url.includes("types=op") && url.includes("types=ed") && url.includes("types=recap"), "the type filter");
  assert.ok(url.includes("episodeLength="), "the required episodeLength parameter");
});

test("aniskipSegments: no data, a 404 and garbage all answer []", async () => {
  resetNet();
  net.aniskip = { found: false, results: [], message: "No skip times found" };
  assert.deepEqual(await aniskipSegments(34572, 171), [], "the 404 not-found");
  net.aniskip = {
    found: true,
    results: [
      { interval: { startTime: "soon", endTime: null }, skipType: "op" },
      { skipType: "ed" },
    ],
  };
  assert.deepEqual(await aniskipSegments(34572, 171), [], "garbage intervals are dropped");
  net.aniskip = null;
  assert.deepEqual(
    await aniskipSegments(34572, 171, () => Promise.reject(new Error("net down"))),
    [],
    "a network failure (never a throw)"
  );
});

test("aniskipSegmentsV1: the legacy DB's snake_case shape maps onto the app's types (ed → credits to the end)", async () => {
  resetNet();
  net.aniskip1 = ANISKIP1_BCL;
  const segs = await aniskipSegmentsV1(34572, 170);
  assert.deepEqual(segs, [
    { type: "intro", start: 8.44, end: 98.44 },
    { type: "credits", start: 1280.999, end: null },
  ], "op → intro, ed → credits with end=null");
  const url = net.aniskip1Calls[0].url;
  assert.ok(url.startsWith("https://api.aniskip.com/v1/skip-times/34572/170"), "the v1 endpoint, MAL id + episode");
  assert.ok(url.includes("types=op") && url.includes("types=ed"), "the type filter (the proven CLI call)");
  assert.ok(!url.includes("episodeLength"), "v1 takes no episodeLength");
});

test("aniskipSegmentsV1: 404, garbage and network failures answer []", async () => {
  resetNet();
  net.aniskip1 = { found: false, results: [], message: "No skip times found" };
  assert.deepEqual(await aniskipSegmentsV1(34572, 171), [], "the 404 not-found");
  net.aniskip1 = { found: true, results: [{ interval: { start_time: null }, skip_type: "op" }] };
  assert.deepEqual(await aniskipSegmentsV1(34572, 171), [], "garbage intervals are dropped");
  net.aniskip1 = null;
  assert.deepEqual(
    await aniskipSegmentsV1(34572, 171, () => Promise.reject(new Error("net down"))),
    [],
    "a network failure (never a throw)"
  );
});

test("the chain: v2 misses, the legacy v1 DB has the data → it fills in (Black Clover is covered only by v1)", async () => {
  resetNet();
  net.tmdb = TMDB_BCL;
  net.tidb = { error: "media not found" };
  net.anilist = ANILIST_BCL;
  net.aniskip = null; // v2: no Black Clover data
  net.aniskip1 = ANISKIP1_BCL; // v1: the full series
  const segs = await lookupSegments(
    "fake-tmdb-key",
    "[SubsPlease] Black Clover - 170 (1080p) [7AD4AFC7].mkv"
  );
  assert.deepEqual(segs, [
    { type: "intro", start: 8.44, end: 98.44 },
    { type: "credits", start: 1280.999, end: null },
  ], "the legacy DB covers the episode v2 lacks");
  assert.equal(net.aniskip1Calls.length, 1, "the v1 lookup ran");
  assert.ok(net.aniskip1Calls[0].url.includes("/34572/170"), "the MAL id, the episode from the name");
});

test("the chain: both AniSkip versions report → v2 wins per section, v1 fills the gaps", async () => {
  resetNet();
  net.tmdb = TMDB_BCL;
  net.tidb = { error: "media not found" };
  net.anilist = ANILIST_BCL;
  net.aniskip = {
    found: true,
    results: [{ interval: { startTime: 105, endTime: 205 }, skipType: "op" }], // v2: intro only
  };
  net.aniskip1 = ANISKIP1_BCL; // v1: intro (older) + ed
  const segs = await lookupSegments(
    "fake-tmdb-key",
    "[SubsPlease] Black Clover - 170 (1080p) [7AD4AFC7].mkv"
  );
  assert.deepEqual(segs, [
    { type: "intro", start: 105, end: 205 }, // v2's intro wins over v1's 8.44–98.44
    { type: "credits", start: 1280.999, end: null }, // the credits only v1 carries
  ], "current data wins; the legacy DB only fills what v2 lacks");
});

test("mergeSegments: TheIntroDB wins per type, AniSkip fills the gaps, sorted by start", () => {
  const tidb = [
    { type: "intro", start: 228.664, end: 246.143 },
    { type: "credits", start: 3431, end: null },
  ];
  const aniskip = [
    { type: "recap", start: 30, end: 60 },
    { type: "credits", start: 3400, end: null },
    { type: "intro", start: 100, end: 200 },
  ];
  assert.deepEqual(mergeSegments(tidb, aniskip), [
    { type: "recap", start: 30, end: 60 },
    { type: "intro", start: 228.664, end: 246.143 },
    { type: "credits", start: 3431, end: null },
  ], "intro+credits from TheIntroDB, the recap filled in by AniSkip");
  assert.deepEqual(mergeSegments([], []), [], "nothing + nothing = nothing");
  assert.deepEqual(mergeSegments([], aniskip), [
    { type: "recap", start: 30, end: 60 },
    { type: "intro", start: 100, end: 200 },
    { type: "credits", start: 3400, end: null },
  ], "a TIDB-miss falls back to the anime source whole");
});

test("the chain: a TIDB-miss anime falls back to AniList → AniSkip (the user's Black Clover reality)", async () => {
  resetNet();
  net.tmdb = TMDB_BCL;
  net.tidb = { error: "media not found" }; // TheIntroDB has no Black Clover
  net.anilist = ANILIST_BCL;
  net.aniskip = ANISKIP_BCL;
  const cache = mapCache();
  const segs = await lookupSegments(
    "fake-tmdb-key",
    "[SubsPlease] Black Clover - 171 (1080p) [7AD4AFC7].mkv",
    undefined,
    cache
  );
  assert.deepEqual(segs, [
    { type: "intro", start: 105, end: 205 },
    { type: "credits", start: 2400, end: null },
  ], "the anime source fills the TIDB hole");
  assert.equal(net.anilistCalls.length, 1, "one AniList search");
  assert.ok(String(net.anilistCalls[0].body).includes("Black Clover"), "the title is the search term");
  assert.equal(net.aniskipCalls.length, 1, "one AniSkip call");
  assert.ok(net.aniskipCalls[0].url.includes("/34572/171"), "the MAL id from the search, the episode from the name");

  // re-play: a cache is handed in, but every play re-looks-up both sources
  const again = await lookupSegments("fake-tmdb-key", "[SubsPlease] Black Clover - 171 (1080p) [7AD4AFC7].mkv", undefined, cache);
  assert.deepEqual(again, segs);
  assert.equal(net.anilistCalls.length, 2, "a second AniList search — caching is suspended");
  assert.equal(net.aniskipCalls.length, 2, "a second AniSkip call — caching is suspended");
});

test("the chain: a movie whose tail is a broken codec ('H 264') is NOT an episode — the movie chain runs instead", async () => {
  resetNet();
  const segs = await lookupSegments(
    "fake-tmdb-key",
    "Kindergarten Cop 1990 1080p AMZN WEB-DL DDP2 0 H 264-GPRS.mkv"
  );
  assert.deepEqual(segs, []);
  assert.ok(
    net.tmdbCalls.length >= 1 &&
      net.tmdbCalls.every((c) => c.url.includes("/3/search/movie?")),
    "only TMDb MOVIE searches ran (no TV search — it is not an episode)"
  );
  assert.equal(net.anilistCalls.length, 0, "no anime chain");
  assert.equal(net.aniskipCalls.length + net.aniskip1Calls.length, 0, "no AniSkip");
  assert.ok(
    net.tmdbCalls[0].url.includes("query=Kindergarten+Cop+1990"),
    "the codec junk ('H 264-GPRS') and the scene tags are stripped from the query"
  );
  assert.ok(
    net.tmdbCalls.some((c) => c.url.includes("primary_release_year=1990")),
    "the ladder re-tries with the space year as the year param"
  );
});

test("the chain: both sources report → merged with TheIntroDB winning per section", async () => {
  resetNet();
  net.tmdb = TMDB_BBD;
  net.tidb = TIDB_BBD; // intro + credits
  net.anilist = {
    data: {
      Page: {
        media: [
          { id: 1361, idMal: 1360, idImdb: "tt0903747", title: { romaji: "Breaking Bad", english: "Breaking Bad" }, averageScore: 90, startDate: { year: 2008 } },
        ],
      },
    },
  };
  net.aniskip = {
    found: true,
    results: [
      { interval: { startTime: 30, endTime: 60 }, skipType: "recap" },
      { interval: { startTime: 3400, endTime: 3450 }, skipType: "ed" },
    ],
  };
  const segs = await lookupSegments("fake-tmdb-key", "Breaking.Bad.S01E01.720p.mkv");
  assert.deepEqual(segs, [
    { type: "recap", start: 30, end: 60 },
    { type: "intro", start: 228.664, end: 246.143 },
    { type: "credits", start: 3431, end: null },
  ], "TheIntroDB's intro and credits win; only the recap comes from AniSkip");
});

test("the chain: a season-2 file never queries the anime sources (MAL ids have no season)", async () => {
  resetNet();
  net.tmdb = { results: [] };
  net.anilist = ANILIST_BCL; // would answer, if asked
  const segs = await lookupSegments("fake-tmdb-key", "Some.Show.S02E01.mkv");
  assert.deepEqual(segs, []);
  assert.equal(net.anilistCalls.length, 0, "no AniList search for S>1");
  assert.equal(net.aniskipCalls.length, 0, "no AniSkip v2 call for S>1");
  assert.equal(net.aniskip1Calls.length, 0, "no AniSkip v1 call for S>1");
  assert.equal(net.idbaCalls.length, 0, "no identity → no IMDb id → no introdb.app call");
});

/* ================= the consensus source: introdb.app (IMDb-keyed) + fusion =================

   introdb.app (api.introdb.app/segments?imdb_id=…) is the corpus's strongest
   single source (measured: 93–100% of the consensus labels, where the app's
   two-source chain reaches ~46–49%). It keys on the IMDb id, which arrives
   from either search (TMDb's imdb_id, else AniList's idImdb) — so it works
   even without a TMDb key. Its data fuses with the existing sources:
   within-window agreement collapses to ONE window (the higher-priority
   source's values), disagreement keeps the consensus cluster, and a lone
   source's own entries pass through unsquashed. */

test("the chain: TheIntroDB misses the episode but introdb.app has it → the segment lands", async () => {
  resetNet();
  net.tmdb = TMDB_BBD;
  net.tidb = { found: false }; // 404 — no TheIntroDB data for this episode
  net.idba = { intro: { start_sec: 120, end_sec: 200 }, recap: null, outro: null, post_credits: null };
  const segs = await lookupSegments("fake-tmdb-key", "Breaking.Bad.S01E01.720p.mkv");
  assert.deepEqual(segs, [{ type: "intro", start: 120, end: 200 }]);
  assert.equal(net.idbaCalls.length, 1);
  assert.equal(
    net.idbaCalls[0].url,
    "https://api.introdb.app/segments?imdb_id=tt0903747&season=1&episode=1",
    "the TMDb identity's IMDb id, TV shape (season + episode)"
  );
});

test("the chain: no TMDb key — introdb.app still resolves via the AniList IMDb id", async () => {
  resetNet();
  net.anilist = ANILIST_BCL;
  net.aniskip = { found: false };
  net.aniskip1 = { found: false };
  net.idba = { intro: null, recap: null, outro: { start_sec: 1347.137, end_sec: 1437.561 }, post_credits: null };
  const segs = await lookupSegments("", "[SubsPlease] Black Clover - 171 (1080p) [7AD4AFC7].mkv");
  assert.deepEqual(segs, [{ type: "credits", start: 1347.137, end: 1437.561 }], "outro maps to credits");
  assert.equal(net.tmdbCalls.length, 0, "no key → no TMDb search");
  assert.equal(net.idbaCalls.length, 1, "the anime-side identity (AniList's idImdb) feeds introdb.app");
  assert.equal(
    net.idbaCalls[0].url,
    "https://api.introdb.app/segments?imdb_id=tt7441658&season=1&episode=171"
  );
});

test("the chain: three sources agree within the window → ONE window, the top-priority source's values", async () => {
  resetNet();
  net.tmdb = TMDB_BCL;
  net.tidb = TIDB_BCL; // intro 200–230
  net.anilist = ANILIST_BCL;
  net.aniskip = { found: true, results: [{ interval: { startTime: 201, endTime: 229 }, skipType: "op" }] };
  net.aniskip1 = { found: false };
  net.idba = { intro: { start_sec: 202, end_sec: 228 }, recap: null, outro: null, post_credits: null };
  const segs = await lookupSegments("fake-tmdb-key", "[SubsPlease] Black Clover - 171 (1080p) [7AD4AFC7].mkv");
  assert.deepEqual(segs, [{ type: "intro", start: 200, end: 230 }], "agreement → one window, TheIntroDB's values");
  assert.equal(net.idbaCalls.length, 1, "exactly one introdb.app call (the TMDb identity's id); the anime side does not refetch");
});

test("the chain: sources disagree past the window → the consensus cluster wins, one window per type", async () => {
  resetNet();
  net.tmdb = TMDB_BBD;
  net.tidb = { intro: [{ start_ms: 120000, end_ms: 200000 }], credits: [] };
  net.anilist = {
    data: { Page: { media: [{ id: 1361, idMal: 1360, idImdb: "tt0903747", title: { romaji: "Breaking Bad", english: "Breaking Bad" }, averageScore: 90, startDate: { year: 2008 } }] } },
  };
  net.aniskip = { found: true, results: [{ interval: { startTime: 405, endTime: 510 }, skipType: "op" }] };
  net.aniskip1 = { found: false };
  net.idba = { intro: { start_sec: 400, end_sec: 500 }, recap: null, outro: null, post_credits: null };
  const segs = await lookupSegments("fake-tmdb-key", "Breaking.Bad.S01E01.720p.mkv");
  assert.deepEqual(
    segs,
    [{ type: "intro", start: 405, end: 510 }],
    "the 2-member cluster {400, 405} beats TheIntroDB's lone 120; the representative is AniSkip's (higher priority than introdb.app)"
  );
});

test("the chain: a single source's own multiple entries of one type pass through unsquashed", async () => {
  resetNet();
  net.tmdb = TMDB_ANIME;
  net.tidb = { intro: [], recap: [{ start_ms: 300000, end_ms: 330000 }, { start_ms: 2400000, end_ms: 2450000 }], credits: [] };
  const segs = await lookupSegments("fake-tmdb-key", "Test.Anime.S01E05.mkv");
  assert.deepEqual(
    segs,
    [
      { type: "recap", start: 300, end: 330 },
      { type: "recap", start: 2400, end: 2450 },
    ],
    "only TheIntroDB timed recaps → both entries survive (the only source with that information)"
  );
});

test("the chain: a search result without an IMDb id → introdb.app is never called", async () => {
  resetNet();
  net.tmdb = { results: [{ id: 12345, name: "No Imdb Show", first_air_date: "2019-04-02", popularity: 3 }] };
  net.tidb = { intro: [{ start_ms: 120000, end_ms: 200000 }], credits: [] };
  const segs = await lookupSegments("fake-tmdb-key", "No.Imdb.Show.S01E03.mkv");
  assert.deepEqual(segs, [{ type: "intro", start: 120, end: 200 }]);
  assert.equal(net.idbaCalls.length, 0, "no IMDb id on either search result → no introdb.app request");
});

test("the movie chain: introdb.app's movie call (is_movie=true, no season/episode)", async () => {
  resetNet();
  net.tmdb = TMDB_MOVIE_SPIDER;
  net.tidb = TIDB_MOVIE_SPIDER; // intro 60–128, credits 8918–9342
  net.idba = { intro: { start_sec: 61, end_sec: 127 }, recap: null, outro: { start_sec: 8919, end_sec: 9341 }, post_credits: null };
  const segs = await lookupSegments("fake-tmdb-key", "Spider.Man.No.Way.Home.2021.1080p.BluRay.x264.mkv");
  assert.deepEqual(
    segs,
    [
      { type: "intro", start: 60, end: 128 },
      { type: "credits", start: 8918, end: 9342 },
    ],
    "agreement → TheIntroDB's values win per type"
  );
  assert.equal(net.idbaCalls.length, 1);
  assert.equal(
    net.idbaCalls[0].url,
    "https://api.introdb.app/segments?imdb_id=tt18256836&is_movie=true",
    "movie shape: is_movie=true, no season=/episode= parameters"
  );
});

/* ---------------- the fusion itself (pure) ---------------- */

test("fuseSegments: a single reporting source passes through unchanged", () => {
  assert.deepEqual(
    fuseSegments([
      { source: "theintrodb", segs: [{ type: "intro", start: 30, end: 120 }] },
      { source: "aniskip", segs: [] },
      { source: "introdb_app", segs: [] },
    ]),
    [{ type: "intro", start: 30, end: 120 }]
  );
});

test("fuseSegments: within-window agreement across sources collapses to one window (top-priority values)", () => {
  assert.deepEqual(
    fuseSegments([
      { source: "theintrodb", segs: [{ type: "intro", start: 200, end: 230 }] },
      { source: "aniskip", segs: [{ type: "intro", start: 201, end: 229 }, { type: "credits", start: 3400, end: 3450 }] },
      { source: "introdb_app", segs: [{ type: "intro", start: 202, end: 228 }, { type: "credits", start: 3405, end: 3460 }] },
    ]),
    [
      { type: "intro", start: 200, end: 230 }, // TheIntroDB's — highest priority
      { type: "credits", start: 3400, end: 3450 }, // AniSkip's — beats introdb.app
    ]
  );
});

test("fuseSegments: a multi-member consensus cluster beats a singleton, even from the top-priority source", () => {
  assert.deepEqual(
    fuseSegments([
      { source: "theintrodb", segs: [{ type: "intro", start: 120, end: 200 }] },
      { source: "aniskip", segs: [{ type: "intro", start: 405, end: 510 }] },
      { source: "introdb_app", segs: [{ type: "intro", start: 400, end: 500 }] },
    ]),
    [{ type: "intro", start: 405, end: 510 }],
    "the 2-member cluster {400, 405} wins over the lone 120; its representative = AniSkip (priority over introdb.app)"
  );
});

test("fuseSegments: all singletons disagreeing → the higher-priority source's window wins", () => {
  assert.deepEqual(
    fuseSegments([
      { source: "theintrodb", segs: [{ type: "intro", start: 120, end: 200 }] },
      { source: "aniskip", segs: [] },
      { source: "introdb_app", segs: [{ type: "intro", start: 400, end: 500 }] },
    ]),
    [{ type: "intro", start: 120, end: 200 }],
    "a tie on cluster size resolves to the cluster holding the better-priority source"
  );
});

test("fuseSegments: no segments anywhere → []", () => {
  assert.deepEqual(
    fuseSegments([{ source: "theintrodb", segs: [] }, { source: "aniskip", segs: [] }, { source: "introdb_app", segs: [] }]),
    []
  );
});

test("parseIntrodbAppSegments: intro/recap/outro map to intro/recap/credits; post_credits is dropped", () => {
  // the live FMA S1E4 shape (api.introdb.app, fetched 2026-10-18)
  const segs = parseIntrodbAppSegments({
    imdb_id: "tt1355642",
    intro: { start_sec: 30, end_sec: 120, start_ms: 30000, end_ms: 120000, confidence: 0.9, submission_count: 5 },
    recap: { start_sec: 120, end_sec: 153, start_ms: 120000, end_ms: 153000, confidence: 0.8, submission_count: 3 },
    outro: { start_sec: 1347.137, end_sec: 1437.561, start_ms: 1347137, end_ms: 1437561, confidence: 0.7, submission_count: 2 },
    post_credits: { start_sec: 1440, end_sec: 1460, start_ms: 1440000, end_ms: 1460000, confidence: 0.5, submission_count: 1 },
    no_intro: false, no_recap: false, no_outro: false,
  });
  assert.deepEqual(segs, [
    { type: "intro", start: 30, end: 120 },
    { type: "recap", start: 120, end: 153 },
    { type: "credits", start: 1347.137, end: 1437.561 },
  ]);
});

test("parseIntrodbAppSegments: an all-null body (\"not timed yet\") and garbage map to nothing", () => {
  assert.deepEqual(
    parseIntrodbAppSegments({ intro: null, recap: null, outro: null, post_credits: null, no_intro: true, no_recap: true, no_outro: true }),
    []
  );
  assert.deepEqual(
    parseIntrodbAppSegments({ intro: { start_sec: "soon", end_sec: 100 }, recap: null, outro: { start_sec: 100, end_sec: 10 } }),
    [], "non-numeric start and end-before-start are dropped"
  );
});

test("parseIntrodbAppSegments: end_sec null = the segment runs to the end of the media", () => {
  assert.deepEqual(
    parseIntrodbAppSegments({ intro: null, recap: null, outro: { start_sec: 1300, end_sec: null } }),
    [{ type: "credits", start: 1300, end: null }]
  );
});

test("the chain: no TMDb key still resolves anime via AniList/AniSkip", async () => {
  resetNet();
  net.anilist = ANILIST_BCL;
  net.aniskip = ANISKIP_BCL;
  const segs = await lookupSegments(
    "",
    "[SubsPlease] Black Clover - 171 (1080p) [7AD4AFC7].mkv"
  );
  assert.deepEqual(segs, [
    { type: "intro", start: 105, end: 205 },
    { type: "credits", start: 2400, end: null },
  ], "the anime sources need no key");
  assert.equal(net.tmdbCalls.length, 0, "…but the TMDb side stays gated on the key");
  assert.equal(net.anilistCalls.length, 1);
  assert.equal(net.aniskipCalls.length, 1, "both AniSkip versions are queried");
  assert.equal(net.aniskip1Calls.length, 1, "…including the legacy DB");
});

// ---------------- 1b. the pure parts: TheIntroDB parsing, TMDb matching ----------------

test("parseSegments: ms → seconds, null start = 0, null end = to the end of media", () => {
  assert.deepEqual(parseSegments(TIDB_BBD), [
    { type: "intro", start: 228.664, end: 246.143 },
    { type: "credits", start: 3431, end: null },
  ]);
  assert.deepEqual(
    parseSegments({ intro: [{ start_ms: null, end_ms: 90000 }] }),
    [{ type: "intro", start: 0, end: 90 }],
    "a null start is the beginning"
  );
});

test("parseSegments: multiple entries of one type are all kept, ordered by start", () => {
  assert.deepEqual(
    parseSegments({
      recap: [{ start_ms: 120000, end_ms: 180000 }, { start_ms: 0, end_ms: 60000 }],
    }),
    [
      { type: "recap", start: 0, end: 60 },
      { type: "recap", start: 120, end: 180 },
    ],
    "some episodes have more than one recap — all of them matter"
  );
});

test("parseSegments: 'preview' (next-episode teaser) is out of scope and ignored", () => {
  assert.deepEqual(
    parseSegments({ preview: [{ start_ms: 0, end_ms: 60000 }], intro: [{ start_ms: 0, end_ms: 90000 }] }),
    [{ type: "intro", start: 0, end: 90 }],
    "only intro / recap / credits drive the feature"
  );
});

test("parseSegments: garbage in, empty list out (never a throw, never a fake segment)", () => {
  assert.deepEqual(parseSegments(null), []);
  assert.deepEqual(parseSegments("nope"), []);
  assert.deepEqual(parseSegments({ intro: [{ start_ms: 90000, end_ms: 1000 }] }), [], "end before start");
  assert.deepEqual(parseSegments({ intro: [{ start_ms: -5, end_ms: 1000 }] }), [], "negative");
  assert.deepEqual(parseSegments({ intro: [{ start_ms: "soon", end_ms: 1000 }] }), [], "not a number");
});

test("pickTmdbMatch: the normalized exact name wins, whatever the case or punctuation", () => {
  const results = TMDB_BBD.results;
  assert.equal(pickTmdbMatch(results, "breaking bad").id, 1396);
  assert.equal(pickTmdbMatch(results, "BREAKING  BAD!").id, 1396);
});

test("pickTmdbMatch: no exact name → the most popular near name (the query is inside it)", () => {
  const results = [{ id: 42, name: "Breaking Bad Season 2", first_air_date: "2015-01-01", popularity: 50 }];
  assert.equal(pickTmdbMatch(results, "Breaking Bad").id, 42);
});

test("pickTmdbMatch: a year tag decides between near names", () => {
  const results = [
    { id: 1, name: "Test Show", first_air_date: "2015-01-01", popularity: 90 },
    { id: 2, name: "Test Show", first_air_date: "2021-01-01", popularity: 10 },
  ];
  assert.equal(pickTmdbMatch(results, "Test Show", 2021).id, 2, "the year, not the popularity");
  assert.equal(pickTmdbMatch(results, "Test Show").id, 1, "no year → popularity decides");
});

test("pickTmdbMatch: nothing close is no match (the feature stays off, not wrong)", () => {
  assert.equal(pickTmdbMatch([{ id: 1, name: "Totally Different", popularity: 99 }], "Breaking Bad"), null);
  assert.equal(pickTmdbMatch([], "Breaking Bad"), null, "empty results");
});

test("pickTmdbMatch: normalized-exact ties settle on the RAW title (Gintama. ≠ Gintama°)", () => {
  // normTitle strips .°' — all three normalize to "gintama"; score-picking
  // then names the wrong series (corpus: the top confusion class)
  const results = [
    { id: 1, name: "Gintama°", first_air_date: "2015-04-09", popularity: 90 },
    { id: 2, name: "Gintama.", first_air_date: "2006-04-04", popularity: 80 },
    { id: 3, name: "Gintama", first_air_date: "2024-01-06", popularity: 70 },
  ];
  assert.equal(pickTmdbMatch(results, "Gintama.").id, 2, "file 'Gintama.' → the entry that literally says 'Gintama.'");
  assert.equal(pickTmdbMatch(results, "Gintama°").id, 1, "file 'Gintama°' → the ° entry");
  assert.equal(pickTmdbMatch(results, "GINTAMA°").id, 1, "case-insensitive on the raw tie");
  assert.equal(pickTmdbMatch(results, "Gintama").id, 3, "file 'Gintama' → the bare entry");
});

test("pickTmdbMatch: a year tag with no matching candidate → no match (abstain, don't guess)", () => {
  const results = [
    { id: 1, name: "Grand Blue", first_air_date: "2014-01-10", popularity: 90 },
    { id: 2, name: "Grand Blue", first_air_date: "2018-07-12", popularity: 80 },
  ];
  assert.equal(pickTmdbMatch(results, "Grand Blue", 2014).id, 1, "the matching year decides");
  assert.equal(pickTmdbMatch(results, "Grand Blue", 2016), null, "nothing airs in 2016 → the (2016) tag is not this show");
});

// ---------------- 2. the engine (real MediaEngine, fake <video>) ----------------

test("a fresh start lands past the leading intro+recap block and reports it once", async () => {
  const { el, engine, patches } = makeEngine({ id: 1, start_from: 0 });
  engine.setSegments(SEGS_ANIME);
  meta(el, 3600);
  await tick();
  assert.equal(el.currentTime, 150, "the playhead is past intro + recap");
  const skipped = patches.filter((p) => p.skippedSeg);
  assert.equal(skipped.length, 1, "the skip is reported exactly once");
  assert.match(skipped[0].skippedSeg, /intro/, "…and it names the intro");
  engine.destroy();
});

test("a short file is NOT skipped past its content", async () => {
  const { el, engine, patches } = makeEngine({ id: 1, start_from: 0 });
  engine.setSegments(SEGS_ANIME);
  meta(el, 100);
  await tick();
  assert.equal(el.currentTime, 0, "it plays from the start");
  assert.equal(patches.filter((p) => p.skippedSeg).length, 0, "…and reports nothing");
  engine.destroy();
});

test("a saved position WINS over the skip (a resume is never yanked)", async () => {
  const { el, engine, patches } = makeEngine({ id: 1, start_from: 300 });
  engine.setSegments(SEGS_ANIME);
  meta(el, 3600);
  await tick();
  assert.equal(el.currentTime, 295, "the resume target (from - lead), not the skip");
  assert.equal(patches.filter((p) => p.skippedSeg).length, 0, "no skip is reported");
  engine.destroy();
});

test("a seek to 0 (scrubbing back to the start) is honored as-is — the intro plays again", async () => {
  // L1: "start from beginning" is now a plain seek to 0 on the scrubber,
  // not a content-start re-derivation (the prompt and its applyInitialSeek
  // path are gone). The user re-enters the intro window — the skip pill
  // offers to skip it; the engine must NOT re-derive a fresh-start target
  // on a mid-file seek.
  const { el, engine, patches } = makeEngine({ id: 1, start_from: 300 });
  engine.setSegments(SEGS_ANIME);
  meta(el, 3600);
  await tick();
  assert.equal(el.currentTime, 295, "opened at the saved position (from - lead)");
  el.currentTime = 0; // the scrubber's seek to 0
  await tick();
  assert.equal(el.currentTime, 0, "the 0-land is honored as-is (no freshTarget re-derivation)");
  assert.equal(
    patches.filter((p) => p.skippedSeg).length,
    0,
    "no late fresh-skip fires on a mid-file seek"
  );
  engine.destroy();
});

test("segment data that arrives AFTER the metadata still applies the fresh skip", async () => {
  // the lookup is async: the metadata lands first (segs = none, no skip),
  // then TheIntroDB answers while the playhead is still near the top.
  const { el, engine, patches } = makeEngine({ id: 1, start_from: 0 });
  meta(el, 3600);
  await tick();
  assert.equal(el.currentTime, 0, "no data yet → an ordinary start");
  el.currentTime = 3; // a few seconds of drift
  engine.setSegments(SEGS_ANIME);
  await tick();
  assert.equal(el.currentTime, 150, "the late data still lands the fresh skip");
  assert.equal(patches.filter((p) => p.skippedSeg).length, 1, "…and reports it");
  engine.destroy();
});

test("a finished / credits-skipped video saves NO resume position", async () => {
  const control = makeEngine({ id: 2, start_from: 0 });
  meta(control.el, 3600);
  await tick(60);
  control.el.currentTime = 600;
  control.engine.destroy(); // a normal exit saves the position
  const controlPosts = savePosts().length;
  assert.ok(controlPosts >= 1, "a normal finish saves a position");

  net.putio.length = 0;
  const { el, engine } = makeEngine({ id: 3, start_from: 0 });
  meta(el, 3600);
  await tick();
  el.currentTime = 3431; // the credits begin
  engine.finish(); // the credits were skipped — the episode is DONE
  await tick(60);
  engine.destroy();
  assert.equal(savePosts().length, 0, "no position is saved after a skip to the end");
});

// ---------------- 3. the wiring ----------------

async function compileScreen(rel) {
  const file = join(root, rel);
  const source = readFileSync(file, "utf8");
  const processed = await preprocess(source, sveltePreprocess(), { filename: file });
  const { js } = compile(processed.code, { generate: "dom", filename: file, css: "injected" });
  return { source, js: js.code };
}

test("the Player runs the lookup and owns the per-segment action", async () => {
  const { source } = await compileScreen("src/ui/screens/Player.svelte"); // must compile
  assert.match(
    source,
    /import\s*\{[^}]*\blookupSegments\b[^}]*\}\s*from\s*"[^"]*seglookup"/,
    "the Player resolves the segments for the loaded file"
  );
  assert.match(
    source,
    /import\s*\{[^}]*\bTMDB_KEY\b[^}]*\}\s*from\s*"[^"]*tmdb-key"/,
    "the key is BAKED IN (build-time constant) — the TV has no viable keyboard for it"
  );
  assert.ok(!/tmdbKey/.test(source), "the Player never reads a per-user key setting");
  assert.ok(
    /engine\??\.setSegments\(/.test(source),
    "the resolved segments are fed to the engine (fresh-skip rule)"
  );
  assert.ok(
    /skipSegments/.test(source),
    "the single Settings switch decides auto-skip vs. offering"
  );
  assert.ok(
    /segAction\(/.test(source),
    "the boundary decision comes from the shared pure module (one rule, one place)"
  );
  // TV redesign: the offer is the contextual PILL — no center modal button;
  // Back while the pill is up settles the section (play through).
  assert.ok(
    /playSegThrough\(pill\.index\)/.test(source),
    "Back on the pill lets the user play the section through (settles once)"
  );
  assert.match(
    source,
    /function skipSegNow\([^)]*\)[\s\S]{0,400}?finish\(\)/,
    "skipping the CREDITS ends the episode the same way a natural end does (advance, no resume)"
  );
});

test("the Settings card persists the single switch — NO key entry (the TV has no keyboard for it)", async () => {
  const { source } = await compileScreen("src/ui/screens/Settings.svelte"); // must compile
  const i = source.indexOf("function persist");
  assert.ok(i !== -1, "persist() exists");
  const persistBody = source.slice(i, source.indexOf("function ", i + 10));
  assert.ok(persistBody.includes("skipSegments"), "persist() must save skipSegments");
  assert.ok(!/tmdbKey/.test(source), "the key is not a user setting — there is nothing to type");
  assert.ok(!/key-input/.test(source), "no text field on the card");
  assert.ok(/TheIntroDB/.test(source), "the card names its data source (honesty)");
});

test("the config carries the single switch; the TMDb key is embedded, not configured", () => {
  assert.equal(DEFAULT_CONFIG.skipSegments, true, "auto-skip is the headline: ON by default");
  assert.ok(!("tmdbKey" in DEFAULT_CONFIG), "the key is not part of the user config shape");
  const keySrc = read("src/putio/tmdb-key.ts");
  assert.match(
    keySrc,
    /export const TMDB_KEY\s*=\s*"/,
    "the key lives in ONE clearly-marked build-time constant"
  );
  const src = read("src/putio/config.ts");
  assert.ok(!/skipIntro|skipRecap|skipOutro|introLen|recapLen|outroLen/.test(src), "the fixed-length fields are removed");
  assert.ok(!/tmdbKey/.test(src), "no key field in the config shape");
});

test("the engine derives the fresh start from the shared pure module", () => {
  const media = read("src/putio/media.ts");
  assert.match(
    media,
    /import\s*\{[^}]*freshSkip[^}]*\}\s*from\s*"\.\/segments"/s,
    "media.ts must import freshSkip from ./segments (the one fresh-start rule lives in the pure module, not the engine)"
  );
  assert.ok(!/SegmentConfig/.test(media), "the fixed-length config type is gone from the engine");
});

// LAYOUT regression (carried over from the v1 outer test): the Settings
// columns scroll, and the remote engine's focus-time scrollIntoView is the
// mechanism that makes an off-screen card reachable. A card the user cannot
// scroll to is a card that does not exist.

test("Settings columns scroll vertically — no card is clipped out of reach", async () => {
  const file = join(root, "src", "ui", "screens", "Settings.svelte");
  const source = readFileSync(file, "utf8");
  const processed = await preprocess(source, sveltePreprocess(), { filename: file });
  // css:"external" keeps the styles in css.code (injected embeds them in the JS)
  const { css } = compile(processed.code, {
    generate: "dom",
    filename: file,
    css: "external",
  });
  // scoped styles hash the class, and the marker can be repeated
  // (.col.svelte-xxxx.svelte-xxxx) — match with any number of them
  const colRule = (css.code || "").match(/\.col(?:\.svelte-[-\w]+)*\s*\{[^}]*\}/);
  assert.ok(colRule, "the .col rule exists in the compiled CSS");
  assert.match(
    colRule[0],
    /overflow-y:\s*auto/,
    "the column must scroll vertically (off-screen cards stay D-pad reachable)"
  );
  assert.ok(
    !/overflow(?:-y)?:\s*hidden/.test(colRule[0]),
    "vertical overflow must not be clipped (a clipped card is unreachable)"
  );
});

test("the remote engine scrolls a focused element into view (the reachability mechanism)", () => {
  const src = read("src/webos/remote.ts");
  assert.match(
    src,
    /scrollIntoView\(\s*\{[^}]*block:\s*"nearest"/,
    "focusing an off-screen control must scroll it into view (Library + Settings depend on this)"
  );
});
