/**
 * Progress-bar chapter markings (pure — no DOM/webOS imports, testable in
 * node). A file's own chapters (parsed by probeHeader, published on the
 * engine as subChapters) become one quiet hairline tick per chapter start
 * on the scrub track, and the bar's preview bubble — which already follows
 * the pointer (scrubHover) or the D-pad-focus playhead — additionally shows
 * the chapter's title when the bubble position is near a tick. That is the
 * TV translation of "hover a marking to see which chapter starts there".
 *
 * Only STARTS are used: real files omit ChapterTimeEnd (the Scrubs
 * 1616433948 auto-chapters), and ends are not needed to place a tick or to
 * decide "which chapter is near this position".
 */

export interface ChapterTick {
  /** seconds */
  start: number;
  /** 0–100 position on the track */
  pct: number;
  /** the chapter title ("" for untitled chapters — the tick renders, no label) */
  title: string;
}

/** A chapter as the engine publishes it; only start/title matter here. */
type ChapterLike = { start: number; title: string };

export function chapterTicks(
  chapters: readonly ChapterLike[] | null | undefined,
  duration: number
): ChapterTick[] {
  if (!chapters || !duration || !Number.isFinite(duration)) return [];
  const ticks: ChapterTick[] = [];
  for (const ch of chapters) {
    if (ch.start < 0 || ch.start >= duration) continue;
    ticks.push({
      start: ch.start,
      pct: (ch.start / duration) * 100,
      title: ch.title ?? "",
    });
  }
  return ticks;
}

/**
 * "Near a tick" threshold: max(15 s, 2% of the duration). 2% keeps the
 * window proportional on long files (a 2 h movie: ~2.4 min either side of a
 * tick — the tick spacing there is minutes anyway); the 15 s floor keeps a
 * deliberate thumb stop recognisable on short clips.
 */
function nearTickThreshold(duration: number): number {
  return Math.max(15, duration * 0.02);
}

/**
 * The chapter a bubble position belongs to for labelling: the NEAREST tick
 * within the threshold. Ties go to the earlier tick — that is the chapter
 * the playhead is inside. Null when no tick is near, or the nearest tick's
 * chapter has no title (honest: untitled chapters never get an invented
 * label — the bubble just shows the time).
 */
export function chapterAt(
  chapters: readonly ChapterLike[] | null | undefined,
  t: number,
  duration: number
): { index: number; title: string } | null {
  const ticks = chapterTicks(chapters, duration);
  if (!ticks.length || !Number.isFinite(t)) return null;
  const limit = nearTickThreshold(duration);
  let bestIndex = -1;
  let bestDist = Infinity;
  for (let index = 0; index < ticks.length; index++) {
    const dist = Math.abs(ticks[index].start - t);
    if (dist > limit) continue;
    // strict < keeps the EARLIER tick on an exact tie (the chapter the
    // playhead is inside)
    if (dist < bestDist) {
      bestDist = dist;
      bestIndex = index;
    }
  }
  if (bestIndex === -1) return null;
  const title = ticks[bestIndex].title;
  return title ? { index: bestIndex, title } : null;
}
