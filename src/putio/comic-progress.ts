/**
 * Per-comic reading progress (pure).
 *
 * A reader that always starts at page 1 is a viewer, not a reader: the last
 * page (and the reading direction) are remembered per comic file and survive
 * app restarts via localStorage. This module owns the STORAGE FORMAT and its
 * honesty: decoding corrupt or absent data yields `null` — never a throw —
 * because a reader that crashes on a bad JSON string is a reader that cannot
 * be trusted with the user's library.
 */
import type { Direction } from "./comic";

export interface ComicProgress {
  /** put.io file id — the identity of the comic. */
  file_id: number;
  /** File name (the shelf's display string). */
  name: string;
  /** Last-read page, 0-based. */
  page: number;
  /** Total pages known when the progress was saved. */
  total: number;
  /** Reading direction chosen for this comic. */
  direction: Direction;
  /** Epoch ms — the shelf orders by this (most recently read first). */
  updated_at: number;
}

export function encodeProgress(p: ComicProgress): string {
  return JSON.stringify(p);
}

function isNum(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/**
 * Decode a stored progress record. Anything that is not a well-formed
 * `ComicProgress` is `null`: not an object, wrong field types, a bogus
 * direction, or a page outside [0, total). Never throws.
 */
export function decodeProgress(s: string | null | undefined): ComicProgress | null {
  if (typeof s !== "string" || s === "") return null;
  let v: unknown;
  try {
    v = JSON.parse(s);
  } catch {
    return null;
  }
  if (v === null || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (!isNum(o.file_id) || !isNum(o.page) || !isNum(o.total) || !isNum(o.updated_at)) {
    return null;
  }
  if (typeof o.name !== "string") return null;
  if (o.direction !== "ltr" && o.direction !== "rtl") return null;
  if (!Number.isInteger(o.page) || !Number.isInteger(o.total)) return null;
  if (o.total <= 0 || o.page < 0 || o.page >= o.total) return null;
  return {
    file_id: o.file_id,
    name: o.name,
    page: o.page,
    total: o.total,
    direction: o.direction,
    updated_at: o.updated_at,
  };
}

/**
 * A remembered page against the book as it is NOW: clamped into
 * [0, total-1]. The book may have changed (a re-scan with fewer pages) —
 * the honest answer for a page past the end is the last page, and an empty
 * book has no page at all.
 */
export function clampResume(page: number, total: number): number {
  if (total <= 0) return 0;
  return Math.min(Math.max(page, 0), total - 1);
}
