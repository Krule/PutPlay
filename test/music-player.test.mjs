// OUTER acceptance test: music playback with a persistent now-playing player.
//
// The story (owner's words): the browser plays any format the TV decodes, and
// once music starts it STAYS while the user uses the app — browsing the
// library, opening images, reading comics. Music is not a screen; it is an
// app-level service over the same MediaEngine the video player uses, with a
// persistent (hidden) <video> element at the App shell.
//
// The contract this test pins (plan §6, .agents/music-plan.md):
//   1. playing a music file starts audio and exposes the now-playing state
//   2. app navigation does not stop it (nothing but stopMusic ends it)
//   3. next/prev walk the folder queue
//   4. a track ending advances automatically; end of queue stops
//   5. close stops and removes the state
//   6. starting a video stops the music (one engine, one output)
//   7. a format the TV can't decode is remembered per family
//
// The engine is the REAL MediaEngine (bundled), driven by a minimal fake
// <video>. The hls.js import is stubbed — music never leaves the original
// source (put.io doesn't transcode audio). The visual strip is verified in
// the e2e pass; this test pins the behavior the strip renders.
//
// Run: npm test
import { build } from "esbuild";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { get } from "svelte/store";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const read = (p) => readFileSync(join(root, p), "utf8");

// ---------------- harness (same shape as audio-escalation.test.mjs) ----------------

const dir = mkdtempSync(join(tmpdir(), "putio-music-"));
const out = join(dir, "music.cjs");
const hlsStub = join(dir, "hls-stub.cjs");
writeFileSync(hlsStub, "module.exports = { default: class Hls {} };\n");
// one generated entry re-exports the modules under test (store/music.ts
// pulls media.ts → platform.ts → webostvjs, all bundled for node)
const entry = join(dir, "entry.ts");
writeFileSync(
  entry,
  [
    `export * from "${resolve(root, "src/putio/audio-capable.ts")}";`,
    `export * from "${resolve(root, "src/putio/queue.ts")}";`,
    `export * from "${resolve(root, "src/store/music.ts")}";`,
  ].join("\n")
);

await build({
  entryPoints: [entry],
  bundle: true,
  format: "cjs",
  platform: "node",
  outfile: out,
  alias: { "hls.js": hlsStub },
  logLevel: "silent",
});
const {
  isAudioFile,
  audioFamily,
  applyProbe,
  isFamilyUnsupported,
  buildMusicQueue,
  stepQueue,
  music,
  registerMusicElement,
  startMusic,
  stopMusic,
  nextMusic,
  prevMusic,
  recordMusicProbe,
  audioUnsupported,
} = (() => {
  if (typeof globalThis.window === "undefined") globalThis.window = globalThis;
  // platform.store falls back to localStorage on node — give it an in-memory one
  const mem = new Map();
  globalThis.localStorage = {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => void mem.set(k, String(v)),
    removeItem: (k) => void mem.delete(k),
  };
  return createRequire(import.meta.url)(out);
})();

// The engine's media_info fetch must never hit the network in tests.
globalThis.fetch = () => Promise.reject(new Error("no network in unit tests"));

const AUTH = { oauthToken: "tok", downloadToken: null };
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

/** Minimal fake <video>: enough surface for MediaEngine (event registry,
 *  src, load/play/pause, position) — nothing audio-track-specific, music
 *  never switches tracks. */
function makeFakeVideo() {
  const el = {
    _listeners: {},
    _src: "",
    paused: true,
    currentTime: 0,
    duration: 214,
    buffered: { length: 0, end: () => 0 },
    error: null,
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
      this.paused = true;
      this.dispatch("pause");
    },
    play() {
      this.paused = false;
      this.dispatch("playing");
      return Promise.resolve();
    },
    load() {},
    removeAttribute() {
      this._src = "";
    },
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

const track = (id, name) => ({
  id,
  name,
  size: 1_000_000,
  content_type: "audio/flac",
  parent_id: 1,
});

const FOLDER = [
  { id: 1, name: "Subs", size: 0, content_type: "application/x-directory", parent_id: 0 },
  track(10, "01 - Open.flac"),
  track(11, "02 - Middle.flac"),
  { id: 12, name: "movie", size: 9, content_type: "video/mp4", parent_id: 1 },
  track(13, "03 - Close.flac"),
  { id: 14, name: "art", size: 9, content_type: "image/jpeg", parent_id: 1 },
];

// a fresh session per test: stop any music and a clean element
function fresh() {
  stopMusic();
  const el = makeFakeVideo();
  registerMusicElement(el);
  return el;
}

// ---------------- 1. start ----------------

test("playing a music file starts audio and exposes the now-playing state", async () => {
  const el = fresh();
  const q = buildMusicQueue(FOLDER, track(11, "02 - Middle.flac"));
  assert.equal(q.index, 1, "the opened file is position 1 of the audio queue");
  startMusic(
    track(11, "02 - Middle.flac"),
    q.queue,
    q.index,
    AUTH,
    "https://api.put.io/v2/files/99/stream?oauth_token=tok"
  );
  await tick();
  const m = get(music);
  assert.ok(m, "the now-playing state exists");
  assert.equal(m.file.id, 11);
  assert.equal(m.index, 1);
  assert.ok(m.cover?.includes("/files/99/stream"), "the folder cover rides with the state");
  assert.equal(el.src, "https://api.put.io/v2/files/11/stream?oauth_token=tok",
    "the ORIGINAL stream is the source (no transcode for audio)");
  assert.equal(el.paused, false, "audio is playing");
});

// ---------------- 2. persistence across navigation ----------------

test("app navigation does not stop the music (only stopMusic ends a session)", async () => {
  const el = fresh();
  const q = buildMusicQueue(FOLDER, track(10, "01 - Open.flac"));
  startMusic(q.queue[0], q.queue, q.index, AUTH);
  await tick();
  // what the App does while the user moves around: rebuild targets, rebuild
  // queues, step pure state — none of it may touch the running session
  const again = buildMusicQueue(FOLDER, track(13, "03 - Close.flac"));
  stepQueue(again.index, again.queue.length, 1);
  assert.ok(get(music), "the state survived the navigation-shaped work");
  assert.equal(el.paused, false, "audio still playing");
  assert.ok(String(el.src).includes("/files/10/stream"), "same file, still its stream");
  stopMusic();
});

// ---------------- 3. queue walking ----------------

test("next/prev walk the folder queue in listing order", async () => {
  const el = fresh();
  const q = buildMusicQueue(FOLDER, track(10, "01 - Open.flac"));
  startMusic(q.queue[0], q.queue, q.index, AUTH);
  await tick();
  nextMusic();
  await tick();
  assert.equal(get(music).index, 1);
  assert.ok(String(el.src).includes("/files/11/stream"), "next = the next audio file");
  prevMusic();
  await tick();
  assert.equal(get(music).index, 0);
  assert.ok(String(el.src).includes("/files/10/stream"), "prev returns");
  // manual prev at the first track stays put — ONLY auto-advance at the
  // end of the queue stops (a manual edge is a no-op, not a shutdown)
  prevMusic();
  await tick();
  assert.equal(get(music).index, 0, "manual prev at the first track stays");
  assert.ok(get(music), "…and the session lives");
  stopMusic();
});

test("the queue holds audio only, in listing order", () => {
  const q = buildMusicQueue(FOLDER, track(13, "03 - Close.flac"));
  assert.deepEqual(q.queue.map((f) => f.id), [10, 11, 13]);
  assert.equal(q.index, 2);
  assert.equal(stepQueue(2, 3, 1), null, "past the last track there is no next (stop)");
  assert.equal(stepQueue(0, 3, -1), null, "before the first track there is no prev (stop)");
});

// ---------------- 4. auto-advance ----------------

test("a track ending advances automatically; end of queue stops", async () => {
  const el = fresh();
  const q = buildMusicQueue(FOLDER, track(10, "01 - Open.flac"));
  startMusic(q.queue[0], q.queue, q.index, AUTH);
  await tick();
  el.dispatch("ended");
  await tick();
  assert.equal(get(music).index, 1, "ended → next track");
  assert.ok(String(el.src).includes("/files/11/stream"));
  // jump to the last track and end it
  nextMusic();
  await tick();
  assert.equal(get(music).index, 2);
  el.dispatch("ended");
  await tick();
  assert.equal(get(music), null, "the last track ending stops the music");
  assert.equal(el.src, "", "the element was released");
});

// ---------------- 5. close ----------------

test("close stops and removes the now-playing state", async () => {
  const el = fresh();
  const q = buildMusicQueue(FOLDER, track(10, "01 - Open.flac"));
  startMusic(q.queue[0], q.queue, q.index, AUTH);
  await tick();
  stopMusic();
  assert.equal(get(music), null);
  assert.equal(el.src, "", "destroy releases the element's source");
});

// ---------------- 6. video exclusivity ----------------

test("starting a different music file replaces the running session", async () => {
  const el = fresh();
  const q = buildMusicQueue(FOLDER, track(10, "01 - Open.flac"));
  startMusic(q.queue[0], q.queue, q.index, AUTH);
  await tick();
  startMusic(track(13, "03 - Close.flac"), q.queue, 2, AUTH);
  await tick();
  assert.equal(get(music).file.id, 13);
  assert.ok(String(el.src).includes("/files/13/stream"), "one element, one output — the new file owns it");
  stopMusic();
});

test("the App routes audio to the music service and stops music for video (source gate)", () => {
  const app = read("src/ui/App.svelte");
  assert.ok(/isAudioFile\(/.test(app), "App classifies the opened file with isAudioFile");
  assert.ok(/startMusic\(/.test(app), "App starts the music service for audio files");
  assert.ok(/stopMusic\(\)/.test(app), "App stops the music when a video starts (one output)");
});

test("immersive screens trap focus to themselves (the strip must not catch D-pad arrows there)", () => {
  // on the comic and image screens the arrows PAN the content — a strip
  // button reachable from there steals every downward move. The screens
  // scope the spatial remote to their own root (the strip sits at the App
  // level, outside any screen root, so the scope excludes it) and lift the
  // scope again on unmount (the library keeps the strip reachable).
  for (const screen of ["src/ui/screens/Comic.svelte", "src/ui/screens/Image.svelte"]) {
    const src = read(screen);
    assert.ok(/setFocusScope\(/.test(src), `${screen} must set a focus scope`);
    assert.ok(
      /setFocusScope\(null\)/.test(src),
      `${screen} must lift the focus scope on unmount`
    );
  }
  // the library stays UNSCOPED — D-pad down from the last row reaches the strip
  assert.ok(!/setFocusScope\(/.test(read("src/ui/screens/Library.svelte")),
    "the library must not scope focus (the strip is reachable there by design)");
});

// ---------------- 7. the decode-capability record ----------------

test("an undecodable format is remembered per family (unknown ≠ unsupported)", () => {
  let rec = {};
  rec = applyProbe(rec, "wvpack", false);
  rec = applyProbe(rec, "flac", true);
  assert.equal(isFamilyUnsupported(rec, "wvpack"), true, "the vetoed family is remembered");
  assert.equal(isFamilyUnsupported(rec, "flac"), false, "a working family is not");
  assert.equal(isFamilyUnsupported(rec, "aiff"), false, "an UNTRIED family is not unsupported");
});

test("the capability record persists across sessions (per-TV truth)", async () => {
  fresh();
  recordMusicProbe("wvpack", false);
  await tick();
  const stored = globalThis.localStorage.getItem("putio.audioCaps");
  assert.ok(stored, "the record is written to the persistent store");
  assert.equal(audioUnsupported("wvpack"), true, "the running session sees its own record");
  assert.equal(audioUnsupported("opus"), false, "unrecorded families stay open");
  stopMusic();
});

test("the audio classification is honest about what it means", () => {
  assert.equal(isAudioFile({ content_type: "audio/mpeg" }), true, "audio/* content type");
  assert.equal(isAudioFile({ content_type: "audio/x-m4a" }), true);
  assert.equal(isAudioFile({ content_type: "application/octet-stream", name: "song.flac" }), true,
    "put.io sometimes lies about content type — the extension is the fallback");
  assert.equal(isAudioFile({ content_type: "video/mp4", name: "clip.mp4" }), false);
  assert.equal(isAudioFile({ content_type: "application/x-directory", name: "band" }), false,
    "a folder is never audio");
  assert.equal(audioFamily({ content_type: "audio/flac", name: "a.flac" }), "flac",
    "the family is the extension — the probe key the TV's decoder answers to");
  assert.equal(audioFamily({ content_type: "audio/unknown", name: "x.unknown" }), "unknown");
});
