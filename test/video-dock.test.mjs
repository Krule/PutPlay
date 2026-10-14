// OUTER acceptance test: the docked video player (mini/micro ladder).
//
// The story (owner's words, 2026-10-14): media keeps playing, regardless of
// type, once you leave the big player — the video moves to a MINI player
// (docked, visible, playing), can be shrunk to a MICRO player (icons only),
// and restoring it returns to the full player remembering where we were;
// exiting lands back where the full screen was entered from.
//
// The contract this test pins (plan §9.1, .agents/music-plan.md):
//   1. the video is an app-level SESSION: open → full; the session persists
//      through mode changes — docking is a chrome change, never a stop
//   2. the video queue holds the folder's playable VIDEOS (audio stays out)
//   3. the App renders the Player from the session (overlay when docked),
//      not from an exclusive "player" screen
//   4. the Player exposes the ladder controls (restore/micro/close, restore)
//      and Back-in-full docks instead of leaving
//   5. a "Play next in folder" setting (default on) gates video auto-next
//
// The session store is engine-free (the Player keeps owning the element +
// MediaEngine — plan §9.1 architecture), so it runs here without a fake
// element. The visual dock is verified in the browser pass.
//
// Run: npm test
import { build } from "esbuild";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { get } from "svelte/store";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const read = (p) => readFileSync(join(root, p), "utf8");

// ---------------- harness (same shape as music-player.test.mjs) ----------------

const dir = mkdtempSync(join(tmpdir(), "putio-vdock-"));
const out = join(dir, "vdock.cjs");
const hlsStub = join(dir, "hls-stub.cjs");
writeFileSync(hlsStub, "module.exports = { default: class Hls {} };\n");
const entry = join(dir, "entry.ts");
writeFileSync(
  entry,
  [
    `export * from "${resolve(root, "src/putio/queue.ts")}";`,
    `export * from "${resolve(root, "src/store/video.ts")}";`,
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
const { isPlayableVideo, buildVideoQueue, video, startVideoSession, setVideoMode, endVideoSession, advanceVideo, stepVideo } =
  await import(out);

// ---------------- fixtures ----------------

const vid = (id, name = "film.mkv", ct = "video/x-matroska") => ({
  id,
  name,
  size: 123456,
  content_type: ct,
  parent_id: 0,
  is_folder: 0,
  start_from: 0,
});
const song = (id, name = "track.flac", ct = "audio/flac") => ({
  id,
  name,
  size: 123456,
  content_type: ct,
  parent_id: 0,
  is_folder: 0,
  start_from: 0,
});
const folder = (id, name = "Folder") => ({
  id,
  name,
  size: 0,
  content_type: "application/x-directory",
  parent_id: 0,
  is_folder: 1,
  start_from: 0,
});

// ---------------- 1 · the session: docking never stops the media ----------------

test("opening a video starts a full-mode session", () => {
  endVideoSession();
  const q = [vid(1), vid(2)];
  startVideoSession(q[1], q, 1);
  const s = get(video);
  assert.equal(s.mode, "full");
  assert.equal(s.file.id, 2);
  assert.equal(s.index, 1);
  assert.deepEqual(s.queue.map((f) => f.id), [1, 2]);
});

test("docking to mini keeps the session alive (the media continues)", () => {
  endVideoSession();
  const q = [vid(1), vid(2)];
  startVideoSession(q[0], q, 0);
  setVideoMode("mini");
  const s = get(video);
  assert.ok(s, "the session must survive the dock — the video keeps playing");
  assert.equal(s.mode, "mini");
  assert.equal(s.file.id, 1, "same file, same queue, same position");
  assert.deepEqual(s.queue.map((f) => f.id), [1, 2]);
});

test("mini → micro → mini walks the ladder; close ends the session", () => {
  endVideoSession();
  const q = [vid(1)];
  startVideoSession(q[0], q, 0);
  setVideoMode("mini");
  setVideoMode("micro");
  assert.equal(get(video).mode, "micro");
  setVideoMode("mini");
  assert.equal(get(video).mode, "mini");
  endVideoSession();
  assert.equal(get(video), null);
});

test("mode changes with no session are a no-op", () => {
  endVideoSession();
  setVideoMode("mini"); // must not throw or resurrect a session
  assert.equal(get(video), null);
});

test("advance: next video in the queue; end of queue is a stop, not a wrap", () => {
  endVideoSession();
  const q = [vid(1), vid(2), vid(3)];
  startVideoSession(q[0], q, 0);
  advanceVideo();
  assert.equal(get(video).file.id, 2);
  assert.equal(get(video).index, 1);
  advanceVideo();
  advanceVideo();
  assert.equal(get(video).file.id, 3, "still on the last video");
  assert.equal(get(video).index, 2);
});

test("stepVideo: manual walk both directions; edges are a no-op (music parity)", () => {
  endVideoSession();
  const q = [vid(1), vid(2), vid(3)];
  startVideoSession(q[1], q, 1);
  stepVideo(-1);
  assert.equal(get(video).file.id, 1);
  assert.equal(get(video).index, 0);
  stepVideo(-1); // first edge: no-op
  assert.equal(get(video).index, 0);
  stepVideo(1);
  stepVideo(1);
  assert.equal(get(video).file.id, 3);
  stepVideo(1); // last edge: no-op
  assert.equal(get(video).index, 2);
});

// ---------------- 2 · the video queue: the folder's playable videos ----------------

test("isPlayableVideo: videos in, audio and folders out", () => {
  assert.equal(isPlayableVideo(vid(1)), true);
  assert.equal(isPlayableVideo(vid(2, "movie.mp4", "application/octet-stream")), true);
  assert.equal(isPlayableVideo(song(3)), false, "audio is the music queue's job");
  assert.equal(isPlayableVideo(folder(4)), false);
});

test("buildVideoQueue: playable videos in listing order, index of the opened file", () => {
  const files = [vid(1), song(2), vid(3, "b.mkv"), folder(4), vid(5, "c.mp4")];
  const opened = files[2]; // b.mkv
  const { queue, index } = buildVideoQueue(files, opened);
  assert.deepEqual(queue.map((f) => f.id), [1, 3, 5]);
  assert.equal(index, 1);
});

test("buildVideoQueue: a file not in the queue still plays (index 0)", () => {
  const files = [vid(1), vid(2)];
  const { queue, index } = buildVideoQueue(files, vid(99));
  assert.deepEqual(queue.map((f) => f.id), [1, 2]);
  assert.equal(index, 0);
});

// ---------------- 3 · the App renders the Player from the session ----------------

test("App renders the Player from the video session, not an exclusive screen", () => {
  const app = read("src/ui/App.svelte");
  assert.match(app, /from "\.\.\/store\/video"/, "App owns the video session state");
  assert.match(app, /\{#if \$video\}/, "the session drives the Player's presence");
  assert.match(app, /<Player[^\n]*mode=/, "the Player is told which mode to render");
  assert.ok(
    !/\{:else if screen === "player"/.test(app),
    "the old exclusive 'player' screen branch is gone"
  );
});

// ---------------- 4 · the Player exposes the ladder ----------------

test("Player: a mode prop, Back-in-full docks, the ladder controls exist", () => {
  const p = read("src/ui/screens/Player.svelte");
  assert.match(p, /export let mode:/, "the Player renders per-mode chrome");
  assert.match(p, /\$: session = \$videoStore;/, "the session VALUE (auto-subscription), not the store object");
  assert.match(p, /setVideoMode\("full"\)/, "restore goes back to the full player");
  assert.match(p, /setVideoMode\("micro"\)/, "mini can shrink to micro");
  assert.match(p, /endVideoSession\(/, "close ends the session (the ✕'s job)");
  assert.match(p, /aria-label="Close player"/, "the close button exists");
  assert.match(p, /aria-label="Make it micro"/, "mini offers the shrink");
  assert.match(p, /aria-label="Restore to full"/, "mini restores to full");
  assert.match(p, /aria-label="Restore to mini"/, "micro restores to mini");
  // the micro dock must carry its own close: in the shared dock markup the
  // micro restore branch precedes the close button
  const restoreMini = p.indexOf('aria-label="Restore to mini"');
  const close = p.indexOf('aria-label="Close player"');
  assert.ok(restoreMini !== -1 && close !== -1 && restoreMini < close, "micro's close sits after micro's restore (same dock)");
  // Back-in-full docks: the onBack path changes mode only — never the engine
  const onBackBody = p.match(/function onBack\(\) \{[\s\S]*?\n  \}/)?.[0] || "";
  assert.match(onBackBody, /setVideoMode\("mini"\)/, "Back in full docks (it does not leave)");
  assert.ok(!/destroy\(\)/.test(onBackBody), "the dock path never tears the engine down");
});

// ---------------- 5 · video auto-next is a setting, default on ----------------

test("config: 'Play next in folder' exists and defaults on", () => {
  const cfg = read("src/putio/config.ts");
  assert.match(cfg, /playNext/, "the setting lives in the config state");
  assert.match(cfg, /playNext:\s*true/, "default: on (owner's call)");
});

test("Player: a finished video advances only when the setting is on", () => {
  const p = read("src/ui/screens/Player.svelte");
  assert.match(p, /playNext/, "onEnded consults the setting");
});

test("Settings: the 'Play next in folder' toggle exists", () => {
  const s = read("src/ui/screens/Settings.svelte");
  assert.match(s, /playNext/, "the toggle binds the setting");
  assert.match(s, /[Pp]lay next in folder/, "labelled in the user's words");
});

test("the dock is styled with theme.css (shared chrome, auditable)", () => {
  const css = read("src/ui/theme.css");
  assert.match(css, /\.player\.docked/, "the docked frame lives in the shared theme");
  assert.match(css, /\.dock-btn/);
  assert.match(css, /\.player\.docked\.micro \.video\s*\{[^}]*display:\s*none/, "micro hides the video (out-specifying the scoped .video rule)");
});

test("the docked frame is positioned by the shared theme, not the Player's scoped rule", () => {
  // The scoped .player rule (injected into <head> AFTER theme.css, equal
  // (0,2,0) weight) won the cascade on top/left/right/bottom: the mini sat
  // top-left and micro (all four insets 0, auto size) went full-screen black.
  // The frame base lives in theme.css with a clean ladder:
  // .player (0,1,0) < .player.docked (0,2,0) < .player.docked.micro (0,3,0).
  const css = read("src/ui/theme.css");
  assert.match(css, /\.player\s*\{[^}]*position:\s*absolute/s, "the frame base is in the shared theme");
  assert.match(css, /\.player\s*\{[^}]*z-index:\s*50/s, "the full player covers the background it stays mounted under");
  const docked = css.match(/\.player\.docked\s*\{[^}]*\}/s);
  assert.ok(docked, ".player.docked exists");
  for (const decl of ["top: auto", "left: auto", "right: 48px", "bottom: 48px", "width: 400px"]) {
    assert.ok(docked[0].includes(decl), `.player.docked must declare ${decl}`);
  }
  const style = read("src/ui/screens/Player.svelte").split("<style>")[1] || "";
  assert.doesNotMatch(style, /\.player\s*\{[^}]*position/s,
    "the Player's scoped style must not position the frame (a tie it wins by source order)");
});

test("micro sizes the frame to its icon row, bottom-right (not full-screen)", () => {
  const css = read("src/ui/theme.css");
  assert.match(css, /\.player\.docked\.micro\s*\{[^}]*width:\s*auto/s, "the frame sheds the 400x225 box");
  assert.match(css, /\.player\.docked\.micro\s*\{[^}]*height:\s*auto/s);
  assert.match(css, /\.player\.docked\.micro \.dock\s*\{[^}]*position:\s*static/s,
    "the row is in-flow so the frame shrinks to it and keeps the .docked corner");
});

test("the background stays mounted under the full player (Back-after-restore)", () => {
  // Unmounting the background on full raced the Player's re-assert: the
  // Library's onDestroy cleared the remote handlers the Player had just set,
  // and Back died until the next re-assert. The full player COVERS the
  // background (z-index 50) instead of replacing it.
  const app = read("src/ui/App.svelte");
  assert.doesNotMatch(app, /\{#if !\(\$video && \$video\.mode === "full"\)/,
    "the background must not be conditional on the player's mode");
});

test("focus scope can exclude a subtree (the docked player while a reading screen is up)", () => {
  // A docked player's buttons stay mouse-clickable (magic remote), but must
  // never catch a D-pad move from the comic/image: the reading screen owns
  // the arrows. The exclusion is a LIVE SELECTOR, not an element reference —
  // the docked player appears and disappears under the reading screen.
  const src = read("src/webos/remote.ts");
  assert.match(src, /setFocusScope\(root: HTMLElement \| null,\s*excludeSelector\?: string \| null\)/,
    "setFocusScope must accept an exclusion selector");
  const cands = src.slice(src.indexOf("private candidates"));
  assert.ok(cands.includes("this.exclude"), "candidates() must consult the scope exclusion");
  assert.match(cands, /closest\(this\.exclude\)/, "the exclusion must be evaluated live per candidate");
});

test("a mouse-click on a scope-excluded element acts but does not steal spatial focus", () => {
  // The docked player's buttons are clicked with the magic remote while a
  // reading screen is up: the click must run the button's action (DOM click
  // does that natively) but must NOT mark the element as the spatially
  // focused one — with the dock excluded from candidates there would be no
  // D-pad move that could ever bring focus back.
  const src = read("src/webos/remote.ts");
  const act = src.slice(src.indexOf("activate(el: HTMLElement"));
  assert.match(act, /closest\(this\.exclude\)/, "activate must consult the scope exclusion");
  assert.match(act, /if\s*\(\s*!\s*outsideScope\s*\)\s*this\.setActive/, "only in-scope elements may take the spatial focus");
});
