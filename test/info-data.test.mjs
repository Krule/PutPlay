// The player's Info tab data layer (src/putio/info-data.ts + info-cache.ts).
//
// The story: the Info panel (info-tab.ts) says only what the title view
// cannot — a synopsis, a details row (rating · genres · air-date-or-runtime),
// and a thumbnail. This module is the async layer that fetches that data per
// file, and it practices the same honest fallback the skip chain does: any
// network/HTTP/shape failure answers null, never a throw, never a block.
//
// The contract this test pins:
//   1. the PURE formatters (the panel shows pre-formatted strings — "May
//      12, 2021", "2h 04m" — so formatting is pure and pinned here):
//        - tmdbImageUrl: a "/..." path → https://image.tmdb.org/t/p/w780...
//          (w780 = the 384×216 panel thumb at 2×); null/""/no leading slash
//          → null
//        - formatAirDate: "2021-05-12" → "May 12, 2021" — parsed as a
//          calendar date, no timezone math (the panel must not drift with
//          the TV's clock zone); garbage → null
//        - formatRuntime: 124 → "2h 04m", 45 → "45m"; 0/negative/NaN → null
//        - stripHtml: tags gone, the common entities decoded, whitespace
//          trimmed, empty result → null
//        - normalizeAnilistScore: AniList's 0–100 → the panel's 0–10
//          (85 → 8.5); out of range/null → null
//   2. the networked lookups (canned TMDb/AniList responses via the swapped
//      globalThis.fetch — the segment-skip router pattern):
//        - TV episodes: search (Bearer key) → /3/tv/{id} →
//          /3/tv/{id}/season/{s}/episode/{e}; the merged InfoData is exact —
//          the episode's overview wins for the synopsis, the show's
//          rating/genres fill in, the episode's still falls back to the
//          show's backdrop
//        - anime (keyless): the caller already resolved the show (AniList);
//          ONE Media(id:) GraphQL POST — no Authorization header — gives the
//          SHOW-LEVEL data (no episode still, no air date, no runtime)
//        - movies: search (primary_release_year when a year tag exists) →
//          /3/movie/{id}; the movie flavor of the match rules (exact name
//          wins over a more popular near-match, a year tag beats
//          popularity, nothing close → null)
//        - no TMDb key → null with ZERO network (anime still works: it is
//          keyless); no match / network reject / HTTP 404 → null
//        - caching (the InfoCache interface, a Map in these tests): read
//          before the network per logical key (tv:/ep:/mv:/al:), write
//          after success, a hit skips that request, a cache throw is a miss
//   3. the IndexedDB store (info-cache.ts, the seg-cache/thumb-store
//      pattern): memory-first, a storage refusal degrades to memory-only,
//      never rejects into the player.
//
// Run: pnpm vitest run test/info-data.test.mjs
//
// The baked-in TMDb key is mocked with a controllable value: the "no key"
// tests flip it to "" without touching the real module (the TV build bakes
// the real token in; a test must not assert on it).
import "fake-indexeddb/auto";
import { test, vi, beforeEach } from "vitest";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const readFile = (p) => readFileSync(join(here, "..", p), "utf8");
import {
  tmdbImageUrl,
  formatAirDate,
  formatRuntime,
  stripHtml,
  normalizeAnilistScore,
  lookupEpisodeInfo,
  lookupMovieInfo,
  movieQueryStages,
} from "../src/putio/info-data.ts";
import { infoCache, __resetForTests as resetInfoCache } from "../src/putio/info-cache.ts";
import { openIdb } from "../src/putio/idb.ts";

const keyState = vi.hoisted(() => ({ key: "test-bearer-token" }));
vi.mock("../src/putio/tmdb-key.ts", () => ({
  get TMDB_KEY() {
    return keyState.key;
  },
}));

// ---------------------------------------------------------------------------
// The fetch router (the segment-skip pattern): every request is logged with
// its URL/method/headers/body; canned responses are registered per test,
// MOST SPECIFIC substring FIRST (a route matches when the URL contains the
// substring — the episode URL contains the show URL, so the episode route
// must be registered before the show route).
// ---------------------------------------------------------------------------
const net = {
  calls: [],
  routes: [],
};
/** `matchBody` (optional): the route matches only when the request BODY
 *  contains it — the AniList fallback POSTS twice to the same URL (the
 *  search query, then Media(id:)), so the URL alone cannot tell them apart. */
function route(contains, body, status = 200, matchBody) {
  net.routes.push({ contains, body, status, matchBody });
}
globalThis.fetch = (url, init) => {
  const u = String(url);
  const call = {
    url: u,
    method: (init && init.method) || "GET",
    headers: init ? init.headers : undefined,
    body: init ? init.body : undefined,
  };
  net.calls.push(call);
  const hit = net.routes.find(
    (r) => u.includes(r.contains) && (r.matchBody === undefined || String(call.body || "").includes(r.matchBody))
  );
  if (hit) {
    return Promise.resolve(
      new Response(JSON.stringify(hit.body), {
        status: hit.status,
        headers: { "Content-Type": "application/json" },
      })
    );
  }
  return Promise.reject(new Error("unexpected network in unit tests: " + u));
};
beforeEach(() => {
  net.calls.length = 0;
  net.routes.length = 0;
});

// Canned TMDb responses (1399 / 157336 are the real TMDb ids of Breaking
// Bad / Inception — the URLs in the assertions read like the real thing).
const SEARCH_TV = {
  results: [
    { id: 1399, name: "Breaking Bad", first_air_date: "2008-01-20", popularity: 200 },
    // a MORE POPULAR near-match must lose to the exact name
    { id: 13998, name: "Breaking Bad Stories", first_air_date: "2013-02-15", popularity: 500 },
  ],
};
const SHOW_DETAIL = {
  id: 1399,
  name: "Breaking Bad",
  overview: "A chemistry teacher with a terminal diagnosis turns to cooking meth.",
  vote_average: 8.9,
  genres: [
    { id: 18, name: "Drama" },
    { id: 80, name: "Crime" },
  ],
  backdrop_path: "/tsRy63Mu5cu8etL1X7ZLyf7m1iK.jpg",
};
const EP_DETAIL = {
  id: 1784,
  name: "One Minute",
  overview: "Walt and Jesse move into the line work.",
  air_date: "2021-05-12",
  still_path: "/hZkgoQYus5z3AFs8zUwBDLWnh7F.jpg",
};
const SEARCH_MOVIE = {
  results: [
    { id: 157336, title: "Inception", release_date: "2010-07-15", popularity: 150 },
    // a MORE POPULAR near-match (the remaster) must lose to the exact name
    { id: 603, title: "Inception (2010 remaster)", release_date: "2010-07-16", popularity: 900 },
  ],
};
const MOVIE_DETAIL = {
  id: 157336,
  title: "Inception",
  overview: "A thief who steals secrets from dreams is offered a way to make them disappear.",
  vote_average: 8.4,
  genres: [
    { id: 28, name: "Action" },
    { id: 878, name: "Science Fiction" },
  ],
  runtime: 124,
  backdrop_path: "/9gk7adHYeDv1kCB47lZCfKJb1ZD.jpg",
};
// Canned AniList Media (show-level: averageScore 0–100, string genres,
// HTML description). THE REAL SCHEMA FIELD IS `averageScore` — a bare
// `score` field is a GraphQL schema error (live: 400 "Cannot query field
// score on type Media"), which is exactly what the app sent for a year.
const ANIME_MEDIA = {
  averageScore: 85,
  genres: ["Adventure", "Drama", "Fantasy"],
  description: "<p>An elf mage who <b>lived a thousand years</b> &amp; outlasts her party.</p>",
  coverImage: { large: "https://s4.anilist.co/large/img/cover/x.jpg" },
};
// Canned AniList SEARCH (Page { media } — the keyless title → anime step).
const ANILIST_SEARCH = {
  data: {
    Page: {
      media: [
        { idMal: 5114, title: { romaji: "Frieren: Beyond Journey's End" }, averageScore: 85, startDate: { year: 2023 } },
        // a LOWER-SCORED near-match must lose the pick
        { idMal: 99999, title: { romaji: "Squishy! Frieren" }, averageScore: 40, startDate: { year: 2024 } },
      ],
    },
  },
};

function tvRoutes() {
  route("/3/tv/1399/season/3/episode/1", EP_DETAIL); // specific first (URL contains the show URL)
  route("/3/tv/1399", SHOW_DETAIL);
  route("/3/search/tv", SEARCH_TV);
}
function movieRoutes() {
  route("/3/movie/157336", MOVIE_DETAIL);
  route("/3/search/movie", SEARCH_MOVIE);
}
function animeRoutes() {
  // most specific FIRST: the two AniList POSTs share a URL — the SEARCH
  // query text ("SearchMedia") and the Media query text ("MediaInfo")
  // distinguish them via the body
  route("graphql.anilist.co", { data: { Page: { media: ANILIST_SEARCH.data.Page.media } } }, 200, "SearchMedia");
  route("graphql.anilist.co", { data: { Media: ANIME_MEDIA } }, 200, "MediaInfo");
}
function anilistSearchEmpty() {
  route("graphql.anilist.co", { data: { Page: { media: [] } } }, 200, "SearchMedia");
}
/** A fake InfoCache: an in-memory Map with a peekable store. */
function fakeCache() {
  const store = new Map();
  return {
    store,
    cache: {
      get: (k) => Promise.resolve(store.get(k)),
      put: (k, v) => {
        store.set(k, v);
        return Promise.resolve();
      },
    },
  };
}

// ---------------------------------------------------------------------------
// 1. the pure formatters
// ---------------------------------------------------------------------------
test("tmdbImageUrl: a /-path becomes the w780 image URL; the size arg is the only dial", () => {
  assert.equal(
    tmdbImageUrl("/abc.jpg"),
    "https://image.tmdb.org/t/p/w780/abc.jpg"
  );
  assert.equal(
    tmdbImageUrl("/abc.jpg", "w780"),
    "https://image.tmdb.org/t/p/w780/abc.jpg"
  );
});

test("tmdbImageUrl: null / undefined / empty / no leading slash → null", () => {
  assert.equal(tmdbImageUrl(null), null);
  assert.equal(tmdbImageUrl(undefined), null);
  assert.equal(tmdbImageUrl(""), null);
  assert.equal(tmdbImageUrl("no-slash.jpg"), null);
});

test("formatAirDate: an ISO date formats en-US as 'May 12, 2021' (no timezone drift)", () => {
  assert.equal(formatAirDate("2021-05-12"), "May 12, 2021");
  assert.equal(formatAirDate("2021-01-01"), "Jan 1, 2021"); // a partial-looking date is fine to format
  assert.equal(formatAirDate("1999-12-31"), "Dec 31, 1999");
});

test("formatAirDate: null / empty / garbage / impossible dates → null", () => {
  assert.equal(formatAirDate(null), null);
  assert.equal(formatAirDate(undefined), null);
  assert.equal(formatAirDate(""), null);
  assert.equal(formatAirDate("garbage"), null);
  assert.equal(formatAirDate("2021-05-12T21:30:00Z"), null); // a datetime is not a date
  assert.equal(formatAirDate("2021-13-01"), null); // month out of range
  assert.equal(formatAirDate("2021-02-30"), null); // February has 28 days (2021)
});

test("formatRuntime: 124 → '2h 04m', 45 → '45m', the hour boundary pads", () => {
  assert.equal(formatRuntime(124), "2h 04m");
  assert.equal(formatRuntime(45), "45m");
  assert.equal(formatRuntime(60), "1h 00m");
  assert.equal(formatRuntime(59), "59m");
});

test("formatRuntime: 0 / negative / NaN / null / undefined → null (no fake runtime)", () => {
  assert.equal(formatRuntime(0), null);
  assert.equal(formatRuntime(-5), null);
  assert.equal(formatRuntime(NaN), null);
  assert.equal(formatRuntime(null), null);
  assert.equal(formatRuntime(undefined), null);
});

test("stripHtml: nested tags are removed and the common entities are decoded", () => {
  assert.equal(
    stripHtml("<p>He is <b>bold</b> &amp; <i>italic</i></p>"),
    "He is bold & italic"
  );
  assert.equal(
    stripHtml("She said &quot;hi&quot; &amp; left"),
    'She said "hi" & left'
  );
  assert.equal(stripHtml("It&#39;s &lt;tag&gt; &#039;quoted&#039;"), "It's <tag> 'quoted'");
});

test("stripHtml: &nbsp; decodes; surrounding whitespace is trimmed", () => {
  assert.equal(stripHtml("  a&nbsp;b  "), "a b");
});

test("stripHtml: an empty result → null (the panel omits, never placeholders)", () => {
  assert.equal(stripHtml("<div></div>"), null);
  assert.equal(stripHtml("&nbsp;"), null);
  assert.equal(stripHtml("   "), null);
  assert.equal(stripHtml(""), null);
  assert.equal(stripHtml(null), null);
  assert.equal(stripHtml(undefined), null);
});

test("normalizeAnilistScore: 0–100 → 0–10 (85 → 8.5); the bounds are inclusive", () => {
  assert.equal(normalizeAnilistScore(85), 8.5);
  assert.equal(normalizeAnilistScore(0), 0);
  assert.equal(normalizeAnilistScore(100), 10);
});

test("normalizeAnilistScore: out of range / null / undefined / NaN → null", () => {
  assert.equal(normalizeAnilistScore(101), null);
  assert.equal(normalizeAnilistScore(-1), null);
  assert.equal(normalizeAnilistScore(null), null);
  assert.equal(normalizeAnilistScore(undefined), null);
  assert.equal(normalizeAnilistScore(NaN), null);
});

// ---------------------------------------------------------------------------
// 2. lookupEpisodeInfo — the TMDb chain (search → show detail → episode detail)
// ---------------------------------------------------------------------------
test("episode: the full TV path merges show + episode into the exact InfoData", async () => {
  tvRoutes();
  const got = await lookupEpisodeInfo({ title: "Breaking Bad", season: 3, episode: 1 });
  assert.deepEqual(got, {
    synopsis: "Walt and Jesse move into the line work.", // the episode's overview wins
    rating: 8.9, // the show's vote_average (already 0–10)
    genres: ["Drama", "Crime"], // the show's genres, display names
    airDate: "May 12, 2021", // the episode's air_date, pre-formatted
    runtime: null, // movies only
    thumbUrl: "https://image.tmdb.org/t/p/w780/hZkgoQYus5z3AFs8zUwBDLWnh7F.jpg", // the episode still
    episodeTitle: "One Minute", // the episode's TMDb name — the title-view enrichment
  });
  // the exact request chain: search (Bearer) → show detail → episode detail.
  // The EXACT name won over the more popular "Breaking Bad Stories" (13998).
  assert.deepEqual(
    net.calls.map((c) => c.url),
    [
      "https://api.themoviedb.org/3/search/tv?query=Breaking+Bad&language=en-US",
      "https://api.themoviedb.org/3/tv/1399",
      "https://api.themoviedb.org/3/tv/1399/season/3/episode/1",
    ]
  );
  for (const c of net.calls) assert.equal(c.headers.Authorization, "Bearer test-bearer-token");
});

test("episode: a null episode overview falls back to the show's", async () => {
  route("/3/tv/1399/season/3/episode/1", { id: 1784, overview: null, air_date: "2021-05-12", still_path: "/s.jpg" });
  route("/3/tv/1399", SHOW_DETAIL);
  route("/3/search/tv", SEARCH_TV);
  const got = await lookupEpisodeInfo({ title: "Breaking Bad", season: 3, episode: 1 });
  assert.equal(got.synopsis, SHOW_DETAIL.overview, "the show's overview fills the gap");
});

test("episode: no overview anywhere → null synopsis (the panel omits it)", async () => {
  route("/3/tv/1399/season/3/episode/1", { id: 1784, air_date: "2021-05-12", still_path: "/s.jpg" });
  route("/3/tv/1399", { id: 1399, vote_average: 8.9, genres: [], backdrop_path: null });
  route("/3/search/tv", SEARCH_TV);
  const got = await lookupEpisodeInfo({ title: "Breaking Bad", season: 3, episode: 1 });
  assert.equal(got.synopsis, null, "neither endpoint carried an overview");
});

test("episode: a missing still_path falls back to the show's backdrop_path", async () => {
  route("/3/tv/1399/season/3/episode/1", { id: 1784, overview: "x", air_date: "2021-05-12", still_path: null });
  route("/3/tv/1399", SHOW_DETAIL);
  route("/3/search/tv", SEARCH_TV);
  const got = await lookupEpisodeInfo({ title: "Breaking Bad", season: 3, episode: 1 });
  assert.equal(
    got.thumbUrl,
    "https://image.tmdb.org/t/p/w780/tsRy63Mu5cu8etL1X7ZLyf7m1iK.jpg",
    "the show's backdrop covers for the missing still"
  );
});

test("episode: no TMDb key → the TMDb chain is skipped, the keyless AniList fallback still runs (nothing matches a western show)", async () => {
  keyState.key = "";
  anilistSearchEmpty();
  try {
    const got = await lookupEpisodeInfo({ title: "Breaking Bad", season: 1, episode: 1 });
    assert.equal(got, null);
    assert.equal(net.calls.length, 1, "exactly the keyless AniList search");
    assert.ok(net.calls[0].url.includes("graphql.anilist.co"), "no TMDb at all");
  } finally {
    keyState.key = "test-bearer-token";
  }
});

test("episode: a search with nothing close → the AniList fallback also misses → null (the detail endpoints are never hit)", async () => {
  route("/3/search/tv", { results: [{ id: 5, name: "Completely Different Show", first_air_date: "2019-01-01" }] });
  anilistSearchEmpty(); // "Breaking Bad" is not an anime
  const got = await lookupEpisodeInfo({ title: "Breaking Bad", season: 3, episode: 1 });
  assert.equal(got, null);
  assert.equal(net.calls.length, 2, "the TMDb search + the keyless AniList fallback search");
  assert.ok(net.calls[0].url.includes("/3/search/tv"));
  assert.ok(net.calls[1].url.includes("graphql.anilist.co"));
});

test("episode: a network reject → null (never throws, never blocks)", async () => {
  // no routes registered: the search URL is unmatched → the router rejects
  const got = await lookupEpisodeInfo({ title: "Breaking Bad", season: 3, episode: 1 });
  assert.equal(got, null);
});

test("episode: an HTTP 404 on the show detail → null (no episode request)", async () => {
  route("/3/tv/1399", SHOW_DETAIL, 404);
  route("/3/search/tv", SEARCH_TV);
  const got = await lookupEpisodeInfo({ title: "Breaking Bad", season: 3, episode: 1 });
  assert.equal(got, null);
  assert.ok(!net.calls.some((c) => c.url.includes("/season/")), "the episode was never fetched");
});

// ---------------------------------------------------------------------------
// 2b. lookupEpisodeInfo — the AniList fallback (keyless, show-level only).
// TMDb first (it has the richer data: episode still, air date, episode
// title); when the TMDb chain answers nothing — the anime case — the
// module resolves the title against AniList ITSELF (search → pick →
// ONE Media query). The Player never orchestrates this: it passes the
// parsed title and the module owns its fallbacks.
// ---------------------------------------------------------------------------
test("episode: the AniList Media query asks for averageScore — the real schema field (a bare `score` is a 400)", () => {
  // source gate: the GraphQL field list is the contract with AniList's
  // schema; it drifted (sent `score`, got 400 "Cannot query field score
  // on type Media") and the mocked fetch could never see it
  const src = readFile("src/putio/info-data.ts");
  const qm = src.match(/const ANILIST_MEDIA_QUERY = `([\s\S]*?)`;/);
  assert.ok(qm, "the Media query constant is there");
  const q = qm[1];
  assert.ok(q.includes("averageScore"), "the 0–100 community score is `averageScore`");
  assert.ok(!/\bscore\b/i.test(q.replace("averageScore", "")), "no bare `score` field anywhere in the query");
});

test("episode: an empty TMDb search → the keyless AniList fallback (search → pick → Media), show-level data only", async () => {
  route("/3/search/tv", { results: [] }); // the anime is not on TMDb
  animeRoutes();
  const got = await lookupEpisodeInfo({ title: "Frieren", season: 1, episode: 1 });
  assert.deepEqual(got, {
    synopsis: "An elf mage who lived a thousand years & outlasts her party.", // HTML stripped
    rating: 8.5, // averageScore 85 (0–100) → 0–10
    genres: ["Adventure", "Drama", "Fantasy"],
    airDate: null, // show-level only
    runtime: null, // show-level only
    thumbUrl: "https://s4.anilist.co/large/img/cover/x.jpg", // coverImage.large, as-is
    episodeTitle: null, // AniList Media is show-level only
  });
  assert.equal(net.calls.length, 3, "one TMDb search + AniList search + Media");
  const al = net.calls.filter((c) => c.url.includes("graphql.anilist.co"));
  assert.equal(al.length, 2);
  for (const c of al) {
    assert.equal(c.method, "POST");
    assert.equal(c.headers.Authorization, undefined, "AniList is keyless — no auth header");
  }
  const search = al.find((c) => c.body.includes("SearchMedia"));
  assert.deepEqual(JSON.parse(search.body).variables, { q: "Frieren", y: null });
  const media = al.find((c) => c.body.includes("MediaInfo"));
  assert.equal(JSON.parse(media.body).variables.id, 5114, "the Media query carries the PICKED id (85 beats 40)");
});

test("episode: a TMDb hit never triggers the AniList fallback (no extra network for western TV)", async () => {
  tvRoutes();
  await lookupEpisodeInfo({ title: "Breaking Bad", season: 3, episode: 1 });
  assert.ok(!net.calls.some((c) => c.url.includes("anilist")), "AniList was never contacted");
});

test("episode: the AniList search finds nothing → null (the Media query is never sent)", async () => {
  route("/3/search/tv", { results: [] });
  anilistSearchEmpty();
  const got = await lookupEpisodeInfo({ title: "Totally Unknown Anime", season: 1, episode: 1 });
  assert.equal(got, null);
  assert.equal(net.calls.length, 2, "TMDb search + the empty AniList search, nothing more");
});

test("episode: an anime Media cache hit skips the GraphQL Media request (the search still runs)", async () => {
  keyState.key = "";
  animeRoutes();
  const fc = fakeCache();
  fc.store.set("al:5114", ANIME_MEDIA);
  try {
    const got = await lookupEpisodeInfo({ title: "Frieren", season: 1, episode: 1, cache: fc.cache });
    assert.equal(got.rating, 8.5, "the cached Media serves the data");
    assert.equal(
      net.calls.filter((c) => c.body && c.body.includes("MediaInfo")).length,
      0,
      "no Media POST"
    );
    assert.equal(
      net.calls.filter((c) => c.body && c.body.includes("SearchMedia")).length,
      1,
      "the resolution search still ran (it is not cached)"
    );
  } finally {
    keyState.key = "test-bearer-token";
  }
});

test("episode: the anime Media is written after a successful query (al:{id})", async () => {
  keyState.key = "";
  animeRoutes();
  const fc = fakeCache();
  try {
    const got = await lookupEpisodeInfo({ title: "Frieren", season: 1, episode: 1, cache: fc.cache });
    assert.equal(got.rating, 8.5);
    assert.deepEqual(fc.store.get("al:5114"), ANIME_MEDIA, "write-after-success");
  } finally {
    keyState.key = "test-bearer-token";
  }
});

// ---------------------------------------------------------------------------
// 2c. lookupEpisodeInfo — caching (read-before-network, write-after-success,
//      fault-tolerance)
// ---------------------------------------------------------------------------
test("episode: detail cache hits skip both detail requests (only the search runs)", async () => {
  tvRoutes();
  const fc = fakeCache();
  fc.store.set("tv:1399", SHOW_DETAIL);
  fc.store.set("ep:1399:3:1", EP_DETAIL);
  const got = await lookupEpisodeInfo({ title: "Breaking Bad", season: 3, episode: 1, cache: fc.cache });
  assert.deepEqual(got, {
    synopsis: "Walt and Jesse move into the line work.",
    rating: 8.9,
    genres: ["Drama", "Crime"],
    airDate: "May 12, 2021",
    runtime: null,
    thumbUrl: "https://image.tmdb.org/t/p/w780/hZkgoQYus5z3AFs8zUwBDLWnh7F.jpg",
    episodeTitle: "One Minute",
  });
  assert.equal(net.calls.length, 1, "the hit skips THAT request");
  assert.ok(net.calls[0].url.includes("/3/search/tv"), "the search still runs (it has no cache key)");
});

test("episode: a repeat play costs only the search (details came from the cache)", async () => {
  tvRoutes();
  const fc = fakeCache();
  await lookupEpisodeInfo({ title: "Breaking Bad", season: 3, episode: 1, cache: fc.cache });
  assert.equal(net.calls.length, 3, "first play: search + show + episode");
  await lookupEpisodeInfo({ title: "Breaking Bad", season: 3, episode: 1, cache: fc.cache });
  const second = net.calls.slice(3);
  assert.equal(second.length, 1, "second play: the search only");
  assert.ok(second[0].url.includes("/3/search/tv"));
});

test("episode: the details are written after success (exactly tv: and ep: keys)", async () => {
  tvRoutes();
  const fc = fakeCache();
  await lookupEpisodeInfo({ title: "Breaking Bad", season: 3, episode: 1, cache: fc.cache });
  assert.deepEqual([...fc.store.keys()].sort(), ["ep:1399:3:1", "tv:1399"]);
  assert.deepEqual(fc.store.get("tv:1399"), SHOW_DETAIL, "the raw show detail is cached");
  assert.deepEqual(fc.store.get("ep:1399:3:1"), EP_DETAIL, "the raw episode detail is cached");
});

test("episode: a cache get that throws is treated as a miss (the network still answers)", async () => {
  tvRoutes();
  const hostile = {
    get: () => Promise.reject(new Error("cache boom")),
    put: () => Promise.resolve(),
  };
  const got = await lookupEpisodeInfo({ title: "Breaking Bad", season: 3, episode: 1, cache: hostile });
  assert.equal(got.airDate, "May 12, 2021", "the miss fell through to the network");
});

test("episode: a cache put failure is ignored (the data still lands)", async () => {
  tvRoutes();
  const hostile = {
    get: () => Promise.resolve(undefined),
    put: () => Promise.reject(new Error("cache boom")),
  };
  const got = await lookupEpisodeInfo({ title: "Breaking Bad", season: 3, episode: 1, cache: hostile });
  assert.equal(got.rating, 8.9, "the put failure never blocks the panel");
});

// ---------------------------------------------------------------------------
// 3. lookupMovieInfo — TMDb search (primary_release_year) → movie detail
// ---------------------------------------------------------------------------
test("movie: the full path — search with the year tag, the exact name wins, runtime formatted", async () => {
  movieRoutes();
  const got = await lookupMovieInfo({ name: "Inception", year: 2010 });
  assert.deepEqual(got, {
    synopsis: "A thief who steals secrets from dreams is offered a way to make them disappear.",
    rating: 8.4,
    genres: ["Action", "Science Fiction"],
    airDate: null, // movies never show an air date
    runtime: "2h 04m", // 124 minutes, pre-formatted
    thumbUrl: "https://image.tmdb.org/t/p/w780/9gk7adHYeDv1kCB47lZCfKJb1ZD.jpg",
    episodeTitle: null, // movies have no episode title
  });
  assert.deepEqual(
    net.calls.map((c) => c.url),
    [
      "https://api.themoviedb.org/3/search/movie?query=Inception&language=en-US&primary_release_year=2010",
      "https://api.themoviedb.org/3/movie/157336", // the EXACT match, not the more popular remaster (603)
    ]
  );
  for (const c of net.calls) assert.equal(c.headers.Authorization, "Bearer test-bearer-token");
});

test("movie: without a year tag the search carries no primary_release_year", async () => {
  movieRoutes();
  await lookupMovieInfo({ name: "Inception" });
  assert.equal(
    net.calls[0].url,
    "https://api.themoviedb.org/3/search/movie?query=Inception&language=en-US"
  );
});

test("movie: a year tag beats popularity (the 1994 original over the louder remake)", async () => {
  route("/3/movie/28", { id: 28, overview: "Hope is a good thing.", vote_average: 9.3, genres: [], runtime: 142, backdrop_path: null });
  route("/3/search/movie", {
    results: [
      { id: 28, title: "The Shawshank Redemption", release_date: "1994-09-10", popularity: 90 },
      { id: 29, title: "The Shawshank Redemption", release_date: "2020-05-01", popularity: 900 },
    ],
  });
  const got = await lookupMovieInfo({ name: "The Shawshank Redemption", year: 1994 });
  assert.equal(got.runtime, "2h 22m");
  assert.ok(net.calls.some((c) => c.url === "https://api.themoviedb.org/3/movie/28"), "the 1994 film was picked");
  assert.ok(!net.calls.some((c) => c.url.includes("/movie/29")));
});

test("movie: nothing close → null (the detail endpoint is never hit)", async () => {
  route("/3/search/movie", { results: [{ id: 42, title: "Totally Different", release_date: "2015-01-01", popularity: 10 }] });
  const got = await lookupMovieInfo({ name: "Inception", year: 2010 });
  assert.equal(got, null);
  assert.equal(net.calls.length, 1, "only the search ran");
});

test("movie: no TMDb key → null with ZERO fetches", async () => {
  keyState.key = "";
  try {
    const got = await lookupMovieInfo({ name: "Inception", year: 2010 });
    assert.equal(got, null);
    assert.equal(net.calls.length, 0);
  } finally {
    keyState.key = "test-bearer-token";
  }
});

test("movie: a search hit but an HTTP 404 detail → null", async () => {
  route("/3/movie/157336", MOVIE_DETAIL, 404);
  route("/3/search/movie", SEARCH_MOVIE);
  const got = await lookupMovieInfo({ name: "Inception", year: 2010 });
  assert.equal(got, null);
});

test("movie: a detail cache hit skips the detail request; the detail is written after success", async () => {
  movieRoutes();
  const fc = fakeCache();
  await lookupMovieInfo({ name: "Inception", year: 2010, cache: fc.cache });
  assert.deepEqual([...fc.store.keys()], ["mv:157336"], "the movie detail is cached by its id");
  assert.deepEqual(fc.store.get("mv:157336"), MOVIE_DETAIL);

  net.calls.length = 0;
  const got = await lookupMovieInfo({ name: "Inception", year: 2010, cache: fc.cache });
  assert.equal(got.runtime, "2h 04m");
  assert.equal(net.calls.length, 1, "the repeat play re-runs only the search");
  assert.ok(net.calls[0].url.includes("/3/search/movie"));
});

// ---------------------------------------------------------------------------
// 3b. movieQueryStages — the query ladder. TMDb's movie search is near-exact:
// any extra token (a group name, a space year) → 0 results (verified live:
// "Kindergarten Cop 1990" → 0, "Kindergarten Cop" y=1990 → 1;
// "Blade Runner" y=2049 → 0, "Blade Runner 2049" → 1 — the 2049 film's
// primary_release_year is 2017, so the year param cannot carry it). The
// ladder re-forms the query in stages; the walk stops at the first NON-EMPTY
// result set (matched or rejected — dropping further risks a false match).
// ---------------------------------------------------------------------------

test("stages: a clean title is one stage (plus the year re-joined when a year param exists)", () => {
  assert.deepEqual(movieQueryStages("Inception", 2010), [
    { title: "Inception", year: 2010 },
    { title: "Inception 2010" }, // the year may be part of the title
  ]);
  // a 2-word title always carries the group-tail fallback (stage 1 is empty
  // only for a real "Title Group" name — then "Some" costs one wasted query)
  assert.deepEqual(movieQueryStages("Some Movie"), [
    { title: "Some Movie" },
    { title: "Some" },
  ]);
});

test("stages: a trailing space year becomes the year param (Kindergarten Cop 1990)", () => {
  assert.deepEqual(movieQueryStages("Kindergarten Cop 1990"), [
    { title: "Kindergarten Cop 1990" },
    { title: "Kindergarten Cop", year: 1990 },
  ]);
});

test("stages: a group tail is dropped, the year param kept (…All at Once Licdom)", () => {
  assert.deepEqual(movieQueryStages("Everything Everywhere All at Once Licdom", 2022), [
    { title: "Everything Everywhere All at Once Licdom", year: 2022 },
    { title: "Everything Everywhere All at Once", year: 2022 },
    { title: "Everything Everywhere All at Once Licdom 2022" },
  ]);
});

test("stages: a dot-stripped title year is re-joined (Blade Runner 2049 — the 2017 primary_release trap)", () => {
  assert.deepEqual(movieQueryStages("Blade Runner", 2049), [
    { title: "Blade Runner", year: 2049 },
    { title: "Blade", year: 2049 }, // the drop-last heuristic misses here — stage 3 saves it
    { title: "Blade Runner 2049" },
  ]);
});

test("stages: a stacked group tail + space year (…Movie 2020 Group) peels in order", () => {
  assert.deepEqual(movieQueryStages("Some Movie 2020 Group"), [
    { title: "Some Movie 2020 Group" },
    { title: "Some Movie 2020" },
    { title: "Some Movie", year: 2020 },
  ]);
});

const KINDERGARTEN_DETAIL = {
  id: 1170,
  title: "Kindergarten Cop",
  overview: "A police officer poses as a kindergartner to catch a suspect.",
  vote_average: 6.4,
  genres: [],
  runtime: 118,
  backdrop_path: "/kc.jpg",
};

test("movie walk: an empty primary search retries with the space year as the year param", async () => {
  // most specific FIRST: the full-title query returns nothing, the
  // re-formed query (year moved to the param) returns the film
  route(
    "query=Kindergarten+Cop+1990&language=en-US",
    { results: [] }
  );
  route(
    "query=Kindergarten+Cop&language=en-US&primary_release_year=1990",
    { results: [{ id: 1170, title: "Kindergarten Cop", release_date: "1990-06-08", popularity: 10 }] }
  );
  route("/3/movie/1170", KINDERGARTEN_DETAIL);
  const got = await lookupMovieInfo({ name: "Kindergarten Cop 1990" });
  assert.equal(got.runtime, "1h 58m");
  assert.deepEqual(
    net.calls.map((c) => c.url),
    [
      "https://api.themoviedb.org/3/search/movie?query=Kindergarten+Cop+1990&language=en-US",
      "https://api.themoviedb.org/3/search/movie?query=Kindergarten+Cop&language=en-US&primary_release_year=1990",
      "https://api.themoviedb.org/3/movie/1170",
    ],
    "two searches, then the detail"
  );
});

test("movie walk: an empty year-param search retries with the year re-joined to the title", async () => {
  route("query=Blade+Runner&language=en-US&primary_release_year=2049", { results: [] });
  // the drop-last heuristic's query: TMDb answers empty for "Blade" y=2049
  route("query=Blade&language=en-US&primary_release_year=2049", { results: [] });
  route("query=Blade+Runner+2049&language=en-US", {
    results: [{ id: 335984, title: "Blade Runner 2049", release_date: "2017-10-06", popularity: 30 }],
  });
  route("/3/movie/335984", { id: 335984, overview: "Deckard is reeled back.", vote_average: 8.0, genres: [], runtime: 163, backdrop_path: "/br2049.jpg" });
  const got = await lookupMovieInfo({ name: "Blade Runner", year: 2049 });
  assert.equal(got.synopsis, "Deckard is reeled back.");
  assert.ok(
    net.calls.some((c) => c.url.includes("query=Blade+Runner+2049")),
    "the re-joined query ran"
  );
  assert.ok(
    !net.calls.some((c) => c.url.includes("movie/335984") === false && c.url.includes("/movie/")),
    "no other detail was fetched"
  );
});

test("movie walk: a non-empty search ends the walk even when nothing matches (no false-match from further drops)", async () => {
  route("/3/search/movie", { results: [{ id: 42, title: "Totally Different", release_date: "2015-01-01", popularity: 10 }] });
  const got = await lookupMovieInfo({ name: "Inception", year: 2010 });
  assert.equal(got, null);
  assert.equal(net.calls.length, 1, "only the primary search ran");
});

// ---------------------------------------------------------------------------
// 4. info-cache.ts — the IndexedDB store (fake-indexeddb: real behavior)
// ---------------------------------------------------------------------------
test("info-cache: put then get round-trips through IDB (not just the session map)", async () => {
  resetInfoCache();
  await infoCache.put("al:5114", { score: 85 });
  const h = await openIdb("putplay.infocache", 1);
  assert.deepEqual(await h.get("al:5114"), { score: 85 }, "the entry is really in the store");
  h.close();
});

test("info-cache: memory-first — a get after put is served without IDB (wiped storage)", async () => {
  resetInfoCache();
  await infoCache.put("tv:1399", { vote_average: 8.9 });
  // wipe the storage behind the store's back (another connection)
  const h = await openIdb("putplay.infocache", 1);
  await h.clear();
  h.close();
  assert.deepEqual(
    await infoCache.get("tv:1399"),
    { vote_average: 8.9 },
    "memory serves the session even when storage is gone"
  );
});

test("info-cache: a missing key resolves to undefined (no throw)", async () => {
  resetInfoCache();
  assert.equal(await infoCache.get("nope"), undefined);
});

/** Last: it disables the IDB global and restores it in finally. */
test("info-cache: an IDB refusal → memory-only, put resolves, get serves memory (never rejects)", async () => {
  const real = globalThis.indexedDB;
  globalThis.indexedDB = { open() { throw new Error("no idb"); } };
  resetInfoCache();
  try {
    await infoCache.put("tv:1399", { vote_average: 8.9 }); // resolves, not rejects
    assert.deepEqual(
      await infoCache.get("tv:1399"),
      { vote_average: 8.9 },
      "the session is memory-only and still serves the value"
    );
  } finally {
    globalThis.indexedDB = real;
    resetInfoCache();
  }
});
