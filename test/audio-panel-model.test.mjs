// FEATURE: the audio panel model must reach the Player. MediaEngine owns the
// three inputs (native audioTracks, put.io media_info, HLS manifest
// renditions), merges them with the pure track-merge model, and publishes
// the rows in its state — plus the row the user actually picked at.
//
// Contract (source-level, as in the other MediaEngine tests):
//   - the engine fetches media_info for the file (audioStreamsFromMediaInfo)
//   - for multi-audio files it prefetches the HLS manifest and parses the
//     audio renditions (parseHlsAudioRenditions)
//   - every sync publishes audioPanelRows (mergeAudioRows output)
//   - addtrack/removetrack are listened to (LG fires addtrack; `change`
//     alone misses the initial population on some files)
//   - selection is row-based: selectAudioRow(row)
//
// Run: pnpm test
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import assert from "assert/strict";

const here = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(here, "..", p), "utf8");
const media = () => read("src/putio/media.ts");

test("MediaEngine consumes the merged panel model (imports mergeAudioRows + parser)", () => {
  const m = media();
  assert.ok(/import\s*\{[^}]*mergeAudioRows[^}]*\}\s*from\s*"\.\/track-merge"/.test(m),
    "media.ts must import mergeAudioRows from ./track-merge");
  assert.ok(/audioStreamsFromMediaInfo/.test(m),
    "media.ts must extract audio streams from media_info (audioStreamsFromMediaInfo)");
  assert.ok(/parseHlsAudioRenditions/.test(m),
    "media.ts must parse the HLS manifest's audio renditions");
});

test("MediaEngine fetches media_info for the file", () => {
  const m = media();
  assert.ok(/mediaInfo:\s*true/.test(m),
    "media.ts must request put.io media_info (the track source of truth)");
});

test("MediaEngine publishes audioPanelRows in its state", () => {
  const m = media();
  assert.ok(/audioPanelRows/.test(m),
    "MediaState must carry audioPanelRows (the merged model)");
  const sync = m.slice(m.indexOf("syncTracks("));
  assert.ok(/mergeAudioRows\(/.test(sync),
    "syncTracks must recompute the rows via mergeAudioRows on every input change");
});

test("MediaEngine listens to addtrack (not just change) on audioTracks", () => {
  const m = media();
  const bind = m.slice(m.indexOf("private bindTrackEvents("));
  assert.ok(/addEventListener\(\s*ev,/.test(bind) || /addEventListener\(\s*"addtrack"/.test(bind),
    "bindTrackEvents must listen for the LG addtrack event");
  assert.ok(/"change"\s*,\s*"addtrack"|"addtrack"/.test(bind),
    "bindTrackEvents must keep listening for change + addtrack");
});

test("MediaEngine selects by panel row (selectAudioRow)", () => {
  const m = media();
  assert.ok(/selectAudioRow\(/.test(m),
    "MediaEngine must expose selectAudioRow(row) — the panel is row-based, not index-based");
});

test("MediaState types: audioPanelRows is part of the contract", () => {
  const m = media();
  assert.ok(/audioPanelRows:\s*AudioPanelRow\[\]/.test(m),
    "MediaState must type audioPanelRows as AudioPanelRow[]");
});

// ---------------- Phase 4: HLS preselect by the picked language ----------------

test("MediaEngine preselects the remembered language when the HLS manifest lands", () => {
  const media = read("src/putio/media.ts");
  assert.ok(
    /lastAudioLang/.test(media),
    "the engine must remember the last audio language the user picked"
  );
  const manifest = media.slice(media.indexOf("MANIFEST_PARSED"));
  assert.ok(
    /pickHlsAudioTrackIndex\(/.test(manifest),
    "MANIFEST_PARSED must preselect the HLS track by the remembered language (a source switch must not reset the user's choice to the default)"
  );
  const sw = media.slice(media.indexOf("private switchToHlsForTrack"));
  assert.ok(
    /lastAudioLang\s*=/.test(sw),
    "switchToHlsForTrack must record the row's language for the HLS preselect"
  );
  assert.ok(
    !/private switchToHlsForTrack\(_row/.test(media),
    "switchToHlsForTrack must use its row parameter (no unused _row)"
  );
});

test("the engine: with no configured preference it must not force an audio track at all", () => {
  // the preference pick is engine-owned (the Player's old per-sync guard
  // is gone — it consumed its once-flag on the empty first track sync).
  // No preference = no auto-pick: setAudioPreference(null/"") must leave
  // prefLang null, and applyAudioPreference must not run.
  const media = read("src/putio/media.ts");
  const m = media.match(/setAudioPreference\(lang: string \| null\): void \{[\s\S]*?\n  \}/);
  assert.ok(m, "setAudioPreference must exist");
  assert.ok(
    /lang && lang\.length \? lang : null/.test(m[0]),
    "an empty/absent preference must normalize to null (no auto-pick)"
  );
  const a = media.match(/private applyAudioPreference\(\): void \{[\s\S]*?\n  \}/);
  assert.ok(a, "applyAudioPreference must exist");
  assert.ok(
    /if \(this\.prefApplied \|\| !this\.prefLang\) return;/.test(a[0]),
    "no preference = no pick (the file plays in its own language)"
  );
});

test("MediaEngine preselects the HLS language once the audio track list is final", () => {
  // MANIFEST_PARSED fires before hls.js loads the alternate audio
  // playlists (audio-eng.m3u8 / audio-spa.m3u8) — at that moment
  // hls.audioTracks is still empty, so the preselect must also run on
  // AUDIO_TRACKS_UPDATED, when the list is final (caught by the e2e:
  // the default English rendition kept playing after picking Spanish).
  const media = read("src/putio/media.ts");
  const slice = media.slice(media.indexOf("MANIFEST_PARSED"), media.indexOf("Events.ERROR"));
  assert.ok(
    /AUDIO_TRACKS_UPDATED/.test(slice),
    "the engine must listen for AUDIO_TRACKS_UPDATED to preselect the remembered language"
  );
});

test("MediaEngine preselects the HLS language once the audio track list actually exists", () => {
  // hls.js fires MANIFEST_PARSED BEFORE it loads the alternate audio
  // playlists — at that moment hls.audioTracks is empty, so preselecting
  // there is a no-op and the default (English) rendition stays on. The
  // engine must also (re)apply the remembered language when the audio
  // track list arrives (AUDIO_TRACKS_UPDATED) — caught by the e2e: after
  // picking "Spanish (DTS)", the eng segments kept playing.
  const media = read("src/putio/media.ts");
  const hls = media.slice(media.indexOf("MANIFEST_PARSED"));
  assert.ok(
    /AUDIO_TRACKS_UPDATED/.test(hls),
    "the engine must listen for AUDIO_TRACKS_UPDATED (the audio track list is only final then)"
  );
  assert.ok(
    /preselectHlsAudio/.test(hls),
    "the preselect must be a reusable step (called from both manifest and audio-tracks events)"
  );
});

// ---------------- Phase 5: honest panel states + auto-hls setting ----------------

test("Player: the audio panel lists the file's real streams (no 'Only one audio track' dead end)", () => {
  const player = read("src/ui/screens/Player.svelte");
  assert.ok(
    !/Only one audio track is available/.test(player),
    "the old dead-end string must be gone — the panel lists the file's real streams"
  );
  assert.ok(
    /1 audio track in this file/.test(player),
    "the single-track case must read '1 audio track in this file' (+ codec)"
  );
  assert.ok(
    /panelRowHint\(/.test(player),
    "the row state hint must come from the pure panelRowHint function"
  );
  assert.ok(
    !/function rowHint/.test(player),
    "the old inline rowHint ladder must be gone"
  );
});

test("MediaEngine: enterHlsForRow is the auto-hls entry point", () => {
  const media = read("src/putio/media.ts");
  const m = media.match(/enterHlsForRow\(row: AudioPanelRow\): void \{[\s\S]*?\n  \}/);
  assert.ok(m, "the engine must expose enterHlsForRow(row) for the auto-hls fallback");
  assert.ok(
    /switchToHlsForTrack\(row\)/.test(m[0]),
    "enterHlsForRow must go through switchToHlsForTrack (remembers the language, preserves position)"
  );
});

test("Player: a refused native switch ALWAYS falls back to the put.io stream (the setting is gone)", () => {
  // m00758: "remove 'If the original can't switch audio', use auto switch
  // as default" — the fallback is now unconditional; single-flight kept.
  const player = read("src/ui/screens/Player.svelte");
  const m = player.match(/function applyEngineState[\s\S]*?\n  \}/);
  assert.ok(m, "applyEngineState must exist");
  assert.ok(
    /enterHlsForRow/.test(m[0]),
    "on audioSwitchFailed the Player must route to the put.io stream (enterHlsForRow)"
  );
  assert.ok(
    !/audioFallback/.test(m[0]),
    "the fallback must no longer read the removed audioFallback setting"
  );
  assert.ok(
    /autoHlsTried/.test(player),
    "the auto-hls attempt must be single-flight (a second refusal toasts, it cannot loop)"
  );
});

test("Settings: the 'if the original can't switch audio' option is gone", () => {
  const settings = read("src/ui/screens/Settings.svelte");
  assert.ok(
    !/If the original can't switch audio/i.test(settings),
    "the card must be gone (m00758: the auto switch is the only behavior now)"
  );
  assert.ok(
    !/audioFallback/.test(settings),
    "Settings must not reference the removed audioFallback key"
  );
});

test("Player: a preference that matches no track is toasted (no more silence)", () => {
  const player = read("src/ui/screens/Player.svelte");
  const idx = player.indexOf("audioPrefMiss");
  assert.ok(idx !== -1, "the Player must read the engine's audioPrefMiss state");
  const tail = player.slice(idx, idx + 300);
  assert.ok(
    /platform\.toast/.test(tail),
    "the audioPrefMiss message must be toasted (the user's 'it never asks' complaint)"
  );
});

test("Player: the subtitle search asks for the UNION of the app's language and the account's", () => {
  const player = read("src/ui/screens/Player.svelte");
  assert.ok(
    /unionSubtitleLanguages/.test(player),
    "the Player must use unionSubtitleLanguages — the account list alone never requested the app-configured language"
  );
  assert.ok(
    /getSubtitles\(\s*au,\s*file\.id,\s*unionSubtitleLanguages\(\s*preferredSubLang,\s*subtitleLanguages\s*\)/.test(player),
    "ensureSubtitles must pass the union (the app-configured language first, then the put.io account's)"
  );
});
