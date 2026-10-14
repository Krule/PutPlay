/**
 * The video SESSION — app-level state, like the music session.
 *
 * The docked-video architecture (plan §9.1): the Player screen stays the
 * owner of the <video> element and its MediaEngine, and it stays mounted
 * for the whole session. This store is the session's spine — which file,
 * which queue, and which mode the chrome is in. Docking (full → mini →
 * micro) is a CHROME change: nothing here stops the media, and nothing
 * here must tear the engine down.
 *
 * Transport (play/pause/seek) deliberately does not live here: the dock's
 * controls are rendered by the Player, so they reach the engine directly.
 */
import { writable, get } from "svelte/store";
import type { PutFile } from "../putio/types";
import { stepQueue } from "../putio/queue";

export type VideoMode = "full" | "mini" | "micro";

export interface VideoSession {
  file: PutFile;
  /** The folder's playable videos, listing order — auto-next walks it. */
  queue: PutFile[];
  index: number;
  mode: VideoMode;
}

const video = writable<VideoSession | null>(null);
export { video };

/** Open a video: a fresh session in the full player. */
export function startVideoSession(file: PutFile, queue: PutFile[], index: number): void {
  video.set({ file, queue, index, mode: "full" });
}

/** Dock / restore / shrink. The session (and the Player's engine) is
 *  untouched — the media keeps playing through the chrome change. */
export function setVideoMode(mode: VideoMode): void {
  const s = get(video);
  if (s) video.set({ ...s, mode });
}

/** Close (the ✕'s job): end the session. The Player unmounts and destroys
 *  its engine; the music caps record is of course never touched. */
export function endVideoSession(): void {
  video.set(null);
}

/** Auto-next: step to the next video in the queue. At the end of the queue
 *  the session is left as-is (the Player shows the finished state — end of
 *  queue is a STOP, not a wrap, same rule as music). */
export function advanceVideo(): void {
  const s = get(video);
  if (!s) return;
  const next = stepQueue(s.index, s.queue.length, 1);
  if (next === null || !s.queue[next]) return;
  video.set({ ...s, file: s.queue[next], index: next });
}

/** Manual walk (the dock's prev/next). Edges are a no-op — same rule as
 *  music. The Player reacts to the changed file (fresh engine, the old one
 *  is destroyed on the way). */
export function stepVideo(dir: -1 | 1): void {
  const s = get(video);
  if (!s) return;
  const next = stepQueue(s.index, s.queue.length, dir);
  if (next === null || !s.queue[next]) return;
  video.set({ ...s, file: s.queue[next], index: next });
}
