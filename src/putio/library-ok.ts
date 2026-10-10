/**
 * What OK/press does on the Library screen — extracted as a pure decision so
 * both remotes share one contract (test/library-ok.test.mjs).
 *
 * A Magic-Remote pointer click already lands on the focused element's own
 * handler. The common 5-way remote's OK key must activate the SPATIALLY
 * FOCUSED control (header buttons, breadcrumbs, tiles) — not whatever tile
 * was selected last. (The old handler acted on `library.selected` for every
 * OK, so OK on the .acct header button did nothing, or replayed the last
 * file.)
 */
export type LibraryOkAction = "activate-focused" | "open-selected" | "none";

export function libraryOkAction(
  hasFocusedControl: boolean,
  hasSelectedItem: boolean
): LibraryOkAction {
  if (hasFocusedControl) return "activate-focused";
  if (hasSelectedItem) return "open-selected";
  return "none";
}
