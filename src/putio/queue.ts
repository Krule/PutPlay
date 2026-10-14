import type { PutFile } from "./types";
import { isAudioFile, type AudioLike } from "./audio-capable";

/**
 * The music queue: the folder the user is IN, filtered to audio, in listing
 * order (the library store already sorted it). One folder = one queue —
 * cross-folder playlists are deliberately out of scope (see music-plan §5).
 */

export interface MusicQueue {
  queue: PutFile[];
  /** Position of the file the user opened (0 when it is not in the folder —
   *  e.g. a file opened from a deeper listing; playback still works, the
   *  walk just has no neighbours). */
  index: number;
}

export function buildMusicQueue(files: PutFile[], current: PutFile): MusicQueue {
  const queue = files.filter((f) => isAudioFile(f));
  const index = Math.max(0, queue.findIndex((f) => f.id === current.id));
  return { queue, index };
}

/* ---------------- the video queue (the dock's auto-next walks it) ----------------
 *
 * The sibling of the music queue: the folder's playable VIDEOS in listing
 * order. Audio deliberately stays out — it belongs to the music queue, and
 * a folder of films should not auto-advance into the soundtracks.
 */

const VIDEO_EXT = /\.(mp4|mkv|avi|mov|m4v|webm)$/i;

/** True when the file is video the Player screen plays (as opposed to
 *  music/folder/image). A declared content type outranks the name. */
export function isPlayableVideo(f: AudioLike): boolean {
  const ct = (f.content_type || "").toLowerCase();
  if (ct === "application/x-directory" || ct.startsWith("audio/")) return false;
  if (ct.startsWith("video/")) return true;
  return VIDEO_EXT.test(f.name || "");
}

export interface VideoQueue {
  queue: PutFile[];
  index: number;
}

export function buildVideoQueue(files: PutFile[], current: PutFile): VideoQueue {
  const queue = files.filter((f) => isPlayableVideo(f));
  const index = Math.max(0, queue.findIndex((f) => f.id === current.id));
  return { queue, index };
}

/**
 * Step the queue by dir (±1). Returns the new index, or null at the edge —
 * end of queue is a STOP (owner's call, music-plan §7.3), not a wrap.
 */
export function stepQueue(index: number, count: number, dir: -1 | 1): number | null {
  const next = index + dir;
  return next < 0 || next >= count ? null : next;
}
