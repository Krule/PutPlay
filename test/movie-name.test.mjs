// Contract: parseMovieName — the movie half of the file-name identity parse.
//
// parseEpisode answers "is this an episode" (and gives the show/season/
// episode). A file with NO episode marker (a movie) still needs a query for
// the Info tab's TMDb movie search — parseMovieName gives it the movie
// title (and a year, when the name carries one):
//
//   "Inception (2010) 1080p BluRay x264.mkv" → { title: "Inception", year: 2010 }
//   "The.Matrix (1999).mkv"                  → { title: "The Matrix", year: 1999 }
//   "Oppenheimer.2023.2160p UHD x265.mkv"    → { title: "Oppenheimer", year: 2023 }
//
// The SAME tail-cleaning rules as the episode parser (release-group tag,
// bracket tags, quality tokens, scene words) — a movie name is a title with
// the scene junk stripped, plus at most ONE year:
//   • a (19xx/20xx) PAREN year — the unambiguous form — always wins;
//   • otherwise a DOT-separated trailing year (1900–2099) — the common
//     scene form "Title.2010.1080p". A SPACE-separated trailing year is
//     kept in the title (it may be part of the name).
//
// Known ambiguity (documented): "Blade.Runner.2049" — 2049 is inside the
// year range but is part of the title. The year is stripped anyway; the
// lookup degrades gracefully (name search without a matching year → the
// exact-name matcher decides).
//
// Pure — no DOM/webOS imports. Run: pnpm test

import { test } from "vitest";
import assert from "node:assert/strict";
import { parseMovieName } from "../src/putio/titles.ts";

test("a paren year + scene junk: the clean title and the year", () => {
  assert.deepEqual(parseMovieName("Inception (2010) 1080p BluRay x264.mkv"), {
    title: "Inception",
    year: 2010,
  });
});

test("dotted name with a paren year", () => {
  assert.deepEqual(parseMovieName("The.Matrix (1999).mkv"), { title: "The Matrix", year: 1999 });
});

test("dotted name with a DOT-separated trailing year", () => {
  assert.deepEqual(parseMovieName("Oppenheimer.2023.2160p.UHD.BluRay.x265.mkv"), {
    title: "Oppenheimer",
    year: 2023,
  });
});

test("no year at all: the title only (year is absent, not undefined-with-a-hole)", () => {
  assert.deepEqual(parseMovieName("Some.Movie.720p.WEB-DL.mkv"), { title: "Some Movie" });
});

test("release-group tag, bracket tag, and quality all stripped", () => {
  assert.deepEqual(parseMovieName("[Group] Movie.Name (2020) [abc123].1080p.mkv"), {
    title: "Movie Name",
    year: 2020,
  });
});

test("a SPACE-separated trailing year stays in the title", () => {
  const got = parseMovieName("Movie Name 1999 1080p BluRay.mkv");
  assert.equal(got.year, undefined, "no paren/dot year → no year");
  assert.equal(got.title, "Movie Name 1999");
});

test("the documented ambiguity: a dot year inside the title is still stripped", () => {
  const got = parseMovieName("Blade.Runner.2049.1080p.mkv");
  assert.equal(got.year, 2049, "the range rule cannot see titles — documented");
  assert.equal(got.title, "Blade Runner");
});

test("a name that is nothing but numbers is no movie (null)", () => {
  assert.equal(parseMovieName("123.mkv"), null);
  assert.equal(parseMovieName("1080p.mkv"), null);
});

test("empty / junk-only names → null", () => {
  assert.equal(parseMovieName(""), null);
  assert.equal(parseMovieName("   "), null);
  assert.equal(parseMovieName(".mkv"), null);
  assert.equal(parseMovieName("x264.1080p.mkv"), null);
});

// ---------------------------------------------------------------------------
// Scene junk in the MIDDLE of the name (not just the tail): real release
// names stack codec/source/audio/language tags between the title and the
// group tail ("Kindergarten Cop 1990 1080p AMZN WEB-DL DDP2 0 H 264-GPRS").
// TMDb's search answers 0 results for a junk-laden query (verified live:
// "Kindergarten Cop 1990 1080p AMZN …" → 0, "Kindergarten Cop" y=1990 → 1),
// so the query must be the clean title. The known junk vocabulary is
// stripped ANYWHERE it appears; an unknown word (a release group: "Licdom",
// "GPRS") survives here — the lookup's query ladder drops it as a fallback.
// ---------------------------------------------------------------------------

test("junk between title and tail: a WEB-DL rip with stacked audio/codec tags", () => {
  assert.deepEqual(
    parseMovieName("Kindergarten Cop 1990 1080p AMZN WEB-DL DDP2 0 H 264-GPRS.mkv"),
    { title: "Kindergarten Cop 1990" } // the space year stays in the title (the ladder moves it to the year param)
  );
});

test("junk mid-name with a paren year: the language/audio/codec stack is gone, the group tail survives for the ladder", () => {
  assert.deepEqual(
    parseMovieName(
      "Everything Everywhere All at Once (2022) 2160p H265 10 bit Dolby Vision ita eng AC3 5.1 sub ita eng Licdom.mkv"
    ),
    { title: "Everything Everywhere All at Once Licdom", year: 2022 }
  );
});

test("a broken codec split across a space (H 264) and a group-glued tail (264-GPRS) are one junk token", () => {
  assert.deepEqual(parseMovieName("Some Movie H 264-GOP 1080p.mkv"), { title: "Some Movie" });
});

test("the WEB guard: 'Web (1995)' is a movie — only the COMPOUND web-dl/webrip tags are junk", () => {
  assert.deepEqual(parseMovieName("Web (1995).1080p.WEB-DL.x264-GOP.mkv"), { title: "Web", year: 1995 });
});

test("'10 Cloverfield Lane': a standalone '10' in the title survives (only the phrase '10 bit' is junk)", () => {
  assert.deepEqual(parseMovieName("10.Cloverfield.Lane.2014.720p.WEBRip.x264.mkv"), {
    title: "10 Cloverfield Lane",
    year: 2014,
  });
});
