/**
 * The info panel's "Up next" — PURE queue resolution, no network (locked
 * design): the file the player's auto-next is about to play. The session's
 * video queue (the folder's playable videos, listing order) is walked the
 * same way advanceVideo does (stepQueue; end of queue is a STOP, not a
 * wrap). The next file must PARSE as an episode to be shown — a movie or an
 * unparseable name yields no Up next (the info-tab module omits the
 * action). Returns exactly what buildInfoPanel consumes.
 */

import type { PutFile } from "./types";
import { stepQueue } from "./queue";
import { parseEpisode } from "./titles";
import type { UpNext } from "./info-tab";

/**
 * The Up next for the file at `index` in `queue`, or null: no queue, end of
 * the queue, or a next file that is not an identifiable episode.
 */
export function upNext(queue: PutFile[] | null | undefined, index: number): UpNext | null {
  if (!queue || !queue.length) return null;
  const next = stepQueue(index, queue.length, 1);
  if (next === null) return null;
  const file = queue[next];
  if (!file) return null;
  const episode = parseEpisode(file.name);
  if (!episode) return null;
  return { season: episode.season, episode: episode.episode, title: episode.title };
}
