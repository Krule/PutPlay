/**
 * Row-local D-pad navigation for the player chrome — the row the user
 * expects (LG remote, 2026-10-17):
 *
 *   ICON row      [source][audio][subs][speed]
 *   TRANSPORT row [rewind][play][forward]
 *   + the wide scrub BAR above the transport row
 *
 * left/right moves to the ADJACENT key inside the row. At the END of a
 * row the move goes to the scrub bar — except at the user's dead ends:
 *   icon row:    right end (speed)  → scrub bar;  left end (source)  → dead end
 *   transport:   left end (rewind) → scrub bar;   right end (forward) → dead end
 *
 * The spatial engine can't express this: it normalizes a candidate's
 * distance by the candidate's WIDTH, so the wide centered bar (x≈640)
 * beats the adjacent keys in the toward-center direction ("left anywhere
 * on the icon row jumps to the bar", "right from forward jumps to the
 * bar"). The Player therefore CONSUMES left/right for these rows (even
 * at the dead ends) and asks rowStep. Pure: key + direction in, a key /
 * "scrub" / null out — no DOM, no geometry.
 */
export const ICON_ROW = ["source", "audio", "subs", "speed"] as const;
export const TRANSPORT_ROW = ["rewind", "play", "forward"] as const;

export type RowKey = (typeof ICON_ROW)[number] | (typeof TRANSPORT_ROW)[number];

const ROWS: readonly (readonly RowKey[])[] = [ICON_ROW, TRANSPORT_ROW];

/** The row (left → right) the key belongs to, or null (not a row key —
 *  the scrub bar and the skip pill are not row keys). */
export function rowOf(key: string): readonly RowKey[] | null {
  for (const row of ROWS) {
    if ((row as readonly string[]).includes(key)) return row;
  }
  return null;
}

export function isRowKey(key: string): boolean {
  return rowOf(key) !== null;
}

/**
 * One left/right step for a row key: the adjacent key; the scrub bar at
 * the row's LIVE end; null at the user's DEAD END (a consumed no-op) or
 * for a non-row key (the spatial engine's business).
 */
export function rowStep(key: string, dir: "left" | "right"): string | null {
  const row = rowOf(key);
  if (!row) return null;
  const i = row.indexOf(key as RowKey);
  const j = dir === "right" ? i + 1 : i - 1;
  if (j >= 0 && j < row.length) return row[j];
  const atRight = dir === "right";
  // icon row: the bar sits to the RIGHT of the row (live end = speed);
  // transport row: the bar sits to the LEFT of the row (live end = rewind)
  if (row === ICON_ROW) return atRight ? "scrub" : null;
  return atRight ? null : "scrub";
}
