// FEATURE: put.io's HLS rendition packages the file's audio streams as
// separate EXT-X-MEDIA:TYPE=AUDIO renditions (captured manifest shape:
//   #EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio/mp4a",NAME="English",DEFAULT=YES,
//     AUTOSELECT=YES,LANGUAGE="en",URI="media.m3u8?quality=360&type=audio&lang=en"
// ). The app must be able to read them from the master playlist text so the
// audio panel can offer a per-language "via put.io stream" row when the TV
// cannot switch the original file natively (see .agents/plan.md, Layer C).
//
// Contract: parseHlsAudioRenditions(text) → audio renditions in manifest
// order. Pure, no DOM, Chrome 79-safe (the bundle must stay ES2019-ish).
//
// Run: pnpm test
import test from "node:test";
import assert from "assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseHlsAudioRenditions } from "../src/putio/hls-manifest.ts";

const here = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(here, "..", p), "utf8");

test("put.io-shaped manifest: two audio renditions parsed with name/lang/default/uri", () => {
  const manifest = [
    "#EXTM3U",
    "#EXT-X-VERSION:3",
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio/mp4a",NAME="English",DEFAULT=YES,AUTOSELECT=YES,LANGUAGE="en",URI="media.m3u8?quality=360&type=audio&lang=en"',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio/mp4a",NAME="Spanish",DEFAULT=NO,AUTOSELECT=NO,LANGUAGE="es",URI="media.m3u8?quality=360&type=audio&lang=es"',
    '#EXT-X-STREAM-INF:BANDWIDTH=400000,CODECS="avc1.4d401e",RESOLUTION=640x360,AUDIO="audio/mp4a",FRAME-RATE=25.000',
    "video-720.m3u8",
  ].join("\n");
  const r = parseHlsAudioRenditions(manifest);
  assert.equal(r.length, 2);
  assert.deepEqual(r[0], { name: "English", lang: "en", isDefault: true, uri: "media.m3u8?quality=360&type=audio&lang=en" });
  assert.deepEqual(r[1], { name: "Spanish", lang: "es", isDefault: false, uri: "media.m3u8?quality=360&type=audio&lang=es" });
});

test("quoted values survive commas and apostrophes", () => {
  const manifest = [
    '#EXT-X-MEDIA:TYPE=AUDIO,NAME="English, Original",LANGUAGE="eng",URI="a.m3u8"',
    "#EXT-X-MEDIA:TYPE=AUDIO,NAME=Director's Commentary,URI=\"b.m3u8\"",
  ].join("\n");
  const r = parseHlsAudioRenditions(manifest);
  assert.equal(r.length, 2);
  assert.equal(r[0].name, "English, Original");
  assert.equal(r[0].lang, "eng");
  assert.equal(r[1].name, "Director's Commentary");
  assert.equal(r[1].lang, null);
  assert.equal(r[1].uri, "b.m3u8");
});

test("missing attributes → null / false, order preserved", () => {
  const r = parseHlsAudioRenditions("#EXT-X-MEDIA:TYPE=AUDIO,URI=\"only.m3u8\"");
  assert.deepEqual(r, [{ name: null, lang: null, isDefault: false, uri: "only.m3u8" }]);
});

test("non-audio EXT-X-MEDIA (subtitles) and other lines are ignored", () => {
  const manifest = [
    "#EXTM3U",
    '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="English",DEFAULT=YES,LANGUAGE="en",URI="sub.m3u8"',
    "#EXT-X-TARGETDURATION:6",
    "#EXTINF:6.0,",
    "seg0.ts",
  ].join("\n");
  assert.deepEqual(parseHlsAudioRenditions(manifest), []);
});

test("multiple groups are all collected", () => {
  const manifest = [
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="g1",NAME="One",LANGUAGE="en",URI="one.m3u8"',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="g2",NAME="Two",LANGUAGE="fr",URI="two.m3u8"',
  ].join("\n");
  const r = parseHlsAudioRenditions(manifest);
  assert.equal(r.length, 2);
  assert.equal(r[1].name, "Two");
  assert.equal(r[1].lang, "fr");
});

test("empty / garbage input → []", () => {
  assert.deepEqual(parseHlsAudioRenditions(""), []);
  assert.deepEqual(parseHlsAudioRenditions("not a playlist at all"), []);
  assert.deepEqual(parseHlsAudioRenditions(null), []);
  assert.deepEqual(parseHlsAudioRenditions(undefined), []);
});

test("the e2e harness master manifest (test/e2e/hls/media.m3u8) parses to 2 renditions", () => {
  const r = parseHlsAudioRenditions(read("test/e2e/hls/media.m3u8"));
  assert.equal(r.length, 2);
  assert.equal(r[0].name, "English");
  assert.equal(r[0].isDefault, true);
  assert.equal(r[1].lang, "es");
});
