/**
 * File chapters → skip segments (pure — no DOM/webOS imports, testable in
 * node). The uploader's OWN chapter boundaries (MKV Editions, parsed by
 * probeHeader and published on the engine as subChapters) are the most
 * authoritative skip data for a given file: this module turns the
 * intro/recap/credits chapters into the skip engine's Seg shape and
 * merges them with the per-episode database (TheIntroDB/consensus) —
 * the file wins type by type, the database fills the types the file
 * has no chapter for.
 */

import type { Chapter } from "./probe";
import type { Seg, SegType } from "./introdb";

/**
 * Which segment type a chapter title names, or null when it's a content
 * chapter (Episode, Part 1, …). Matching is deliberately loose on the
 * recognised words ("(Intro)", "INTRO", "End Credits") but never matches
 * content markers — a false positive would skip real content.
 */
export function chapterTitleToSegType(title: string): SegType | null {
  const t = (title ?? "")
    .toLowerCase()
    .replace(/^[^a-z0-9]+/, "")
    .replace(/[^a-z0-9]+$/, "");
  if (!t) return null;
  if (/^intro/.test(t) || /^opening/.test(t)) return "intro";
  if (/recap/.test(t) || /^preview/.test(t)) return "recap";
  if (/credit/.test(t) || /^ending/.test(t) || /^outro/.test(t) || /^end\b/.test(t))
    return "credits";
  return null;
}

/**
 * The intro/recap/credits chapters, as skip segments (sorted by start).
 * Garbage (negative start, end not after start) is dropped, never guessed.
 * A chapter with no end (end 0 in the probe result) only means "runs to
 * the end of the media" for credits — that is how end credits are
 * chaptered. For intro/recap a missing end would skip to the end of the
 * WHOLE media, so those are dropped (the Scrubs 1616433948 shape: auto
 * "Chapter NN" entries carry no ends at all).
 */
export function chaptersToSegs(chapters: Chapter[] | null | undefined): Seg[] {
  const segs: Seg[] = [];
  for (const ch of chapters ?? []) {
    const type = chapterTitleToSegType(ch.title);
    if (!type) continue;
    const start = ch.start;
    let end = ch.end;
    if (start < 0 || (end > 0 && end <= start)) continue;
    if (end <= 0) {
      if (type !== "credits") continue; // no known skip target
      end = null; // credits run to the end of the media
    }
    segs.push({ type, start, end });
  }
  return segs.sort((a, b) => a.start - b.start);
}

/**
 * The merge rule: for every type the FILE covers, the database's segments
 * of that type are dropped (the uploader drew the boundaries for this
 * file); database types the file has no chapter for survive. Sorted by
 * start — freshSkip walks the list in order.
 */
export function mergeChapterSegs(fileSegs: Seg[] | null | undefined, dbSegs: Seg[] | null | undefined): Seg[] {
  const file = fileSegs ?? [];
  const fileTypes = new Set(file.map((s) => s.type));
  const merged: Seg[] = [
    ...file,
    ...(dbSegs ?? []).filter((s) => !fileTypes.has(s.type)),
  ];
  return merged.sort((a, b) => a.start - b.start);
}
