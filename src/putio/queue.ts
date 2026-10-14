import type { PutFile } from "./types";
import { isAudioFile } from "./audio-capable";

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

/**
 * Step the queue by dir (±1). Returns the new index, or null at the edge —
 * end of queue is a STOP (owner's call, music-plan §7.3), not a wrap.
 */
export function stepQueue(index: number, count: number, dir: -1 | 1): number | null {
  const next = index + dir;
  return next < 0 || next >= count ? null : next;
}
