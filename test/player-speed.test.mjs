// OUTER acceptance test: playback speed — a v1 player feature.
//
// The story: the Player shows a stateful speed icon (current rate) and a
// menu (0.5 / 0.75 / 1 / 1.25 / 1.5 / 2). The engine exposes ONE method
// the Player calls with the picked rate. The speed lives on the <video>
// element — playbackRate, with pitch preserved (playbackPreservesPitch:
// a TV player keeps its voices, not a chipmunk). The Player owns the state
// (icon + menu) and re-applies it per file: a new engine per file, the
// engine does not persist. VOD-only: the Player simply won't offer the
// menu on live streams (the engine method is live-safe, the menu is not).
//
// The contract this test pins (driving the REAL MediaEngine on a minimal
// fake <video> — same harness as segment-skip.test.mjs):
//   1. setSpeed sets the video's playbackRate
//   2. setSpeed preserves pitch (a TV player, not a chipmunk)
//   3. the default rate is untouched — picking 1× is an identity, not a
//      jump (the element's own default is 1)
//   4. the last pick wins: two successive setSpeed calls (1.5 then 0.75)
//      leave 0.75 — the Player re-applies per file, there is no
//      accumulation in the engine
//
// Run: pnpm vitest run test/player-speed.test.mjs
// media.ts pulls platform.ts → webostvjs: the window + localStorage shims
// (imported first) must exist before those modules load.
import "./shims/node-webos.mjs";
import { vi, test } from "vitest";
import assert from "node:assert/strict";
import { MediaEngine } from "../src/putio/media.ts";

// The fake <video> drives the engine — hls.js is stubbed, as the old
// esbuild alias did.
vi.mock("hls.js", () => ({ default: class Hls {} }));

// The engine's constructor fires a non-fatal media_info fetch — any
// network here is a test bug, so reject loudly.
globalThis.fetch = () => Promise.reject(new Error("no network in unit tests"));

const AUTH = { oauthToken: "tok", downloadToken: null };
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

/** Minimal fake <video>: event registry, position, and the playback-rate
 *  properties the speed feature writes (the element's own default rate is
 *  1 — like a real <video>). */
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
    playbackRate: 1, // the element's own default
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

/** Deliver metadata with a known duration. */
function meta(el, duration) {
  el.duration = duration;
  el.dispatch("loadedmetadata");
  el.dispatch("canplay");
}

/** A fresh engine on the original source (the Player's first move), with
 *  the file's metadata delivered (speed is a VOD feature). */
function makeEngine(file) {
  const el = makeFakeVideo();
  const engine = new MediaEngine(el, file, AUTH, {
    onState: () => {},
    onSourceChange: () => {},
    onEnded: () => {},
  });
  engine.setSource("original");
  meta(el, 3000);
  return { el, engine };
}

test("setSpeed sets the video's playbackRate", async () => {
  const { el, engine } = makeEngine({ id: 1, start_from: 0 });
  await tick();
  engine.setSpeed(1.5);
  assert.equal(el.playbackRate, 1.5);
});

test("setSpeed preserves pitch (a TV player, not a chipmunk)", async () => {
  const { el, engine } = makeEngine({ id: 1, start_from: 0 });
  await tick();
  engine.setSpeed(2);
  assert.equal(el.playbackPreservesPitch, true);
});

test("the default rate is untouched (picking 1× is an identity, not a jump)", async () => {
  const { el, engine } = makeEngine({ id: 1, start_from: 0 });
  await tick();
  assert.equal(el.playbackRate, 1); // the element's own default, before any pick
  engine.setSpeed(1);
  assert.equal(el.playbackRate, 1); // the pick lands exactly on the default
});

test("the last pick wins (1.5 then 0.75 leaves 0.75 — no accumulation)", async () => {
  const { el, engine } = makeEngine({ id: 1, start_from: 0 });
  await tick();
  engine.setSpeed(1.5);
  engine.setSpeed(0.75);
  assert.equal(el.playbackRate, 0.75);
});
