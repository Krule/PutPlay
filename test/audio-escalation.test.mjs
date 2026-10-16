// Lifecycle regression for the native audio-switch ESCALATION in MediaEngine.
//
// The outer e2e (test/e2e, ?stubborn) caught this: after the first pick
// went through the full escalation (reload dance) and was CONFIRMED, the
// second pick did nothing at all — the switchingAudio guard flag was set
// but never cleared, silently locking out every later switch.
//
// This test drives the REAL MediaEngine (bundled) against a minimal fake
// <video> that mimics the webOS veto: writes are ignored until a full src
// reload re-arms the pipeline (exactly the behavior the e2e fake emulates).
// The hls.js import is stubbed — the native path never instantiates it.
//
// Run: pnpm test

import { build } from "esbuild";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const dir = mkdtempSync(join(tmpdir(), "putio-test-"));
const out = join(dir, "media.cjs");
const hlsStub = join(dir, "hls-stub.cjs");
writeFileSync(hlsStub, "module.exports = { default: class Hls {} };\n");

await build({
  entryPoints: ["src/putio/media.ts"],
  bundle: true,
  format: "cjs",
  platform: "node",
  outfile: out,
  alias: { "hls.js": hlsStub },
});
const { MediaEngine } = (() => {
  // platform.ts guards with isWebOS() at RUNTIME, but module-scope code in
  // the bundle references `window` — give node a minimal one.
  if (typeof globalThis.window === "undefined") globalThis.window = globalThis;
  return createRequire(import.meta.url)(out);
})();

// The constructor's media_info fetch must never hit the network in tests.
const realFetch = globalThis.fetch;
globalThis.fetch = () => Promise.reject(new Error("no network in unit tests"));

/** A track object whose `enabled` write is silently vetoed while the
 *  element's pipeline is "un-armed" (the webOS 6 stubborn behavior). */
function makeTrack(el, label, language, initiallyOn) {
  return {
    _e: initiallyOn,
    label,
    language,
    id: label,
    set enabled(v) {
      if (el._armed !== true) return; // the veto: assignment is a no-op
      this._e = !!v;
    },
    get enabled() {
      return this._e;
    },
  };
}

function makeTrackList(el) {
  const tracks = [
    makeTrack(el, "English (E-AC3)", "eng", true),
    makeTrack(el, "Spanish (AAC)", "spa", false),
  ];
  const list = tracks.slice();
  Object.defineProperty(list, "length", { value: tracks.length });
  return list;
}

/** The C1's EAAAO exposure: the webview gives NO language code and NO
 *  usable label for the tracks — the file's real facts (titles, codes)
 *  arrive only via put.io's media_info. */
function makeBareTrackList(el) {
  const tracks = [makeTrack(el, "", "", true), makeTrack(el, "", "", false)];
  const list = tracks.slice();
  Object.defineProperty(list, "length", { value: tracks.length });
  return list;
}

/** A global-fetch stub returning the EAAAO-shaped media_info for the
 *  file's media_info request (the only URL the engine may need in these
 *  tests); everything else rejects like the default no-network stub.
 *  Response shape = put.io's ({ status, file: {...} }), read via text() */
function metaInfoStub(delay = 0) {
  return (url) => {
    const u = String(url);
    if (u.indexOf("media_info") !== -1) {
      return new Promise((resolve) =>
        setTimeout(() => {
          resolve({
            ok: true,
            status: 200,
            text: () =>
              Promise.resolve(
                JSON.stringify({
                  status: "ok",
                  file: {
                    id: 9,
                    name: "multi-audio-9.mkv",
                    media_info: {
                      streams: [
                        { codec_type: "video", codec_name: "hevc", tags: {} },
                        {
                          codec_type: "audio",
                          codec_name: "ac3",
                          channels: 6,
                          tags: { language: "ita", title: "Italiano AC-3 5.1" }
                        },
                        {
                          codec_type: "audio",
                          codec_name: "ac3",
                          channels: 6,
                          tags: { language: "eng", title: "English AC-3 5.1" }
                        }
                      ]
                    }
                  }
                })
              )
          });
        }, delay)
      );
    }
    return Promise.reject(new Error("no network in unit tests"));
  };
}

/** Minimal fake <video>: event registry, stubborn audioTracks that re-arm
 *  on a full src reload (load() after the src was re-set), position.
 *
 *  options.strippedReloadDies — an src re-set made right after a
 *    removeAttribute (the dance's own reload) fails: the webview's
 *    pipeline cannot survive a mid-session strip, but a plain re-set
 *    (no strip) recovers. options.allReloadsDie — every src re-set fails
 *    (a genuinely dead stream). */
function makeFakeVideo(options = {}) {
  const el = {
    _reloads: 0,
    audioTracks: undefined, // populated below unless startWithNoTracks
    _armed: false, // stubborn: fresh session vetoes enabled writes
    _listeners: {},
    paused: false,
    currentTime: 42,
    volume: 1,
    _src: "blob:fake/9",
    addEventListener(t, fn) {
      (this._listeners[t] = this._listeners[t] || []).push(fn);
    },
    removeEventListener(t, fn) {
      this._listeners[t] = (this._listeners[t] || []).filter((f) => f !== fn);
    },
    dispatch(t) {
      (this._listeners[t] || []).slice().forEach((f) => f());
    },
    // Faithful to a real element: pausing/playing fire events. (The TV can
    // pause the element WITHOUT the app's knowledge — e.g. a system volume
    // change re-negotiating the audio pipeline — and the engine must notice.)
    pause() {
      this.paused = true;
      this.dispatch("pause");
    },
    play() {
      this.paused = false;
      this.dispatch("playing");
      return Promise.resolve();
    },
    error: null,
    _stripped: false,
    removeAttribute() {
      this._src = "";
      this._stripped = true;
      // the real element errors when its src is stripped mid-session —
      // exactly what the dance triggers (and what the engine's fallback
      // handler must NOT treat as fatal during a dance)
      this.error = { code: 4 };
      this.dispatch("error");
    },
    // NOTE: a PLAIN load() does NOT re-arm — the real stubborn webview
    // vetoes enabled writes even right after a fresh source load (that's
    // why a single write at startup never worked). Only the dance's
    // strip+re-set re-evaluates the pipeline (the Stremio mechanism).
    load() {
      /* plain reload: the veto persists */
    },
    get src() {
      return this._src;
    },
    set src(v) {
      this._src = v;
      this.error = null; // a fresh load resets the error state
      if (!v) return;
      this._reloads += 1;
      const dies =
        options.allReloadsDie ||
        (options.strippedReloadDies && this._stripped === true);
      this._lastWasStripped = this._stripped === true;
      this._stripped = false;
      if (dies) {
        // the reload itself fails: the element errors, no metadata
        setTimeout(() => {
          this.error = { code: 4 };
          this.dispatch("error");
        }, 5);
      } else {
        // a fresh load populates a NEW audioTracks list and fires metadata;
        // only a STRIP reload (the dance) re-arms the vetoed pipeline
        if (this._lastWasStripped) this._armed = true;
        setTimeout(() => {
          this.audioTracks = options.bareTracks
            ? makeBareTrackList(this)
            : makeTrackList(this);
          this.dispatch("loadedmetadata");
        }, 5);
      }
    },
  };
  if (!options.startWithNoTracks)
    el.audioTracks = options.bareTracks ? makeBareTrackList(el) : makeTrackList(el);
  return el;
}

/** Collect engine state patches; resolve when a predicate holds or timeout. */
function recorder() {
  const patches = [];
  let resolveWait = null;
  const seen = (p) => {
    patches.push(p);
    if (resolveWait) resolveWait(p);
  };
  const waitFor = (label, pred, ms = 15000) =>
    new Promise((resolve, reject) => {
      const t = setTimeout(
        () => reject(new Error(`timeout waiting for state (${label})`)),
        ms
      );
      resolveWait = (p) => {
        if (pred(p)) {
          clearTimeout(t);
          resolveWait = null;
          resolve(p);
        }
      };
      for (const p of patches) {
        if (pred(p)) {
          clearTimeout(t);
          resolve(p);
          return;
        }
      }
    });
  return { patches, seen, waitFor };
}

test("escalation: stubborn pick lands via the dance, and the NEXT pick still works", async () => {
  const video = makeFakeVideo();
  const rec = recorder();
  const engine = new MediaEngine(
    video,
    { id: 9, is_mp4_available: true },
    { token: "t", scope: "files" },
    { onState: rec.seen }
  );

  try {
    // Pick 1 (Spanish): every write is vetoed until the reload dance
    engine.setAudioTrack(1);
    await rec.waitFor(
      "pick1",
      (p) =>
        (p.audioTrack === 1 && p.audioSwitching === false) || p.audioSwitchFailed,
      20000
    );
    const confirmed1 = rec.patches.some((p) => p.audioTrack === 1);
    assert.ok(
      confirmed1,
      "the stubborn pick must be confirmed after the escalation (not audioSwitchFailed)"
    );
    assert.ok(
      rec.patches.some((p) => p.audioSwitching === true),
      "the escalation must publish audioSwitching (panel 'Switching…')"
    );
    const at = video.audioTracks;
    assert.deepEqual(
      [at[0].enabled, at[1].enabled],
      [false, true],
      "read-back: Spanish must actually be the enabled track"
    );
    // position survived the dance
    assert.ok(Math.abs(video.currentTime - 42) <= 1.5, `position preserved (got ${video.currentTime})`);

    // Pick 2 (English): the guard flag must have cleared — this is the
    // regression the e2e caught (second pick silently did nothing).
    // the guard must already be released when the confirm state is
    // observable — a pick made immediately after must not be swallowed
    assert.equal(
      engine.switchingAudio,
      false,
      "switchingAudio must clear with the terminal state"
    );
    engine.setAudioTrack(0);
    await rec.waitFor(
      "pick2",
      (p) =>
        (p.audioTrack === 0 && p.audioSwitching === false) || p.audioSwitchFailed,
      20000
    );
    assert.ok(
      rec.patches.some((p) => p.audioTrack === 0),
      "the second pick must be confirmed too (switchingAudio guard must clear)"
    );
    const at2 = video.audioTracks;
    assert.deepEqual(
      [at2[0].enabled, at2[1].enabled],
      [true, false],
      "read-back: English must actually be enabled again"
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});


test("the dance survives an element error from the src strip (no source fallback)", async () => {
  // the dance strips src — the element fires `error`. The engine's onError
  // fallback chain must not treat THAT as a dead stream (it would switch to
  // the MP4/HLS source mid-dance — the reported regression).
  const video = makeFakeVideo();
  const rec = recorder();
  const engine = new MediaEngine(
    video,
    { id: 9, is_mp4_available: true },
    { token: "t", scope: "files" },
    { onState: rec.seen }
  );
  try {
    engine.setAudioTrack(1); // full escalation → the dance (stubborn fake)
    await rec.waitFor(
      "dance",
      (p) =>
        (p.audioTrack === 1 && p.audioSwitching === false) || p.audioSwitchFailed,
      20000
    );
    assert.ok(
      rec.patches.some((p) => p.audioTrack === 1),
      "the pick must be confirmed even though the element errored during the dance"
    );
    assert.ok(
      !rec.patches.some((p) => p.error),
      "the dance's src strip must not surface a playback error"
    );
    assert.ok(
      !rec.patches.some((p) => p.source !== undefined),
      "the dance must not trigger the source fallback chain"
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("a dance whose reload dies restores the ORIGINAL (no transcode jump, no dead player)", async () => {
  // The webview's pipeline cannot survive the dance's strip+reload: the
  // re-set fails and the element is left erroring. The stream was ALIVE
  // before the pick — so neither degrading to the mp4 transcode nor
  // leaving a dead player is acceptable: the engine must reload the SAME
  // source once (a plain re-set, no strip), which recovers.
  const video = makeFakeVideo({ strippedReloadDies: true });
  const rec = recorder();
  const engine = new MediaEngine(
    video,
    { id: 9, is_mp4_available: true },
    { token: "t", scope: "files" },
    { onState: rec.seen }
  );
  try {
    engine.setAudioTrack(1);
    await rec.waitFor(
      "fail",
      (p) => p.audioSwitchFailed,
      20000
    );
    await new Promise((r) => setTimeout(r, 1500)); // let recovery run
    const sources = rec.patches
      .filter((p) => p.source !== undefined)
      .map((p) => p.source);
    assert.ok(
      !sources.includes("mp4") && !sources.includes("hls"),
      `a failed dance must not degrade to the transcode (got: ${sources.join(", ") || "no source change"})`
    );
    assert.ok(
      video._reloads >= 2,
      "the original source must have been reloaded after the dance's reload died"
    );
    assert.ok(
      !video.error,
      "the element must be clean after recovery (the plain reload succeeded)"
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("if the post-dance restore also dies, the fallback chain still runs", async () => {
  // A genuinely dead stream (every reload fails) must still reach the
  // fallback chain — the recovery attempt is a single chance, not a loop.
  const video = makeFakeVideo({ allReloadsDie: true });
  const rec = recorder();
  const engine = new MediaEngine(
    video,
    { id: 9, is_mp4_available: true },
    { token: "t", scope: "files" },
    { onState: rec.seen }
  );
  try {
    engine.setAudioTrack(1);
    await rec.waitFor(
      "fail",
      (p) => p.audioSwitchFailed,
      20000
    );
    await new Promise((r) => setTimeout(r, 2500)); // let recovery + fallback run
    const sources = rec.patches
      .filter((p) => p.source !== undefined)
      .map((p) => p.source);
    assert.ok(
      sources.includes("mp4"),
      `a stream that is still dead after the restore must fall back (got: ${sources.join(", ") || "no source change"})`
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("the configured audio preference is applied to the FIRST REAL track list", async () => {
  // The engine's first sync happens before the pipeline exposes tracks
  // (src set → bindTrackEvents → empty list). Consuming the once-flag on
  // that empty sync left the preference unapplied — the reported bug:
  // preferred language + auto-switch configured, file still plays in its
  // own language. The engine applies the preference to the first
  // NON-EMPTY list, escalating exactly like a user pick.
  const video = makeFakeVideo({ startWithNoTracks: true });
  const rec = recorder();
  const engine = new MediaEngine(
    video,
    { id: 9, is_mp4_available: true },
    { token: "t", scope: "files" },
    { onState: rec.seen }
  );
  try {
    engine.setAudioPreference("spa");
    engine.setSource("original");
    await rec.waitFor(
      "pref-land",
      (p) => p.audioTrack === 1 && p.audioSwitching === false,
      20000
    );
    const sources = rec.patches
      .filter((p) => p.source !== undefined)
      .map((p) => p.source);
    assert.ok(
      !sources.includes("mp4") && !sources.includes("hls"),
      "a preference must not change the source"
    );
    assert.ok(
      rec.patches.some((p) => p.audioPickKind === "preference" && p.audioPickIndex === 1),
      "the terminal patch must mark the preference pick (the Player's auto-hls wiring depends on it)"
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("a preference matching no track leaves the default track alone", async () => {
  const video = makeFakeVideo();
  const rec = recorder();
  const engine = new MediaEngine(
    video,
    { id: 9, is_mp4_available: true },
    { token: "t", scope: "files" },
    { onState: rec.seen }
  );
  try {
    engine.setAudioPreference("fre"); // not in the file
    engine.setSource("original");
    await rec.waitFor("pref-miss", (p) => p.audioPrefMiss, 8000).catch(() => null);
    assert.ok(
      !rec.patches.some((p) => p.audioSwitching === true),
      "a non-matching preference must not escalate"
    );
    assert.deepEqual(
      [video.audioTracks[0].enabled, video.audioTracks[1].enabled],
      [true, false],
      "the file's own default track keeps playing"
    );
    const miss = rec.patches.find((p) => p.audioPrefMiss);
    assert.ok(
      miss && /fre/.test(miss.audioPrefMiss),
      "a non-matching preference must be ANNOUNCED (the old silence is the reported bug)"
    );
    assert.ok(
      miss.audioPrefMiss.indexOf("English (E-AC3)") !== -1,
      "the announcement must list what the file DOES have so the user can verify"
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});

// ---------------- EAAAO on the C1 (round 5b) ----------------
//
// Real TV: the subtitle preference works (put.io codes are clean) but the
// audio preference does nothing. The difference: audio matching used to
// depend on the WEBVIEW's audioTracks, and for this MKV the webview
// exposes no language code and no usable label. The file's real facts
// arrive via put.io's media_info (that's where the panel rows' titles
// come from). The preference must match the MERGED ROW MODEL — what the
// user sees in the panel — and must defer the match while the metadata
// fetch is still in flight.

test("preference matches the file's metadata when the webview exposes no language or label (EAAAO on the C1)", async () => {
  const video = makeFakeVideo({ startWithNoTracks: true, bareTracks: true });
  globalThis.fetch = metaInfoStub(0);
  const rec = recorder();
  const engine = new MediaEngine(
    video,
    { id: 9, is_mp4_available: true },
    { token: "t", scope: "files" },
    { onState: rec.seen }
  );
  try {
    engine.setAudioPreference("eng");
    engine.setSource("original");
    await rec.waitFor(
      "pref-land",
      (p) => p.audioTrack === 1 && p.audioSwitching === false,
      20000
    );
    const sources = rec.patches
      .filter((p) => p.source !== undefined)
      .map((p) => p.source);
    assert.ok(
      !sources.includes("mp4") && !sources.includes("hls"),
      "a preference must not change the source"
    );
    assert.deepEqual(
      [video.audioTracks[0].enabled, video.audioTracks[1].enabled],
      [false, true],
      "read-back: the English track (matched via media_info) must actually be enabled"
    );
    assert.ok(
      rec.patches.some((p) => p.audioPickKind === "preference" && p.audioPickIndex === 1),
      "the terminal patch must mark the preference pick"
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("the preference defers while media_info is in flight, then matches (slow network)", async () => {
  // The track list arrives in ~5 ms; the metadata settles 80 ms later.
  // Consuming the preference at the first (meta-less) match attempt would
  // silently miss — the C1's exact failure shape.
  const video = makeFakeVideo({ startWithNoTracks: true, bareTracks: true });
  globalThis.fetch = metaInfoStub(80);
  const rec = recorder();
  const engine = new MediaEngine(
    video,
    { id: 9, is_mp4_available: true },
    { token: "t", scope: "files" },
    { onState: rec.seen }
  );
  try {
    engine.setAudioPreference("eng");
    engine.setSource("original");
    await rec.waitFor(
      "pref-land",
      (p) => p.audioTrack === 1 && p.audioSwitching === false,
      20000
    );
    assert.deepEqual(
      [video.audioTracks[0].enabled, video.audioTracks[1].enabled],
      [false, true],
      "the deferred preference must still land on the English track"
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("an unplayable source (error code 4) is EXPLAINED, not just swapped", async () => {
  // code 4 = the webview can't decode the source AT ALL (the real case:
  // 4K HEVC Main 10 + Dolby Vision on the webOS simulator — the file is
  // fine on the real TV). The fallback must still run, but the published
  // error has to say WHY: the fallback's own setSource clears the error
  // from the panel before the user can read "Playback error".
  const video = makeFakeVideo();
  const rec = recorder();
  const engine = new MediaEngine(
    video,
    { id: 9, is_mp4_available: true },
    { token: "t", scope: "files" },
    { onState: rec.seen }
  );
  try {
    video.error = { code: 4 };
    video.dispatch("error");
    await rec.waitFor("fallback", (p) => p.source === "mp4", 5000);
    const errPatches = rec.patches.filter((p) => p.error).map((p) => p.error);
    assert.ok(
      errPatches.some((m) => /decode|not supported/i.test(m || "")),
      `the code-4 error state must explain the decode failure (got: ${JSON.stringify(errPatches)})`
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("a refused preference never re-escalates in a loop (recovery resets the arming)", async () => {
  // The recovery path (a failed dance reloads the SAME source via
  // setSource) re-arms the preference — the next track sync would
  // re-apply it and escalate again: dance dies → recover → re-escalate,
  // forever, on a file whose webview can't survive the dance. A failed
  // PREFERENCE escalation must consume the preference for this source
  // load (the user can still pick explicitly; the setting re-arms on the
  // next source load).
  const video = makeFakeVideo({ strippedReloadDies: true });
  const rec = recorder();
  const engine = new MediaEngine(
    video,
    { id: 9, is_mp4_available: true },
    { token: "t", scope: "files" },
    { onState: rec.seen }
  );
  try {
    engine.setAudioPreference("spa");
    engine.setSource("original");
    await rec.waitFor("fail", (p) => p.audioSwitchFailed, 20000);
    await new Promise((r) => setTimeout(r, 3500)); // time for a (wrong) 2nd escalation
    const switches = rec.patches.filter((p) => p.audioSwitching === true).length;
    assert.ok(
      switches <= 1,
      `the refused preference must not re-escalate (escalations seen: ${switches})`
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("escalation: a pick while one is in flight is ignored, not queued", () => {
  // source-contract: the single-flight guard must exist on BOTH entry
  // points (selectAudioRow and runNativeSwitch) so a double pick during
  // the dance can't start a second escalation
  const src = readFileSync("src/putio/media.ts", "utf8");
  const guardCount = src.split("this.switchingAudio) return").length - 1;
  assert.ok(
    guardCount >= 2,
    `expected the switchingAudio guard at both entry points, found ${guardCount}`
  );
});

// ---------------------------------------------------------------------------
// TV-side pauses (the volume key)
// On webOS the remote's volume rocker is handled by the SYSTEM — the app never
// sees it. But a volume change can make the webview pause the <video> element
// on its own (the audio pipeline re-negotiates). A pause nobody requested is
// not a user pause: the engine must resume it. A pause that WAS requested
// (blue key) must stick.
// ---------------------------------------------------------------------------

test("a pause the engine did not request (TV side, e.g. a volume change) auto-resumes", async () => {
  const video = makeFakeVideo();
  const engine = new MediaEngine(
    video,
    { id: 1, is_mp4_available: false },
    { token: "t", scope: "files" },
    { onState: () => {} }
  );
  engine.setSource("original");
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(video.paused, false, "must be playing before the simulated TV pause");
  // The webview pauses the element on its own — no user gesture involved,
  // exactly what a system volume change can do on webOS.
  video.pause();
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(
    video.paused,
    false,
    "the engine must resume a pause it did not request (a volume-key pause must not stop playback)"
  );
});

test("a user pause (blue key) is never auto-resumed", async () => {
  const video = makeFakeVideo();
  const engine = new MediaEngine(
    video,
    { id: 1, is_mp4_available: false },
    { token: "t", scope: "files" },
    { onState: () => {} }
  );
  engine.setSource("original");
  await new Promise((r) => setTimeout(r, 30));
  engine.pause();
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(video.paused, true, "a user-requested pause must stick");
});

test("a pause storm from the TV is bounded and recovers", async () => {
  const video = makeFakeVideo();
  let plays = 0;
  const rawPlay = video.play.bind(video);
  video.play = () => {
    plays++;
    return rawPlay();
  };
  const engine = new MediaEngine(
    video,
    { id: 1, is_mp4_available: false },
    { token: "t", scope: "files" },
    { onState: () => {} }
  );
  engine.setSource("original");
  await new Promise((r) => setTimeout(r, 30));
  const baseline = plays;
  // The TV holds the element paused for a beat (a long volume press).
  for (let i = 0; i < 3; i++) {
    video.pause();
    await new Promise((r) => setTimeout(r, 15));
  }
  const extra = plays - baseline;
  assert.ok(extra <= 3, `at most one resume attempt per TV pause (saw ${extra})`);
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(video.paused, false, "must end up playing once the TV stops holding it");
});

// ---------------------------------------------------------------------------
// Stream stalls (issue: the original stream "suffers from interruptions")
// A STALL = a waiting event DURING playback (after the first frame). The
// initial load's buffering is normal, not a stall. The engine reports the
// per-source count in state so the Player can advise — once — about the
// smoother engine-buffered stream (the native buffer itself is webview-owned
// and cannot be grown from HTML5).
// ---------------------------------------------------------------------------

test("stalls: counted only during playback, reported in state, reset per source", async () => {
  const video = makeFakeVideo();
  const rec = recorder();
  // autoplay blocked: the element has NOT delivered its first frame yet
  video.play = () => Promise.reject(new Error("autoplay blocked"));
  const engine = new MediaEngine(
    video,
    { id: 1, is_mp4_available: false },
    { token: "t", scope: "files" },
    { onState: (p) => rec.seen(p) }
  );
  engine.setSource("original");
  await new Promise((r) => setTimeout(r, 30));
  // pre-first-frame buffering is a normal load — NOT a stall (a stalls: 0
  // reset patch from the source load is fine; a COUNT is not)
  video.dispatch("waiting");
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(
    !rec.patches.some((p) => (p.stalls ?? 0) > 0),
    "waiting before the first frame must not count as a stall"
  );
  // playback starts (first frame) — from here on, waiting = interruption
  video.play = () => {
    video.paused = false;
    video.dispatch("playing");
    return Promise.resolve();
  };
  video.dispatch("playing");
  video.dispatch("waiting");
  video.dispatch("waiting");
  await new Promise((r) => setTimeout(r, 10));
  let last = rec.patches.filter((p) => p.stalls !== undefined).pop();
  assert.equal(last.stalls, 2, "mid-playback stalls are counted and reported in state");
  // a fresh source load: the count starts over
  engine.setSource("original");
  await new Promise((r) => setTimeout(r, 30));
  video.dispatch("waiting");
  await new Promise((r) => setTimeout(r, 10));
  last = rec.patches.filter((p) => p.stalls !== undefined).pop();
  assert.equal(last.stalls, 1, "a new source load resets the stall count");
});
