// HLS subtitle parity (m00906): "size should be the same regardless of
// which subtitle source you select … This is how it looks with HLS
// selected (which should also parse ASS but it doesn't)".
//
// The HLS source must travel the SAME overlay pipeline as every other
// source: the engine publishes the WebVTT rendition URL (from hls.js's
// subtitleTracks — the video's textTracks carry no URL), the Player
// fetches and parses it with loadSubtitle/vttToCues — lifting the {an8}
// alignment artifact that put.io's ASS→VTT conversion leaves as literal
// cue text — and the file's own style table (already probed from the
// header for every source) styles it. The native textTracks/::cue path
// (fixed 30px, bottom-only, literal {an8} text) is deleted: one pipeline,
// one rule for size and position on every source.
//
// Run: pnpm test
import { test } from "vitest";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { vttToCues, parseHlsTextSegments, loadHlsSubtitles } from "../src/putio/subs.ts";

const here = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(here, "..", p), "utf8");

function bodyOf(src, name) {
  // match the DEFINITION — `name(…){` / `name(…): Type {` — never a call
  // site (`this.name(…);` / `name(…);` have no `{` after the parens)
  const re = new RegExp(`(?:^|[^.\\w])${name}\\s*\\([^)]*\\)\\s*(?::\\s*\\w+(?:\\[\\])?)?\\s*\\{`);
  const m = re.exec(src);
  assert.ok(m, `function ${name}() must exist`);
  const start = m.index + m[0].lastIndexOf(name);
  const end = src.indexOf("\n  }", start);
  assert.ok(end > start, `function ${name}() must be closed`);
  return src.slice(start, end);
}

const player = read("src/ui/screens/Player.svelte");
const media = read("src/putio/media.ts");

// --- the {an8} artifact: parsed, never printed ---------------------------

test("vttToCues: the HLS VTT's no-backslash {an8} is lifted into align, not printed", () => {
  const text = "WEBVTT\n\n00:00:01.680 --> 00:00:04.970\n{an8}Kakero to docu made\n";
  const cues = vttToCues(text);
  assert.equal(cues.length, 1);
  assert.equal(cues[0].align, 8);
  assert.equal(cues[0].text, "Kakero to docu made");
  assert.ok(!cues[0].text.includes("{an8}"), "the artifact must not reach the user");
});

test("vttToCues: the backslash form {\\an8} (the SRT path) still lifts", () => {
  const text = "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n{\\an8}hello\n";
  const cues = vttToCues(text);
  assert.equal(cues[0].align, 8);
  assert.equal(cues[0].text, "hello");
});

// --- the engine: rendition URLs, no native cue feeding --------------------

test("media.ts: SubtitleTrackInfo carries the VTT rendition URL", () => {
  assert.ok(
    /export interface SubtitleTrackInfo\s*\{[\s\S]{0,200}?url\?:\s*string/.test(media),
    "the HLS track info needs the rendition URL — the overlay fetches it itself"
  );
});

test("media.ts: native cue display is switched OFF (hls.subtitleDisplay = false) and the engine re-syncs on SUBTITLE_TRACKS_UPDATED", () => {
  assert.ok(
    /hls\.subtitleDisplay\s*=\s*false/.test(media),
    "the overlay owns rendering — hls.js must never set a textTrack to 'showing' (pinned 1.0.11: an instance property, not a config key)"
  );
  assert.ok(
    /Hls\.Events\.SUBTITLE_TRACKS_UPDATED/.test(media),
    "the rendition list appears after the manifest — the engine must re-sync when hls.js publishes it"
  );
});

test("media.ts: syncHlsTracks publishes {label, lang, url} from hls.js's rendition list", () => {
  const body = bodyOf(media, "syncHlsTracks");
  assert.ok(
    /subtitleTracks/.test(body),
    "must read hls.js's subtitleTracks list — the video's textTracks carry no URL"
  );
  assert.ok(/url:/.test(body), "must publish the rendition URL on each track");
});

// --- the player: one pipeline for every source -----------------------------

test("Player: the overlay renders HLS subtitles too (no source gate, both families feed subLines)", () => {
  const gate = player.match(/\{#if mode === "full"[^\n]*subLines\.length\}/);
  assert.ok(gate, "the overlay gate must key off subLines.length");
  assert.ok(
    !/source !== "hls"/.test(gate[0]),
    "the overlay must no longer exclude the HLS source"
  );
  assert.ok(
    /activeSub === -1 && hlsSub === -1/.test(player),
    "the line builder must treat the HLS family (hlsSub) as a showing family too"
  );
});

test("subs.ts: parseHlsTextSegments keeps only the segment URIs (a real put.io-style playlist)", () => {
  const playlist = ["#EXTM3U", "#EXT-X-VERSION:3", "#EXT-X-TARGETDURATION:31", "", "seg-00001.vtt", "seg-00002.vtt", "", "#EXT-X-ENDLIST"].join("\r\n");
  assert.deepEqual(parseHlsTextSegments(playlist), ["seg-00001.vtt", "seg-00002.vtt"]);
  assert.deepEqual(parseHlsTextSegments("#EXTM3U\n"), []);
});

test("Player: the HLS branch loads the rendition through the same pipeline (loadHlsSubtitles → subCues)", () => {
  const body = bodyOf(player, "selectSubTrack");
  assert.ok(/source === "hls"/.test(body), "selectSubTrack must handle the hls source");
  assert.ok(
    /loadHlsSubtitles\(info\.url\)/.test(body),
    "the HLS branch must fetch+parse the rendition playlist with loadHlsSubtitles (hls.js 1.0.11 exposes the resolved URL, no cue text)"
  );
  assert.ok(/subCues =/.test(body), "…and hand the cues to subCues like every other source");
});

test("Player: turning HLS subtitles off clears the overlay (no native mode toggle left)", () => {
  const body = bodyOf(player, "disableActiveSubs");
  assert.ok(/hlsSub = -1/.test(body), "the off path must reset the HLS selection");
  assert.ok(/subCues = \[\]/.test(body), "…and clear the cues");
  assert.ok(
    !/function selectHlsSub/.test(player),
    "selectHlsSub (the native textTracks mode toggle) must be gone"
  );
});

test("Player: the native ::cue path is deleted (no --cue-size variable, no ::cue rule)", () => {
  assert.ok(
    !/--cue-size/.test(player),
    "the --cue-size CSS variable is gone — the overlay is the only rendering path"
  );
  assert.ok(!/video::cue/.test(player), "the video::cue rule is gone");
});
