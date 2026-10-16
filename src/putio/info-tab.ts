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
}

export interface PanelAction {
  id: "restart" | "upnext";
  label: string;
}

export interface InfoPanel {
  /** The centerpiece; null = the screen omits it. */
  synopsis: string | null;
  /** Details-row parts in display order; [] = omit the whole row. */
  details: string[];
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

export function buildInfoPanel(input: InfoPanelInput): InfoPanel {
  const { kind, synopsis, details, upNext } = input;
  return {
    synopsis: panelSynopsis(synopsis),
    details: detailsRow(kind, details),
    actions: panelActions(kind, upNext),
  };
}
