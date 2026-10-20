/**
 * The player's Info panel content (pure — no DOM/webOS imports, testable in
 * node). The panel says ONLY what the title view cannot: a synopsis (the
 * centerpiece), a details row (rating · genres · air-date-or-runtime), and a
 * focusable actions row. It never repeats the series/episode title, and it
 * practices an honest fallback: missing data is OMITTED — no fake metadata,
 * no placeholder text, no empty row.
 *
 * airDate/runtime arrive PRE-FORMATTED from the async data layer ("May 12,
 * 2021", "2h 04m"); this module never formats dates — it only picks which
 * fields the episode vs. movie row shows.
 */

export interface UpNext {
  season: number;
  episode: number;
  title: string;
}

export interface PanelDetails {
  /** 0–10 scale; displayed with one decimal. */
  rating?: number | null;
  genres?: string[] | null;
  /** Pre-formatted, e.g. "May 12, 2021" — shown in the episode row only. */
  airDate?: string | null;
  /** Pre-formatted, e.g. "2h 04m" — shown in the movie row only. */
  runtime?: string | null;
}

export interface InfoPanelInput {
  kind: "episode" | "movie";
  synopsis?: string | null;
  details?: PanelDetails | null;
  /** Episode only; ignored for movies (defensive). */
  upNext?: UpNext | null;
  /** File chapters from the header probe; [] / null = no section at all. */
  chapters?: { start: number; title: string }[] | null;
}

export interface PanelAction {
  id: "restart" | "upnext";
  label: string;
}

export interface PanelChapter {
  /** "1:30" / "1:00:00" — pre-formatted via formatChapterTime. */
  time: string;
  /** "" when the file's chapter is unnamed — the row shows the time only. */
  title: string;
  /** Seek target (seconds). */
  start: number;
}

export interface InfoPanel {
  /** The centerpiece; null = the screen omits it. */
  synopsis: string | null;
  /** Details-row parts in display order; [] = omit the whole row. */
  details: string[];
  /** File chapters; [] = the file has none (the screen omits the section). */
  chapters: PanelChapter[];
  /** Always starts with the restart action. */
  actions: PanelAction[];
}

const RESTART_ACTION: PanelAction = { id: "restart", label: "Play from beginning" };

/** Trimmed passthrough; null / "" / whitespace-only → null (never a placeholder). */
function panelSynopsis(synopsis: string | null | undefined): string | null {
  const trimmed = (synopsis ?? "").trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * Chapter-row clock: "m:ss" under an hour, "h:mm:ss" at an hour or more.
 * The hour (and the minutes that follow it) are the only padded parts —
 * "1:30" for 90 s, "1:00:00" for 3600 s.
 */
export function formatChapterTime(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

/**
 * The details-row parts in display order, omitting empties:
 *   episode → [rating, genres, "Aired <airDate>"]
 *   movie   → [rating, genres, runtime]   (runtime never gets a prefix)
 * [] = the screen omits the whole row.
 */
function detailsRow(kind: InfoPanelInput["kind"], details: PanelDetails | null | undefined): string[] {
  if (!details) return [];
  const parts: string[] = [];
  if (details.rating != null) parts.push(details.rating.toFixed(1));
  if (details.genres && details.genres.length > 0) parts.push(details.genres.join(" · "));
  if (kind === "episode" && details.airDate) parts.push(`Aired ${details.airDate}`);
  if (kind === "movie" && details.runtime) parts.push(details.runtime);
  return parts;
}

/**
 * Always the restart action first. Episodes add "Up next · S{s} E{e} — <title>"
 * (unpadded) when a next episode with a non-empty title exists; movies get
 * restart only, ignoring upNext entirely (defensive).
 */
function panelActions(kind: InfoPanelInput["kind"], upNext: UpNext | null | undefined): PanelAction[] {
  const actions = [RESTART_ACTION];
  if (kind !== "episode" || !upNext || !upNext.title) return actions;
  actions.push({
    id: "upnext",
    label: `Up next · S${upNext.season} E${upNext.episode} — ${upNext.title}`,
  });
  return actions;
}

/**
 * File chapters → focusable rows. Absent / empty list = [] (the screen
 * omits the section — honest fallback, never a placeholder row). A blank
 * title keeps its chapter (time-only row), since the chapter itself is real.
 */
function panelChapters(list: { start: number; title: string }[] | null | undefined): PanelChapter[] {
  if (!list || list.length === 0) return [];
  return list.map((c) => ({
    time: formatChapterTime(c.start),
    title: (c.title ?? "").trim(),
    start: c.start,
  }));
}

export function buildInfoPanel(input: InfoPanelInput): InfoPanel {
  const { kind, synopsis, details, upNext, chapters } = input;
  return {
    synopsis: panelSynopsis(synopsis),
    details: detailsRow(kind, details),
    chapters: panelChapters(chapters),
    actions: panelActions(kind, upNext),
  };
}
