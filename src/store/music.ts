import { writable, get } from "svelte/store";
import { platform, store } from "../webos/platform";
import { MediaEngine, type MediaState } from "../putio/media";
import type { Auth } from "../putio/api";
import type { PutFile } from "../putio/types";
import { applyProbe, isFamilyUnsupported, audioFamily, type CapRecord } from "../putio/audio-capable";
import { stepQueue } from "../putio/queue";

/**
 * The persistent music session, module-level.
 *
 * Why module-level (the comic-shelf pattern): music is NOT a screen. The
 * user starts a track in the library and then moves — folders, images,
 * comics, settings — and the music must survive every one of those screen
 * swaps. A screen-owned engine dies with the unmount; the service owns the
 * engine and the App shell owns the element, so navigation never touches
 * the session. Only stopMusic() (and the video's claim on the single
 * output) ends it.
 *
 * v1 shape (music-plan §2, with the risk note): the video player keeps its
 * own screen-owned element; music gets a persistent hidden <video> at the
 * App shell with its own MediaEngine. One engine, one output — starting a
 * video stops the music, and starting a music file while the Player is up
 * is not reachable (different screens). The full single-engine lift is the
 * documented follow-up.
 */

export interface MusicState {
  file: PutFile;
  queue: PutFile[];
  index: number;
  /** The expanded now-playing panel is open (the strip stays either way). */
  expanded: boolean;
  /** The strip's presentation — the user's choice (ladder parity with the
   *  docked video). The reading screens override it to "micro" (App). */
  mode: "strip" | "micro";
  /** The folder's cover (a cover.jpg/png sibling) stream URL, or null. */
  cover: string | null;
  /** The engine's media state (position, duration, buffering, error…). */
  ms: Partial<MediaState>;
}

export const music = writable<MusicState | null>(null);

let el: HTMLVideoElement | null = null;
let engine: MediaEngine | null = null;
/** The engine is per-file, so a track change builds a fresh one — the auth
 *  rides along with the session, not with each call. */
let sessionAuth: Auth | null = null;

/** The App shell registers its persistent (hidden) media element once.
 *  The element ALSO gets the decode-veto listener: a code-4 error is the
 *  TV saying "I can't play this" — record the family and say so, instead
 *  of letting the video player's fallback ladder flail on an audio file. */
export function registerMusicElement(node: HTMLVideoElement): void {
  if (el === node) return;
  el = node;
  node.addEventListener("error", () => {
    const m = get(music);
    const code = el && el.error ? (el.error as MediaError).code : 0;
    if (code === 4 && m) {
      const fam = audioFamily(m.file);
      recordMusicProbe(fam, false);
      platform.toast(`This TV can't play .${fam} files`);
      stopMusic();
    }
  });
}

/** Replace whatever is on the element with this file's original stream
 *  (a fresh engine: the MediaEngine is built around one file). */
function openTrack(file: PutFile, auth: Auth): void {
  if (!el) return;
  if (engine) engine.destroy();
  // the first clean play proves this TV decodes the family (probe-on-
  // first-try — the record is per-TV truth, music-plan §1)
  let okProbed = false;
  engine = new MediaEngine(
    el,
    { id: file.id, is_mp4_available: false, start_from: file.start_from },
    auth,
    {
      onState: (s) => {
        music.update((m) => (m ? { ...m, ms: { ...m.ms, ...s } } : m));
        if (s.buffering === false && !okProbed) {
          okProbed = true;
          recordMusicProbe(audioFamily(file), true);
        }
      },
      // track end → the next one (or stop at the end of the queue)
      onEnded: () => {
        const cur = get(music);
        const i = cur ? stepQueue(cur.index, cur.queue.length, 1) : null;
        if (i === null) stopMusic();
        else if (cur) loadIndex(cur, i);
      },
    }
  );
  // music never leaves the original source: put.io has no audio transcode,
  // so there is no fallback ladder to fall into on a decode failure
  engine.setSource("original");
}

/** Start (or replace) the session on the given file of the queue. */
export function startMusic(file: PutFile, queue: PutFile[], index: number, auth: Auth, cover: string | null = null): void {
  if (!el) return;
  sessionAuth = auth;
  music.set({ file, queue, index, expanded: false, mode: "strip", cover, ms: { buffering: true } });
  openTrack(file, auth);
}

/** Stop the session and release the element. The only way out besides the
 *  video claiming the output. */
export function stopMusic(): void {
  if (engine) {
    engine.destroy();
    engine = null;
  }
  music.set(null);
}

export function nextMusic(): void {
  const m = get(music);
  if (!m) return;
  const i = stepQueue(m.index, m.queue.length, 1);
  if (i === null) return; // manual next at the end stays (auto-advance stops)
  loadIndex(m, i);
}

export function prevMusic(): void {
  const m = get(music);
  if (!m) return;
  const i = stepQueue(m.index, m.queue.length, -1);
  if (i === null) return; // manual prev at the start stays
  loadIndex(m, i);
}

function loadIndex(m: MusicState, i: number): void {
  const file = m.queue[i];
  music.set({ ...m, file, index: i, expanded: false, ms: { buffering: true } });
  if (sessionAuth) openTrack(file, sessionAuth);
}

export function toggleMusic(): void {
  engine?.togglePlayPause();
}

/** The transport keys (rewind/fast-forward on the remote) seek the music. */
export function seekMusic(delta: number): void {
  engine?.skip(delta);
}

export function setExpanded(v: boolean): void {
  music.update((m) => (m ? { ...m, expanded: v } : m));
}

/** The strip's presentation: the full bar, or the icon-only corner row
 *  (ladder parity with the docked video: strip ↔ micro). */
export function setMusicMode(mode: "strip" | "micro"): void {
  music.update((m) => (m ? { ...m, mode } : m));
}

/* ---------------- the TV's decode-capability record ----------------
 *
 * Per-TV truth, not per-account: the C1's decoder doesn't care which put.io
 * account you signed in with, so the record deliberately survives sign-out
 * (unlike the comic shelf or the cover thumbs). Written by the play attempt
 * that proved it (music-plan §1: probe-on-first-try, remember per family).
 */
const CAPS_KEY = "putio.audioCaps";
let caps: CapRecord = {};
let capsLoaded = false;

/** Load the remembered record once per session (App onMount). */
export async function loadCaps(): Promise<void> {
  if (capsLoaded) return;
  capsLoaded = true;
  caps = await store.get<CapRecord>(CAPS_KEY, {});
}

/** Record the outcome of a real play attempt for this family. */
export function recordMusicProbe(family: string, ok: boolean): void {
  if (!family) return;
  caps = applyProbe(caps, family, ok);
  void store.set(CAPS_KEY, caps);
}

/** True only when THIS TV vetoed the family on a real attempt. */
export function audioUnsupported(family: string): boolean {
  return isFamilyUnsupported(caps, family);
}
